import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import { documentRefs, operationDigest } from '../operations.mjs';
import { isLocalDate } from '../monthly.mjs';
import { cadenceOf, nextOccurrence, occurrenceId, validTimeZone, canonicalTimeZone } from './recurrence.mjs';
import { equal, TaskConflict, blankTask, validateChanges } from './task-model.mjs';

function confirmed(snapshot) {
  if (!snapshot.exists()) return null;
  const { kind, revision, deleted, data } = snapshot.data();
  return { kind, revision, deleted, data };
}
const same = equal;
const first = (kind, data) => ({ kind, revision: 1, deleted: false, data });
const changed = (record, data, deleted = false) => ({ ...record, revision: record.revision + 1, deleted, data });

export function firstOccurrence({ seriesId, cadence, date, timeZone, changes, anchorDay }) {
  if (!isLocalDate(date)) throw new RangeError('Informe a data inicial.');
  validateChanges(changes);
  if (!changes.text) throw new Error('Informe o título da tarefa recorrente.');
  const anchor = anchorDay ?? Number(date.slice(8, 10));
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new RangeError('Referência mensal inválida.');
  const id = occurrenceId(seriesId, 1);
  return {
    id, seriesId,
    task: { ...blankTask, ...changes, date, seriesId, ordinal: 1, done: false },
    series: { cadence: cadenceOf(cadence), anchorDay: anchor, anchorWeekday: new Date(date+'T00:00:00Z').getUTCDay(), timeZone: canonicalTimeZone(timeZone), pendingId: id, ordinal: 1 }
  };
}

