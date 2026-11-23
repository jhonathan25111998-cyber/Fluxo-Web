import { accountStorage } from '../../account-storage.js';
import { buildBackup, recoveryBlocked } from '../../backup.js';
import { readRevision } from '../../local-state.js';
import { scopedTaskStore } from './task-store.mjs';
import { TaskConflict, equal } from './task-model.mjs';
import { listenTasks, readTask, sendTask } from './task-remote.mjs';
import { firstOccurrence, sendCommand } from './recurrence-remote.mjs';
import { civilToday, summarizeEvents, validTimeZone } from './recurrence.mjs';
import { isLocalDate } from '../monthly.mjs';
import { operationDigest } from '../operations.mjs';
import { DATA_ENABLED, ACTIVATION_MESSAGE } from '../deployment-policy.mjs';

function activeCompletion(state, id) {
  const events = state.tasks.filter(row => row.confirmed && !row.confirmed.deleted);
  const reversed = new Set(events.filter(row => row.kind === 'completionReversal').map(row => row.confirmed.data.completionId));
  const candidates = events.filter(row => row.kind === 'completion' && row.confirmed.data.taskId === id && !reversed.has(row.id));
  const explicit = state.tasks.find(row => row.id === id)?.view?.completionEventId;
  if (explicit) return explicit;
  if (candidates.length > 1) throw new Error('Há conclusões antigas ambíguas. Preserve as versões e confira o histórico antes de reabrir.');
  return candidates[0]?.id ?? null;
}

export function pauseReason(storage, securityPaused) {
  if (storage.getItem('fluxoRestorationPauseV6') !== null) return 'Restauração por registro aguardando liberação.';
  if (recoveryBlocked(storage)) return 'Restauração protegida.';
  if (storage.getItem('fluxoLocalConflictV2') !== null) return 'Conflito local protegido.';
  if (storage.getItem('fluxoEnvioPendente') !== null) return 'Envio legado pendente de conciliação.';
  if (storage.getItem('fluxoSyncSecurityPause') !== null || securityPaused()) return 'Bloqueio de segurança.';
  try {
    readRevision(storage);
    buildBackup(storage);
  } catch {
    return 'Dados locais inválidos preservados.';
  }
  if (!navigator.locks) return 'O navegador não oferece exclusão mútua entre abas.';
  return null;
}

