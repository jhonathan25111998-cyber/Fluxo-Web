import { equal, blankFor, fieldsFor, resolutionIntent, validateChanges } from './task-model.mjs';

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function openTaskStore() {
  const open = indexedDB.open('FluxoSyncFase2', 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('records', { keyPath: ['uid', 'generation', 'id'] })
      .createIndex('scope', ['uid', 'generation']);
    const operations = open.result.createObjectStore('operations', { keyPath: 'sequence', autoIncrement: true });
    operations.createIndex('scope', ['uid', 'generation']);
    operations.createIndex('opId', 'opId', { unique: true });
  };
  const db = await request(open);
  db.onversionchange = () => db.close();
  return db;
}

function pending(op) {
  return op.resolves === undefined && ['pending', 'conflict', 'rejected'].includes(op.status);
}

export function project(record, operations) {
  let view = record.confirmed?.deleted ? null : record.confirmed?.data ?? null;
  const explicitRestoration = operations.some(op => op.id === record.id && op.restoration && pending(op)
    && op.reviewedRemote?.deleted && op.baseRevision === record.confirmed?.revision
    && equal(op.reviewedRemote, record.confirmed));
  if (record.confirmed?.deleted && !explicitRestoration) return { ...record, view };
  for (const op of operations) {
    if (op.id === record.id && pending(op)) {
      if (op.command && op.status !== 'pending') continue;
      if (op.action === 'delete') {
        if (op.status === 'pending') view = null;
        continue;
      }
      if (op.kind !== 'focus') view = { ...(view ?? op.localBefore ?? blankFor(op.kind ?? 'task')), ...op.changes };
    }
  }
  return { ...record, view };
}