export async function sendCommand(db, op, guard) {
  const { record, receipt } = documentRefs(db, op.uid, op.generation, op.id, op.opId);
  const ref = id => doc(db, 'fluxoSync', op.uid, 'geracoes', op.generation, 'registros', id);
  const digest = await operationDigest({ id: op.id, command: op.command, baseRevision: op.baseRevision,
    before: op.before, args: op.args, ...(op.review ? { review: op.review } : {}) });
  const replay = (saved, remote) => {
    if (saved.data().digest !== digest || saved.data().recordId !== op.id) {
      throw new TaskConflict('Identificador de operação já usado para outra ação.', remote);
    }
    return { remote, replayed: true };
  };
  let observedRevision;
  const commit = () => runTransaction(db, async tx => {
    guard();
    const saved = await tx.get(receipt);
    guard();
    const old = confirmed(await tx.get(record));
    guard();
    if (saved.exists()) return replay(saved, old);
    let reviewedSeries, reviewedSuccessor;
    if (op.review) {
      if (!equal(old, op.review.task)) throw new TaskConflict('A ocorrência mudou depois da revisão.', old);
      if (op.review.series) {
        reviewedSeries = confirmed(await tx.get(ref(op.review.series.id)));
        guard();
        if (!equal(reviewedSeries, op.review.series.remote)) throw new TaskConflict('A série mudou depois da revisão.', old);
      }
      if (op.review.successor) {
        reviewedSuccessor = confirmed(await tx.get(ref(op.review.successor.id)));
        guard();
        if (!equal(reviewedSuccessor, op.review.successor.remote)) throw new TaskConflict('O sucessor mudou depois da revisão.', old);
      }
    }
    observedRevision = old?.revision ?? 0;
    async function programmedNext(seriesId, data, scheduled, completedOn) {
      if (data.cadence !== 'weekly' || data.anchorWeekday !== undefined) return nextOccurrence(data, scheduled, completedOn);
      // Séries antigas conservam o modelo; a referência é lida, nunca migrada silenciosamente.
      const origin = confirmed(await tx.get(ref(data.originId ?? occurrenceId(seriesId, 1))));
      const date = origin?.data.legacy?.original?.data ?? origin?.data.date;
      if (!isLocalDate(date)) throw new TaskConflict('Referência semanal original indisponível. Confira a série.', old);
      return nextOccurrence({...data,anchorWeekday:new Date(date+'T00:00:00Z').getUTCDay()},scheduled,completedOn);
    }
    let next, related = [], links;
    if (op.command === 'acceptSeries') {
      if (!op.review || !old?.data.seriesId || !reviewedSeries) throw new TaskConflict('Confira a série antes de decidir.', old);
      next = { ...old, revision: old.revision + 1 };
      links = { seriesId: old.data.seriesId, successorId: null, eventId: null,
        reviewRevision: old.revision, seriesRevision: reviewedSeries.revision,
        successorRevision: reviewedSuccessor?.revision ?? null };
    } else if (['convertSimple', 'changeFrequency', 'reopenOccurrence', 'completeReopened'].includes(op.command)) {
      if (!old || old.kind !== 'task' || old.deleted || !same(old.data, op.localBefore) || old.revision < op.baseRevision) {
        throw new TaskConflict('A tarefa mudou. Confira as versões antes desta ação.', old);
      }
      if (op.command === 'convertSimple') {
        if (old.data.seriesId !== null || !isLocalDate(old.data.date)) throw new TaskConflict('Confira a tarefa e sua data antes de converter.', old);
        const { seriesId } = op.args;
        occurrenceId(seriesId, 1);
        if ((await tx.get(ref(seriesId))).exists()) throw new TaskConflict('A série já existe. A tarefa foi preservada.', old);
        const series = { cadence: cadenceOf(op.args.cadence), anchorDay: Number(old.data.date.slice(8)), anchorWeekday: new Date(old.data.date+'T00:00:00Z').getUTCDay(),
          timeZone: validTimeZone(op.args.timeZone), originId: op.id, pendingId: op.id, ordinal: 1 };
        const completionId = op.args.completionId ?? null;
        if (completionId) {
          if (old.data.completionEventId && old.data.completionEventId !== completionId) throw new TaskConflict('O evento original de conclusão deve ser preservado.', old);
          const event = confirmed(await tx.get(ref(completionId)));
          if (!old.data.done || event?.kind !== 'completion' || event.data.taskId !== op.id) throw new TaskConflict('A conclusão anterior precisa de conferência.', old);
        }
        next = changed(old, { ...old.data, seriesId, ordinal: 1, ...(completionId ? { completionEventId: completionId } : {}) });
        links = { seriesId, successorId: null, eventId: null };
        if (old.data.done) {
          const successorId = occurrenceId(seriesId, 2);
          if ((await tx.get(ref(successorId))).exists()) throw new TaskConflict('Já existe outra versão do sucessor.', old);
          const { completionEventId, cycle, reopened, ...data } = old.data;
          related.push({ id: successorId, remote: first('task', { ...data, seriesId, ordinal: 2, done: false, completedOn: null,
            date: nextOccurrence(series, old.data.date, old.data.completedOn ?? old.data.date) }) });
          series.pendingId = successorId; series.ordinal = 2; links.successorId = successorId;
        }
        related.push({ id: seriesId, remote: first('series', series) });
      } else {
        if (!old.data.seriesId) throw new TaskConflict('A tarefa não pertence a uma série.', old);
        const seriesId = old.data.seriesId;
        const series = confirmed(await tx.get(ref(seriesId)));
        if (!series || series.deleted || series.kind !== 'series') throw new TaskConflict('A série não está disponível.', old);
        if (op.args.seriesBefore && !same(series, op.args.seriesBefore)) throw new TaskConflict('A série mudou depois da conferência.', old);
        links = { seriesId, successorId: null, eventId: null, seriesRevision: series.revision };
        if (op.command === 'changeFrequency') {
          if (old.data.done || series.data.pendingId !== op.id || series.data.ordinal !== old.data.ordinal) throw new TaskConflict('Confira a ocorrência futura atual.', old);
          const cadence = cadenceOf(op.args.cadence);
          next = changed(old, old.data);
          related = [{ id: seriesId, remote: changed(series, { ...series.data, cadence,
            initialCadence: series.data.initialCadence ?? series.data.cadence,
            scheduleHistory: [...(series.data.scheduleHistory ?? []), { fromOrdinal: old.data.ordinal, cadence }] }) }];
        } else if (op.command === 'reopenOccurrence') {
          if (!old.data.done || !isLocalDate(op.args.on)) throw new TaskConflict('Esta ocorrência já não está concluída.', old);
          const completionId = op.args.completionId ?? old.data.completionEventId ?? 'done_' + op.id;
          const event = confirmed(await tx.get(ref(completionId)));
          if (event) {
            if (event.kind !== 'completion' || event.deleted || event.data.taskId !== op.id
              || (old.data.completionEventId && old.data.completionEventId !== completionId)) throw new TaskConflict('A conclusão diverge. Confira o histórico.', old);
            const eventId = 'undo_' + completionId;
            if ((await tx.get(ref(eventId))).exists()) throw new TaskConflict('Esta conclusão já foi corrigida.', old);
            links.eventId = eventId;
            related = [{ id: eventId, remote: first('completionReversal', { taskId: op.id, date: event.data.date,
              completionId, reopenedOn: op.args.on }) }];
          } else if (old.data.completionEventId || op.args.completionId) throw new TaskConflict('O evento de conclusão não foi encontrado.', old);
          next = changed(old, { ...old.data, done: false, completedOn: null, reopened: true, cycle: (old.data.cycle ?? 0) + 1 });
        } else {
          if (!old.data.reopened) throw new TaskConflict('A ocorrência não foi reaberta.', old);
          if (old.data.done) return { remote: old, replayed: true };
          validTimeZone(op.args.timeZone);
          if (!isLocalDate(op.args.completedOn)) throw new RangeError('Data de conclusão inválida.');
          const eventId = op.opId;
          if ((await tx.get(ref(eventId))).exists()) throw new TaskConflict('A conclusão deste ciclo já existe.', old);
          links.eventId = eventId;
          next = changed(old, { ...old.data, done: true, completedOn: op.args.completedOn, completionEventId: eventId });
          related = [{ id: eventId, remote: first('completion', { taskId: op.id, date: op.args.completedOn }) }];
        }
      }
    } else if (op.command === 'reopenSimple') {
      if (!old || old.kind !== 'task' || old.deleted || old.data.seriesId !== null || !old.data.done
        || old.revision < op.baseRevision || !same(old.data,op.localBefore)) throw new TaskConflict('A tarefa mudou antes da reabertura.',old);
      if (!isLocalDate(op.args.on)) throw new RangeError('Data de reabertura inválida.');
      const completionId=op.args.completionId ?? old.data.completionEventId;
      if (!completionId) throw new TaskConflict('A conclusão antiga não possui evento seguro. Preserve o histórico para revisão.',old);
      const event=confirmed(await tx.get(ref(completionId))),eventId='undo_'+completionId;
      if (!event || event.kind!=='completion' || event.deleted || event.data.taskId!==op.id
        || (old.data.completionEventId && old.data.completionEventId!==completionId)
        || (await tx.get(ref(eventId))).exists()) throw new TaskConflict('A conclusão já mudou. Confira o histórico.',old);
      next=changed(old,{...old.data,done:false,completedOn:null});
      links={seriesId:null,successorId:null,eventId};
      related=[{id:eventId,remote:first('completionReversal',{taskId:op.id,date:event.data.date,completionId,reopenedOn:op.args.on})}];
    } else if (op.command === 'focus') {
      const { date, seconds, timeZone, taskId = null } = op.args;
      validTimeZone(timeZone);
      if (!isLocalDate(date) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
        throw new RangeError('Sessão de foco inválida.');
      }
      if (taskId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new RangeError('Tarefa de foco inválida.');
      const data = taskId ? { date, seconds, taskId } : { date, seconds };
      if (old) {
        if (old.kind === 'focus' && !old.deleted && same(old.data, data)) return { remote: old, replayed: true };
        throw new TaskConflict('Este evento de foco já tem outro conteúdo.', old);
      }
      next = first('focus', data);
    } else if (op.command === 'startSeries') {
      const { seriesId, task, series } = op.args;
      if (old || (await tx.get(ref(seriesId))).exists()) throw new TaskConflict('A série já existe.', old);
      guard();
      next = first('task', task);
      related = [{ id: seriesId, remote: first('series', series) }];
      links = { seriesId, successorId: null, eventId: null };
    } else if (op.command === 'rescheduleSimple') {
      if (!old || old.kind !== 'task' || old.data.seriesId !== null || old.deleted || old.data.done) {
        throw new TaskConflict('A tarefa não está mais pendente.', old);
      }
      if (!same(old.data, op.localBefore) || old.revision < op.baseRevision) {
        throw new TaskConflict('A tarefa mudou antes do reagendamento.', old);
      }
      validTimeZone(op.args.timeZone);
      if (!isLocalDate(op.args.date) || !isLocalDate(op.args.on)) throw new RangeError('Data de reagendamento inválida.');
      if (old.data.date === op.args.date) return { remote: old, replayed: true };
      const edits = op.args.changes ?? {};
      if (Object.keys(edits).length) validateChanges(edits);
      if (Object.keys(edits).some(key => !['text','description','priority','spaceId','legacy'].includes(key))) {
        throw new RangeError('Campos inválidos para o reagendamento.');
      }
      next = changed(old, { ...old.data, ...edits, date: op.args.date });
      links = { seriesId: null, successorId: null, eventId: op.opId };
      related = [{ id: op.opId, remote: first('reschedule', { taskId: op.id, date: op.args.on }) }];
    } else if (op.command === 'completeSimple') {
      if (!old || old.kind !== 'task' || old.data.seriesId !== null || old.deleted) {
        throw new TaskConflict('A tarefa foi excluída ou mudou de tipo.', old);
      }
      if (old.data.done) return { remote: old, replayed: true };
      if (!same(old.data, op.localBefore) || old.revision < op.baseRevision) {
        throw new TaskConflict('A tarefa mudou antes da conclusão.', old);
      }
      validTimeZone(op.args.timeZone);
      if (!isLocalDate(op.args.completedOn)) throw new RangeError('Data de conclusão inválida.');
      const edits = op.args.changes ?? {};
      if (Object.keys(edits).length) {
        validateChanges(edits);
        if (Object.keys(edits).some(key => !['text','description','date','priority','spaceId','legacy'].includes(key))) throw new RangeError('Campos inválidos para a conclusão.');
      }
      next = changed(old, { ...old.data, ...edits, done: true, completedOn: op.args.completedOn, completionEventId: op.opId });
      links = { seriesId: null, successorId: null, eventId: op.opId };
      related = [{ id: op.opId, remote: first('completion', { taskId: op.id, date: op.args.completedOn }) }];
    } else {
      if (!old || old.kind !== 'task' || !old.data.seriesId) throw new TaskConflict('Ocorrência não encontrada.', old);
      if (old.deleted) {
        if (op.command === 'cancelOccurrence') return { remote: old, replayed: true };
        throw new TaskConflict('A ocorrência foi excluída antes desta ação.', old);
      }
      if (old.data.done) {
        if (op.command === 'completeSeries' && (await tx.get(ref(old.data.completionEventId ?? 'done_' + op.id))).exists()) {
          guard();
          return { remote: old, replayed: true };
        }
        throw new TaskConflict('A ocorrência já foi concluída.', old);
      }
      if (op.command === 'rescheduleOccurrence' && old.data.date === op.args.date) return { remote: old, replayed: true };
      if (!same(old.data, op.localBefore) || old.revision < op.baseRevision) {
        throw new TaskConflict('A ocorrência mudou. Confira as versões antes de repetir a ação.', old);
      }
      const seriesId = old.data.seriesId;
      const series = confirmed(await tx.get(ref(seriesId)));
      guard();
      if (!series || series.kind !== 'series' || series.deleted || (!old.data.reopened && (series.data.pendingId !== op.id
        || series.data.ordinal !== old.data.ordinal))) throw new TaskConflict('A série não aponta para esta ocorrência.', old);
      links = { seriesId, successorId: null, eventId: null };
      if (old.data.reopened && op.command === 'completeSeries') throw new TaskConflict('Use a conclusão da ocorrência reaberta.', old);
      if (op.command === 'completeSeries' || op.command === 'skipOccurrence') {
        if (op.command==='skipOccurrence' && old.data.reopened) throw new TaskConflict('Uma ocorrência reaberta não avança a série. Escolha encerrá-la.',old);
        const ordinal = old.data.ordinal + 1;
        const successorId = occurrenceId(seriesId, ordinal);
        const eventId = op.command==='skipOccurrence' ? null : op.id === occurrenceId(seriesId, old.data.ordinal) ? 'done_' + op.id : op.opId;
        if ((await tx.get(ref(successorId))).exists() || (eventId && (await tx.get(ref(eventId))).exists())) {
          throw new TaskConflict('O sucessor ou o evento já existe. Confira a série.', old);
        }
        validTimeZone(op.args.timeZone);
        const date = await programmedNext(seriesId,series.data, old.data.date, op.command==='skipOccurrence'?(op.args.on<old.data.date?old.data.date:op.args.on):op.args.completedOn);
        const { completionEventId, reopened, cycle, ...successorData } = old.data;
        next = op.command==='skipOccurrence' ? changed(old,old.data,true) : changed(old, { ...old.data, done: true, completedOn: op.args.completedOn, completionEventId: eventId });
        links = { seriesId, successorId, eventId };
        related = [
          { id: seriesId, remote: changed(series, { ...series.data, pendingId: successorId, ordinal }) },
          { id: successorId, remote: first('task', { ...successorData, date, ordinal, done: false, completedOn: null }) },
          ...(eventId ? [{ id: eventId, remote: first('completion', { taskId: op.id, date: op.args.completedOn }) }] : [])
        ];
      } else if (op.command === 'editOccurrence') {
        validateChanges(op.args.changes);
        if (Object.keys(op.args.changes).some(key => !['text','description','priority','spaceId','legacy'].includes(key))) {
          throw new RangeError('Use a ação específica para mudar data, conclusão ou frequência.');
        }
        next = changed(old, { ...old.data, ...op.args.changes });
      } else if (op.command === 'rescheduleOccurrence') {
        validTimeZone(op.args.timeZone);
        if (!isLocalDate(op.args.date) || !isLocalDate(op.args.on)) throw new RangeError('Data de reagendamento inválida.');
        next = changed(old, { ...old.data, date: op.args.date });
        links.eventId = op.opId;
        related = [{ id: op.opId, remote: first('reschedule', { taskId: op.id, date: op.args.on }) }];
      } else if (op.command === 'cancelOccurrence') {
        next = changed(old, old.data, true);
        related = old.data.reopened ? [] : [{ id: seriesId, remote: changed(series, { ...series.data, pendingId: null }) }];
      } else throw new Error('Comando desconhecido.');
    }
    guard();
    for (const item of [{ id: op.id, remote: next }, ...related]) {
      tx.set(ref(item.id), { ...item.remote, lastOpId: op.opId, updatedAt: serverTimestamp() });
    }
    tx.set(receipt, { recordId: op.id, revision: next.revision,
      action: op.command === 'focus' ? 'create' : op.command, digest, committedAt: serverTimestamp(), ...links });
    return { remote: next, related, replayed: false };
  });
  guard();
  try {
    return await commit();
  } catch (error) {
    guard();
    if (error.code !== 'permission-denied') throw error;
    const [saved, current] = await Promise.allSettled([getDocFromServer(receipt), getDocFromServer(record)]);
    guard();
    const remote = current.status === 'fulfilled' ? confirmed(current.value) : null;
    if (saved.status === 'fulfilled' && saved.value.exists()) return replay(saved.value, remote);
    if (current.status === 'fulfilled' && observedRevision !== undefined && (remote?.revision ?? 0) !== observedRevision) {
      return commit();
    }
    throw error;
  }
}


