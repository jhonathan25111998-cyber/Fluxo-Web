import {
  collection, doc, getDocFromServer, onSnapshot, query, runTransaction, serverTimestamp, where
} from 'firebase/firestore';
import { documentRefs, operationDigest } from '../operations.mjs';
import { applyToConfirmed, TaskConflict, equal } from './task-model.mjs';

function confirmed(snapshot) {
  if (!snapshot.exists()) return null;
  const { kind, revision, deleted, data } = snapshot.data();
  return { kind, revision, deleted, data };
}

export async function readTask(db, uid, generation, id) {
  return confirmed(await getDocFromServer(doc(db, 'fluxoSync', uid, 'geracoes', generation, 'registros', id)));
}

export function listenTasks(db, uid, generation, receive, fail) {
  const records = collection(db, 'fluxoSync', uid, 'geracoes', generation, 'registros');
  const supported = query(records, where('kind', 'in', ['task', 'goal', 'profile', 'series', 'focus', 'completion', 'completionReversal', 'reschedule', 'space', 'order', 'archive']));
  return onSnapshot(supported, { includeMetadataChanges: true }, snapshot => {
    if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
    // Include all confirmed rows on a cache-to-server transition.
    receive(snapshot.docs.map(item => ({ id: item.id, remote: confirmed(item) })));
  }, fail);
}

export async function sendTask(db, op, guard) {
  const kind = op.kind ?? 'task';
  const { record, receipt } = documentRefs(db, op.uid, op.generation, op.id, op.opId);
  const digest = await operationDigest({
    id: op.id, action: op.action, baseRevision: op.baseRevision, before: op.before, changes: op.changes,
    ...(op.resolves === undefined ? {} : { resolves: op.resolves }),
    ...(op.references?.length ? { references: op.references } : {}),
    ...(kind === 'task' ? {} : { kind })
  });
  function replay(saved, remote) {
    if (saved.data().digest !== digest || saved.data().recordId !== op.id) {
      throw new TaskConflict('O ID já foi confirmado com outra intenção.', remote);
    }
    return { remote, replayed: true };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let observedRevision;
    guard();
    try {
      return await runTransaction(db, async tx => {
        guard();
        const saved = await tx.get(receipt);
        guard();
        const remote = confirmed(await tx.get(record));
        guard();
        if (saved.exists()) return replay(saved, remote);
        for (const reference of op.references ?? []) {
          const observed = confirmed(await tx.get(doc(db, 'fluxoSync', op.uid, 'geracoes', op.generation, 'registros', reference.id)));
          guard();
          if (!equal(observed, reference.remote)) throw new TaskConflict('O espaço mudou depois da conferência. Revise o vínculo.', remote);
        }
        observedRevision = remote?.revision ?? 0;
        const data = applyToConfirmed(op, remote);
        const next = { kind, revision: observedRevision + 1,
          deleted: ['delete', 'keepDeleted'].includes(op.action), data };
        tx.set(record, { ...next, lastOpId: op.opId, updatedAt: serverTimestamp() });
        tx.set(receipt, { recordId: op.id, revision: next.revision, action: op.action, digest,
          committedAt: serverTimestamp() });
        return { remote: next, replayed: false };
      });
    } catch (error) {
      guard();
      if (error.code !== 'permission-denied') throw error;
      // Emulator rules can reject a race before the SDK retries the transaction.
      const [saved, current] = await Promise.allSettled([getDocFromServer(receipt), getDocFromServer(record)]);
      guard();
      const remote = current.status === 'fulfilled' ? confirmed(current.value) : null;
      if (saved.status === 'fulfilled' && saved.value.exists()) return replay(saved.value, remote);
      if (observedRevision !== undefined && current.status === 'fulfilled'
        && (remote?.revision ?? 0) !== observedRevision) {
        applyToConfirmed(op, remote);
        continue;
      }
      throw error;
    }
  }
  throw Object.assign(new Error('Concorrência temporária. A operação continua na fila.'), { code: 'aborted' });
}

