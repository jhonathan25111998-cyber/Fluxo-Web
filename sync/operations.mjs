import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import { isLocalDate } from './monthly.mjs';

export const newOperationId = () => globalThis.crypto.randomUUID();

export function documentRefs(db, uid, generation, id, operationId) {
  const base = ['fluxoSync', uid, 'geracoes', generation];
  return {
    record: doc(db, ...base, 'registros', id),
    receipt: doc(db, ...base, 'operacoes', operationId)
  };
}

function canonical(value) {
  if (value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('A operação precisa conter valores JSON válidos.');
}

export async function operationDigest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function confirmedReceipt(snapshot, digest) {
  if (snapshot.data().digest !== digest) throw new Error('ID de operação reutilizado com conteúdo diferente.');
  return { revision: snapshot.data().revision, replayed: true };
}

// Reference implementation used by the emulator suite. The app does not import it.
export async function commitOperation(db, { uid, generation, id, opId, expectedRevision, action, kind, data = null }) {
  if (!['create', 'update', 'delete', 'restore'].includes(action)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('Operação ou revisão inválida.');
  }
  if (data?.date != null && !isLocalDate(data.date)) throw new RangeError('Data local inválida.');
  const { record, receipt } = documentRefs(db, uid, generation, id, opId);
  const digest = await operationDigest({ id, expectedRevision, action, kind, data });
  const commit = () => runTransaction(db, async transaction => {
    const existingReceipt = await transaction.get(receipt);
    if (existingReceipt.exists()) return confirmedReceipt(existingReceipt, digest);
    const snapshot = await transaction.get(record);
    const previous = snapshot.exists() ? snapshot.data() : null;
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('Conflito de revisão.');
    if ((action === 'create') !== !previous || (previous && previous.kind !== kind)
      || (previous && previous.deleted !== (action === 'restore'))) {
      throw new Error('Transição de estado inválida.');
    }
    const revision = expectedRevision + 1;
    transaction.set(record, {
      kind, revision, deleted: action === 'delete',
      data: ['delete', 'restore'].includes(action) ? previous.data : data,
      lastOpId: opId, updatedAt: serverTimestamp()
    });
    transaction.set(receipt, { recordId: id, revision, action, digest, committedAt: serverTimestamp() });
    return { revision, replayed: false };
  });
  try {
    return await commit();
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    // The rules may reject a concurrent commit before the SDK retries it.
    // Inspect server state without retrying the write or masking unrelated denials.
    const [receiptResult, recordResult] = await Promise.allSettled([
      getDocFromServer(receipt), getDocFromServer(record)
    ]);
    if (receiptResult.status === 'fulfilled' && receiptResult.value.exists()) {
      return confirmedReceipt(receiptResult.value, digest);
    }
    if (recordResult.status === 'fulfilled'
      && (recordResult.value.data()?.revision ?? 0) !== expectedRevision) {
      throw new Error('Conflito de revisão.', { cause: error });
    }
    throw error;
  }
}