export function scopedTaskStore(db, uid, generation) {
  const scope = [uid, generation];
  async function transact(mode, work) {
    const tx = db.transaction(['records', 'operations'], mode,
      mode === 'readwrite' ? { durability: 'strict' } : {});
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Transação local interrompida.'));
      tx.onerror = () => reject(tx.error);
    });
    // Observe abort even when a request rejects before we await transaction completion.
    done.catch(() => {});
    try {
      const result = await work(tx.objectStore('records'), tx.objectStore('operations'), tx);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* already ended */ }
      await done.catch(() => {});
      throw error;
    }
  }
  const ops = store => request(store.index('scope').getAll(scope));
  const key = id => [...scope, id];
  return {
    state: () => transact('readonly', async (records, operations) => ({
      tasks: await request(records.index('scope').getAll(scope)),
      operations: await ops(operations)
    })),
    enqueue(id, changes, { kind = 'task', create = false, remove = false, observed, guard = () => {}, interrupt } = {}) {
      if (!remove) validateChanges(changes, kind);
      if (create && remove) throw new TypeError('Ação inválida.');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || (create && ['task','goal'].includes(kind) && !changes.text)
        || (kind === 'profile' && id !== 'perfil')) throw new TypeError('Registro inválido.');
      return transact('readwrite', async (records, operations, tx) => {
        guard();
        const record = await request(records.get(key(id)));
        if (create ? !!record : !record?.view || record.confirmed?.data.seriesId
          || (record.kind ?? record.confirmed?.kind ?? 'task') !== kind) {
          throw new Error('Tarefa inexistente, repetida ou recorrente.');
        }
        const localBefore = observed ?? record?.view ?? null;
        const fields = remove ? fieldsFor(kind) : Object.keys(changes);
        const before = Object.fromEntries(fields.map(field => [field, localBefore?.[field] ?? null]));
        const stale = !create && observed && fields.some(field =>
          !equal(record.view[field] ?? null, before[field]) && (remove || !equal(record.view[field], changes[field])));
        const op = {
          uid, generation, id, kind, opId: crypto.randomUUID(), action: create ? 'create' : remove ? 'delete' : 'update',
          baseRevision: record?.confirmed?.revision ?? 0, before, localBefore,
          changes: structuredClone(changes), status: stale ? 'conflict' : 'pending',
          createdAt: new Date().toISOString()
        };
        if (stale) {
          op.problem = { message: 'Outra aba alterou o mesmo campo.', remote: record.confirmed, local: record.view };
        }
        guard();
        const sequence = await request(operations.add(op));
        await request(records.put({
          uid, generation, id, kind, confirmed: record?.confirmed ?? null,
          view: remove ? (stale ? record.view : null) : { ...(record?.view ?? blankFor(kind)), ...changes }
        }));
        guard();
        interrupt?.(tx);
        return { ...op, sequence };
      });
    },
    enqueueCommand(command, id, args, guard, observed) {
      return transact('readwrite', async (records, operations) => {
        const record = await request(records.get(key(id)));
        guard();
        if (command === 'focus' && record) {
          const prior = (await ops(operations)).find(op => op.id === id && op.command === 'focus');
          if (prior?.args.seconds === args.seconds && prior.args.date === args.date
            && (prior.args.taskId ?? null) === (args.taskId ?? null)) return prior;
          if (record.confirmed?.kind === 'focus' && record.confirmed.data.seconds === args.seconds
            && record.confirmed.data.date === args.date
            && (record.confirmed.data.taskId ?? null) === (args.taskId ?? null)) return null;
          if ((record.kind ?? record.confirmed?.kind) !== 'focus') {
            throw new Error('Este identificador já tem outra versão registrada neste dispositivo.');
          }
          // Keep a new attempt with divergent data so the server can preserve it as a conflict.
        }
        const creating = ['startSeries', 'focus'].includes(command);
        const available = record?.view && (record.kind ?? 'task') === 'task'
          && (['reopenOccurrence','reopenSimple'].includes(command) ? record.view.done && (command==='reopenSimple' ? record.view.seriesId===null : !!record.view.seriesId)
            : command === 'convertSimple' ? record.view.seriesId === null
            : !record.view.done && (['completeSimple', 'rescheduleSimple'].includes(command) ? record.view.seriesId === null : !!record.view.seriesId));
        if (creating ? (command !== 'focus' && !!record) : !available) {
          throw new Error('A ocorrência não está pendente ou o identificador já existe.');
        }
        const changes = command === 'startSeries' ? args.task : command === 'editOccurrence' ? args.changes
          : ['completeSeries', 'completeSimple', 'completeReopened'].includes(command) ? { done: true }
          : command === 'convertSimple' ? { seriesId: args.seriesId, ordinal: 1 }
          : command === 'reopenOccurrence' ? { done: false, completedOn: null, reopened: true, cycle: (record.view.cycle ?? 0) + 1 }
          : command === 'reopenSimple' ? {done:false,completedOn:null}
          : ['rescheduleOccurrence', 'rescheduleSimple'].includes(command) ? { date: args.date } : {};
        const kind = command === 'focus' ? 'focus' : 'task';
        const localBefore = observed ?? record?.view ?? null;
        const stale = !creating && observed
          && Object.keys(record.view).some(field => !equal(observed[field], record.view[field]));
        const op = {
          uid, generation, id, kind, command, args: structuredClone(args), opId: crypto.randomUUID(),
          action: ['cancelOccurrence','skipOccurrence'].includes(command) ? 'delete' : creating ? 'create' : 'update',
          baseRevision: record?.confirmed?.revision ?? 0, before: localBefore,
          localBefore, changes, status: stale ? 'conflict' : 'pending', createdAt: new Date().toISOString()
        };
        if (stale) op.problem = { message: 'A ocorrência mudou antes de a ação entrar na fila.',
          remote: record.confirmed, local: record.view };
        const sequence = await request(operations.add(op));
        if (!stale) {
          await request(records.put({
            uid, generation, id, kind, confirmed: record?.confirmed ?? null,
            view: ['focus','cancelOccurrence','skipOccurrence'].includes(command) ? null : { ...record?.view, ...changes }
          }));
        }
        guard();
        return { ...op, sequence };
      });
    },
    queueResolution(sequence, reviewedRemote, desired, guard, interrupt, references = []) {
      const intent = resolutionIntent(reviewedRemote, desired);
      return transact('readwrite', async (records, operations, tx) => {
        const source = await request(operations.get(sequence));
        guard();
        if (!source || source.uid !== uid || source.generation !== generation || source.status !== 'conflict') {
          throw new Error('Este conflito já foi resolvido ou não pertence à sessão.');
        }
        const all = await ops(operations);
        if (all.some(op => op.resolves === sequence && op.status === 'pending')) {
          throw new Error('Já existe uma decisão aguardando confirmação.');
        }
        const record = await request(records.get(key(source.id)));
        if (record.confirmed?.revision > reviewedRemote.revision) {
          throw new Error('A tarefa mudou depois da sua conferência. Revise a versão atual.');
        }
        const op = {
          uid, generation, id: source.id, kind: reviewedRemote.kind, opId: crypto.randomUUID(), resolves: sequence,
          baseRevision: reviewedRemote.revision, before: reviewedRemote.data,
          references,
          localBefore: source.localBefore, reviewedRemote, ...intent,
          status: 'pending', createdAt: new Date().toISOString()
        };
        guard();
        const seq = await request(operations.add(op));
        guard();
        interrupt?.(tx);
        return { ...op, sequence: seq };
      });
    },
    queueSeriesResolution(sequence, review, command, args, guard) {
      return transact('readwrite', async (records, operations) => {
        const source = await request(operations.get(sequence));
        guard();
        if (!source || source.uid !== uid || source.generation !== generation || source.status !== 'conflict'
          || !source.command || !review.task || source.id !== review.id
          || (!review.task.data.seriesId && !['completeSimple', 'reopenSimple', 'rescheduleSimple', 'convertSimple'].includes(source.command))) throw new Error('Revisão inválida.');
        const all = await ops(operations);
        if (all.some(op => op.resolves === sequence && op.status === 'pending')) throw new Error('Já existe uma decisão pendente.');
        for (const snapshot of [{ id: review.id, remote: review.task }, review.series, review.successor].filter(Boolean)) {
          const latest = await request(records.get(key(snapshot.id)));
          if ((latest?.confirmed?.revision ?? 0) > snapshot.remote.revision) throw new Error('A série mudou. Confira novamente.');
        }
        const op = {
          uid, generation, id: review.id, kind: 'task', command, args, review, resolves: sequence,
          opId: crypto.randomUUID(), action: 'update', baseRevision: review.task.revision,
          before: review.task.data, localBefore: review.task.data, changes: {},
          status: 'pending', createdAt: new Date().toISOString()
        };
        guard();
        const next = await request(operations.add(op));
        return { ...op, sequence: next };
      });
    },
    queueRestoration(entries, digest, guard) {
      for (const entry of entries) {
        validateChanges(entry.data, entry.kind);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) || !['task','goal','profile','space','order'].includes(entry.kind)
          || entry.kind === 'profile' && entry.id !== 'perfil'
          || entry.remote?.kind && entry.remote.kind !== entry.kind
          || entry.kind === 'task' && entry.remote?.data.seriesId) throw new Error('Destino de restauração inválido.');
        if (entry.references?.some(reference => !/^[A-Za-z0-9_-]{1,128}$/.test(reference.id)
          || reference.remote?.kind !== 'space' || reference.remote.deleted)) throw new Error('Espaço de destino inválido.');
      }
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Destinos ambíguos na restauração.');
      return transact('readwrite', async (records, operations) => {
        const all = await ops(operations);
        const queued = [];
        for (const entry of entries) {
          guard();
          if (all.some(op => op.id === entry.id && ['pending', 'conflict', 'rejected'].includes(op.status))) {
            throw new Error('Há alterações pendentes neste registro. Confira as versões antes de restaurar.');
          }
          const record = await request(records.get(key(entry.id)));
          if ((record?.confirmed?.revision ?? 0) > (entry.remote?.revision ?? 0)) throw new Error('A versão local confirmada mudou. Confira novamente.');
          if (record?.confirmed && !entry.remote) throw new Error('O registro local precisa de conferência remota.');
          const data = { ...(entry.remote?.data ?? blankFor(entry.kind)), ...entry.data };
          const op = {
            uid, generation, id: entry.id, kind: entry.kind, restoration: true, sourceDigest: digest,
            reviewedRemote: entry.remote, references: entry.references ?? [],
            opId: crypto.randomUUID(), baseRevision: entry.remote?.revision ?? 0,
            before: entry.remote?.data ?? null, localBefore: entry.remote?.data ?? null,
            action: !entry.remote ? 'create' : entry.remote.deleted
              ? equal(entry.remote.data, data) ? 'restore' : 'restoreEdit' : 'update',
            changes: entry.data, status: 'pending', createdAt: new Date().toISOString()
          };
          const sequence = await request(operations.add(op));
          await request(records.put({ uid, generation, id: entry.id, kind: entry.kind,
            confirmed: entry.remote, view: data }));
          queued.push({ ...op, sequence });
        }
        guard();
        return queued;
      });
    },
    archiveRestoration(sequence, remote, guard) {
      return transact('readwrite', async (records, operations) => {
        const source = await request(operations.get(sequence));
        guard();
        if (!source || source.uid !== uid || source.generation !== generation || !source.restoration
          || !['conflict','rejected'].includes(source.status)) throw new Error('A tentativa já mudou. Confira novamente.');
        const all = await ops(operations);
        if (all.some(op => op.resolves === sequence && op.status === 'pending')) throw new Error('Já há uma decisão aguardando confirmação.');
        await request(operations.put({ ...source, status: 'archived', archivedRemote: remote }));
        const current = await request(records.get(key(source.id)));
        if (remote && (current.confirmed?.revision ?? 0) <= remote.revision) current.confirmed = remote;
        await request(records.put(project(current, await ops(operations))));
        guard();
      });
    },
    acceptRemote(entries, guard) {
      return transact('readwrite', async (records, operations) => {
        const all = await ops(operations);
        for (const { id, remote } of entries) {
          const current = await request(records.get(key(id)));
          guard();
          if ((current?.confirmed?.revision ?? 0) > remote.revision) continue;
          await request(records.put(project({ uid, generation, id, kind: remote.kind, confirmed: remote }, all)));
        }
        guard();
      });
    },
    finish(op, { status, remote, problem, related = [] }, guard) {
      return transact('readwrite', async (records, operations) => {
        const existing = await request(operations.get(op.sequence));
        guard();
        if (!existing || existing.uid !== uid || existing.generation !== generation || existing.opId !== op.opId) {
          throw new Error('Operação fora da sessão.');
        }
        if (existing.status === 'confirmed') return;
        const resolving = existing.resolves !== undefined;
        const finalStatus = resolving && status !== 'confirmed' ? 'resolutionFailed' : status;
        await request(operations.put({ ...existing, status: finalStatus, problem: problem ?? null }));
        if (resolving && status === 'confirmed') {
          const source = await request(operations.get(existing.resolves));
          guard();
          if (!source || source.uid !== uid || source.generation !== generation || source.status !== 'conflict') {
            throw new Error('O conflito original não está disponível.');
          }
          await request(operations.put({ ...source, status: 'resolved', resolutionOpId: op.opId }));
        }
        const all = await ops(operations);
        const record = await request(records.get(key(op.id)));
        guard();
        if (remote && (record.confirmed?.revision ?? 0) <= remote.revision) record.confirmed = remote;
        await request(records.put(project(record, all)));
        for (const item of related) {
          const prior = await request(records.get(key(item.id)));
          guard();
          if ((prior?.confirmed?.revision ?? 0) <= item.remote.revision) {
            await request(records.put(project({
              uid, generation, id: item.id, kind: item.remote.kind, confirmed: item.remote
            }, all)));
          }
        }
        guard();
      });
    }
  };
}