export function startTaskSession({ db, localDb, uid, generation, securityPaused = () => false,
  auto = true, notify = () => {}, afterCommit = () => {} }) {
  if (!DATA_ENABLED) throw new Error(ACTIVATION_MESSAGE);
  const controller = new AbortController();
  const { signal } = controller;
  const guard = () => signal.throwIfAborted();
  const storage = accountStorage(localStorage, uid);
  const store = scopedTaskStore(localDb, uid, generation);
  const lock = 'fluxo-sync-v3:' + JSON.stringify([uid, generation]);
  const channel = new BroadcastChannel(lock);
  let running, timer, dirty = false, listeningFailed = false, serverConfirmed = false, retry = 0;
  const report = message => { if (!signal.aborted) notify(message); };
  function guardSend() {
    guard();
    const reason = pauseReason(storage, securityPaused);
    if (reason) throw Object.assign(new Error(reason), { code: 'paused' });
    if (!navigator.onLine) throw Object.assign(new Error('Sem conexão.'), { code: 'unavailable' });
  }
  function guardDecision() {
    guard();
    const reason = pauseReason({ getItem: key => key === 'fluxoRestorationPauseV6' ? null : storage.getItem(key) }, securityPaused);
    if (reason) throw Object.assign(new Error(reason), { code: 'paused' });
    if (!navigator.onLine) throw Object.assign(new Error('Sem conexão.'), { code: 'unavailable' });
  }
  function wake(delay = 0) {
    if (!auto || signal.aborted) return;
    if (running) { dirty = true; return; }
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  }
  const unsubscribe = listenTasks(db, uid, generation, entries => {
    if (signal.aborted) return;
    store.acceptRemote(entries, guard).then(() => {
      if (signal.aborted) return;
      serverConfirmed = true;
      report('Base confirmada atualizada.');
      wake();
    }).catch(error => report(error.message));
  }, error => {
    listeningFailed = true;
    report('Leitura remota interrompida: ' + error.message);
  });

  async function drain() {
    while (true) {
      guardSend();
      const { operations } = await store.state();
      guardSend();
      const decision = operations.find(op => op.resolves !== undefined && op.status === 'pending');
      if (listeningFailed || (!decision && operations.some(op => ['conflict', 'rejected'].includes(op.status)))) {
        report('Envio pausado. As versões estão preservadas.');
        return;
      }
      const op = decision ?? operations.find(entry => entry.status === 'pending');
      if (!op) return;
      try {
        const result = await (op.command ? sendCommand : sendTask)(db, op, guardSend);
        guard();
        await afterCommit(op, result);
        guard();
        await store.finish(op, { status: 'confirmed', remote: result.remote, related: result.related }, guard);
        channel.postMessage('confirmed');
        retry = 0;
        report(decision ? 'Conflito resolvido e confirmado.' :
          result.replayed ? 'Recibo confirmado em reenvio.' : 'Alteração confirmada.');
      } catch (error) {
        if (signal.aborted) return;
        const conflict = error instanceof TaskConflict;
        if (!conflict && !(error instanceof RangeError)
          && !['permission-denied', 'invalid-argument', 'failed-precondition'].includes(error.code)) throw error;
        await store.finish(op, {
          status: conflict ? 'conflict' : 'rejected', remote: error.remote,
          problem: { message: error.message, remote: error.remote ?? null }
        }, guard);
        channel.postMessage('conflict');
        report(decision ? 'Decisão não aplicada. Confira a versão atual da tarefa.' :
          'Envio pausado. A operação recusada foi preservada.');
        return;
      }
    }
  }
  function flush() {
    if (signal.aborted) return Promise.resolve();
    if (running) return running;
    let retryDelay = null;
    running = Promise.resolve().then(() => {
      guardSend();
      return navigator.locks.request(lock, { signal }, drain);
    }).catch(error => {
      report(error.message);
      if (['unavailable', 'aborted', 'deadline-exceeded', 'resource-exhausted', 'cancelled', 'unknown', 'internal'].includes(error.code)
        && navigator.onLine) retryDelay = Math.min(30000, 500 * 2 ** Math.min(retry++, 6));
    }).finally(() => {
      running = undefined;
      const again = dirty;
      dirty = false;
      if (retryDelay !== null) wake(retryDelay);
      else if (again) wake();
    });
    return running;
  }
  const onWake = () => { report('Alterações locais atualizadas.'); wake(); };
  const onStorage = event => { if (event.key?.startsWith(storage.prefix)) wake(); };
  channel.addEventListener('message', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener('storage', onStorage);
  async function queue(command, id, args, observed) {
    guard();
    const op = await store.enqueueCommand(command, id, args, guard, observed);
    guard();
    channel.postMessage('queued');
    wake();
    return op;
  }
  async function timeZone() {
    const { tasks } = await store.state();
    guard();
    return validTimeZone(tasks.find(row => row.id === 'perfil')?.view?.timeZone ?? 'America/Sao_Paulo');
  }
  wake();
  return {
    state: store.state,
    async status() {
      const state=await store.state();guard();
      return {online:navigator.onLine,paused:pauseReason(storage,securityPaused),listeningFailed,serverConfirmed,
        pending:state.operations.filter(o=>o.status==='pending').length,
        conflicts:state.operations.filter(o=>['conflict','rejected','resolutionFailed'].includes(o.status)).length};
    },
    async enqueue(id, changes, options) {
      guard();
      const op = await store.enqueue(id, changes, { ...options, guard });
      guard();
      channel.postMessage('queued');
      wake();
      return op;
    },
    async startSeries(input) {
      const args = firstOccurrence({ ...input, timeZone: await timeZone() });
      return queue('startSeries', args.id, args);
    },
    async complete(id, now = new Date(), observed) {
      const zone = await timeZone();
      const { tasks } = await store.state();
      guard();
      const task = tasks.find(row => row.id === id);
      return queue(task?.view?.reopened ? 'completeReopened' : task?.view?.seriesId ? 'completeSeries' : 'completeSimple', id,
        { completedOn: civilToday(zone, now), timeZone: zone }, observed);
    },
    async reschedule(id, date, now = new Date(), observed) {
      if (!isLocalDate(date)) throw new RangeError('Informe uma data válida.');
      const zone = await timeZone();
      const { tasks } = await store.state();
      guard();
      const task = tasks.find(row => row.id === id);
      return queue(task?.view?.seriesId ? 'rescheduleOccurrence' : 'rescheduleSimple', id,
        { date, on: civilToday(zone, now), timeZone: zone }, observed);
    },
    editOccurrence: (id, changes, observed) => queue('editOccurrence', id, { changes }, observed),
    cancelOccurrence: (id, observed) => queue('cancelOccurrence', id, {}, observed),
    async skipOccurrence(id, observed, now=new Date()) {
      return queue('skipOccurrence',id,{on:civilToday(await timeZone(),now),timeZone:await timeZone()},observed);
    },
    async convertSimple(id, cadence, observed) {
      const seriesId = 'serie_' + (await operationDigest({ uid, generation, id })).slice(0, 40);
      const state = await store.state();
      guard();
      const completionId = state.tasks.find(row => row.id === id)?.view?.done ? activeCompletion(state, id) : null;
      return queue('convertSimple', id, { seriesId, cadence, timeZone: await timeZone(), completionId }, observed);
    },
    async changeFrequency(id, cadence, observed, seriesBefore) {
      return queue('changeFrequency', id, { cadence, seriesBefore }, observed);
    },
    async reopen(id, observed) {
      const state = await store.state();
      guard();
      const task = state.tasks.find(row => row.id === id);
      if (!task?.view?.seriesId) return queue('reopenSimple',id,{on:civilToday(await timeZone()),completionId:activeCompletion(state,id)},observed);
      const seriesBefore = state.tasks.find(row => row.id === task?.view.seriesId)?.confirmed;
      if (!seriesBefore) throw new Error('Confira a série antes de reabrir.');
      return queue('reopenOccurrence', id, { on: civilToday(await timeZone()), completionId: activeCompletion(state, id), seriesBefore }, observed);
    },
    async recordFocus(id, seconds, now = new Date(), taskId = null) {
      if (!/^focus_[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
        throw new RangeError('Evento de foco inválido.');
      }
      const zone = await timeZone();
      return queue('focus', id, { seconds, date: civilToday(zone, now), timeZone: zone, taskId });
    },
    async totals(historical) {
      const { tasks } = await store.state();
      guard();
      return summarizeEvents(tasks.filter(row => row.confirmed).map(row => ({ id: row.id, ...row.confirmed })), historical);
    },
    async review(sequence) {
      guard();
      const { operations } = await store.state();
      const op = operations.find(item => item.sequence === sequence && item.status === 'conflict');
      if (!op) throw new Error('O conflito já não está pendente.');
      guard();
      const remote = await readTask(db, uid, generation, op.id);
      guard();
      const reviewedReferences = [];
      for (const reference of op.references ?? []) {
        const current = await readTask(db, uid, generation, reference.id);
        guard();
        reviewedReferences.push({ id: reference.id, remote: current });
      }
      return { op: { ...op, reviewedReferences }, remote };
    },
    async resolve(sequence, reviewedRemote, desired, interrupt, references = [], choice) {
      guardDecision();
      const source = (await store.state()).operations.find(op => op.sequence === sequence);
      guardDecision();
      if (source?.command==='reopenSimple' && !reviewedRemote.deleted && reviewedRemote.data.done && !desired.deleted && !desired.data.done) {
        const {done,completedOn,...kept}=desired.data;
        const {done:remoteDone,completedOn:remoteDate,...remoteKept}=reviewedRemote.data;
        if (!equal(kept,remoteKept)) throw new Error('Para reabrir, mantenha os outros campos remotos; edite o conteúdo depois. As versões continuam preservadas.');
        const op=await store.queueSeriesResolution(sequence,{id:source.id,source,task:reviewedRemote},'reopenSimple',
          {...source.args,completionId:reviewedRemote.data.completionEventId??activeCompletion(await store.state(),source.id)},guardDecision);
        channel.postMessage('decision');wake();return op;
      }
      if (source?.command === 'convertSimple' && (choice !== 'remote' || reviewedRemote.data.seriesId)) {
        const review = { id: source.id, source, task: reviewedRemote };
        let command = 'convertSimple', args = source.args;
        if (reviewedRemote.data.seriesId) {
          if (choice !== 'remote') throw new Error('A tarefa já foi convertida. Mantenha a série confirmada e revise sua frequência separadamente.');
          const remote = await readTask(db, uid, generation, reviewedRemote.data.seriesId);
          review.series = { id: reviewedRemote.data.seriesId, remote };
          review.successor = remote?.data.pendingId ? { id: remote.data.pendingId, remote: await readTask(db, uid, generation, remote.data.pendingId) } : null;
          command = 'acceptSeries'; args = {};
        }
        const op = await store.queueSeriesResolution(sequence, review, command, args, guardDecision);
        channel.postMessage('decision'); wake(); return op;
      }
      if (source?.command === 'completeSimple' && !reviewedRemote.deleted && !reviewedRemote.data.done && !desired.deleted && desired.data.done) {
        const changes = Object.fromEntries(Object.entries(desired.data)
          .filter(([key]) => ['text','description','date','priority','spaceId','legacy'].includes(key)));
        const op = await store.queueSeriesResolution(sequence, { id: source.id, source, task: reviewedRemote },
          'completeSimple', { ...source.args, changes }, guardDecision);
        channel.postMessage('decision');
        wake();
        return op;
      }
      if (source?.command === 'rescheduleSimple' && !reviewedRemote.deleted && !reviewedRemote.data.done
        && !desired.deleted && !desired.data.done && desired.data.date !== reviewedRemote.data.date) {
        const changes = Object.fromEntries(Object.entries(desired.data)
          .filter(([key]) => ['text','description','priority','spaceId','legacy'].includes(key)));
        const op = await store.queueSeriesResolution(sequence, { id: source.id, source, task: reviewedRemote },
          'rescheduleSimple', { ...source.args, date: desired.data.date, changes }, guardDecision);
        channel.postMessage('decision');
        wake();
        return op;
      }
      const required = (source?.references ?? []).filter(reference => reference.id === desired.data?.spaceId && !desired.deleted);
      if (required.some(reference => !references.some(current => current.id === reference.id
        && current.remote?.kind === 'space' && !current.remote.deleted))) throw new Error('Confira um espaço ativo na prévia antes de aplicar a versão do arquivo.');
      const verified = references.filter(reference => reference.id === desired.data?.spaceId && !desired.deleted);
      const op = await store.queueResolution(sequence, reviewedRemote, desired, guardDecision, interrupt, verified);
      guard();
      channel.postMessage('decision');
      wake();
      return op;
    },
    async queueRestoration(entries, digest) {
      guard();
      const ops = await store.queueRestoration(entries, digest, guard);
      guard();
      channel.postMessage('restoration');
      wake();
      return ops;
    },
    async archiveRestoration(sequence) {
      guard();
      const source = (await store.state()).operations.find(op => op.sequence === sequence && op.restoration);
      if (!source) throw new Error('Tentativa não encontrada.');
      const remote = await readTask(db, uid, generation, source.id);
      guard();
      await store.archiveRestoration(sequence, remote, guard);
      guard();
      channel.postMessage('archived');
    },
    async reviewSeries(sequence) {
      guard();
      const source = (await store.state()).operations.find(op => op.sequence === sequence && op.command && op.status === 'conflict');
      if (!source) throw new Error('Conflito recorrente não encontrado.');
      const task = await readTask(db, uid, generation, source.id);
      guard();
      if (!task?.data.seriesId) throw new Error('A ocorrência remota não está disponível.');
      const series = await readTask(db, uid, generation, task.data.seriesId);
      guard();
      if (!series) throw new Error('Série remota não encontrada.');
      const successorId = series.data.pendingId;
      const successor = successorId ? await readTask(db, uid, generation, successorId) : null;
      guard();
      return { id: source.id, source, task, series: { id: task.data.seriesId, remote: series },
        successor: successor ? { id: successorId, remote: successor } : null };
    },
    async resolveSeries(sequence, review, choice, date) {
      guardDecision();
      let command = choice === 'remote' ? 'acceptSeries' : review.source.command;
      let args = structuredClone(review.source.args);
      if (choice === 'date') {
        if (!isLocalDate(date)) throw new Error('Informe uma data válida.');
        command = 'rescheduleOccurrence';
        args = { date, on: civilToday(await timeZone()), timeZone: await timeZone() };
      }
      if (!['remote', 'local', 'date'].includes(choice)) throw new Error('Escolha uma decisão.');
      const lifecycle = ['changeFrequency','reopenOccurrence','completeReopened'].includes(command);
      if (command !== 'acceptSeries' && (review.task.deleted || (command === 'reopenOccurrence' ? !review.task.data.done
        : review.task.data.done || (!review.task.data.reopened && review.series.remote.data.pendingId !== review.id)))) throw new Error('A ocorrência mudou. Preserve a versão remota e confira a edição arquivada.');
      if (lifecycle) args.seriesBefore = review.series.remote;
      if (command === 'reopenOccurrence') args.completionId = review.task.data.completionEventId ?? activeCompletion(await store.state(), review.id);
      if (command === 'rescheduleOccurrence' && args.date === review.task.data.date) command = 'acceptSeries';
      const op = await store.queueSeriesResolution(sequence, review, command, args, guardDecision);
      channel.postMessage('decision');
      wake();
      return op;
    },
    async readRecord(id) {
      guard();
      const remote = await readTask(db, uid, generation, id);
      guard();
      return remote;
    },
    flush,
    close() {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      channel.close();
      window.removeEventListener('online', onWake);
      window.removeEventListener('storage', onStorage);
    }
  };
}


