import { keepDraft } from './drafts.mjs';
import { validateBackup } from '../backup.js';
import { openTaskStore } from './runtime/task-store.mjs';
import { startTaskSession } from './runtime/task-session.mjs';
import { legacyView, destinationId, orderId, taskData, changesBetween, preserve } from './adapter-model.mjs';
import { equal } from './runtime/task-model.mjs';
import { civilToday, summarizeEvents, displayTimeZone } from './runtime/recurrence.mjs';
const emergencyDrafts = new Map();

export async function openAdapter({ db, uid, generation, securityPaused = () => false, active, render, notify }) {
  const memoryKey = JSON.stringify([uid,generation]);
  const localDb = await openTaskStore();
  let ready = false, initialized = false, serial = Promise.resolve(), closed = false, lastState, sourceView, renderVersion = 0, rendered='';
  const guard = () => { if (closed || !active()) throw new Error('A sessão mudou.'); };
  async function preserveDraft(data) {
    try {
      await keepDraft(uid, { ...data, previousEmergencyDrafts: emergencyDrafts.get(memoryKey) ?? [] }, guard, generation);
      emergencyDrafts.delete(memoryKey);
    } catch (error) {
      const drafts = emergencyDrafts.get(memoryKey) ?? [];
      drafts.push(structuredClone(data));
      emergencyDrafts.set(memoryKey, drafts);
      throw new Error('Falha ao preservar no disco. O rascunho ficou nesta aba. Baixe os rascunhos antes de fechá-la. ' + error.message);
    }
  }
  async function refresh() {
    if (!ready || closed || !active()) return;
    if (initialized && emergencyDrafts.has(memoryKey)) return;
    if (document.querySelector('#modalEdicaoOverlay.show, #modalDescricaoOverlay.show, #modalReagendarOverlay.show, #modalPerfilOverlay.show, .inline-form.show')) return;
    const version = ++renderVersion;
    const state = await session.state();
    guard();
    if (version !== renderVersion || document.querySelector('#modalEdicaoOverlay.show, #modalDescricaoOverlay.show, #modalReagendarOverlay.show, #modalPerfilOverlay.show, .inline-form.show')) return;
    const view = await legacyView(state);
    guard();
    if (version !== renderVersion || document.querySelector('#modalEdicaoOverlay.show, #modalDescricaoOverlay.show, #modalReagendarOverlay.show, #modalPerfilOverlay.show, .inline-form.show')) return;
    lastState = state;
    sourceView = view;
    const events = state.tasks.filter(row => row.confirmed).map(row => ({ id: row.id, ...row.confirmed }));
    const displayZone = displayTimeZone(sourceView.profile.timeZone);
    const zone = displayZone.zone;
    const today = civilToday(zone);
    sourceView.counters = {
      total: summarizeEvents(events).confirmed.focusSeconds / 60,
      today: summarizeEvents(events.filter(row => row.data.date === today)).confirmed.focusSeconds / 60,
      reschedules: summarizeEvents(events.filter(row => row.data.date === today)).confirmed.reschedules,
      completionsToday: summarizeEvents(events.filter(row => row.data.date === today)).confirmed.completions
    };
    sourceView.sync=await session.status();
    sourceView.timeZoneProblem=displayZone.problem;
    for (const task of sourceView.tarefas) {
      const original = state.tasks.find(row => row.id === task.id)?.view.legacy?.original;
      task.tempoGastoLegado = original?.tempoGasto ?? null;
      task.tempoGasto = events.filter(row => row.kind === 'focus' && row.data.taskId === task.id)
        .reduce((sum, row) => sum + row.data.seconds, 0);
    }
    // A data civil muda a visibilidade mesmo sem novas gravações remotas.
    const signature=JSON.stringify({today,view:sourceView});
    if(signature===rendered)return;
    rendered=signature;render(structuredClone(sourceView));
    initialized = true;
  }
  const session = startTaskSession({ db, localDb, uid, generation, securityPaused,
    notify(message) { if (!closed && active()) { notify(message); void serial.then(refresh).catch(error => notify(error.message)); } }
  });
  async function update(id, kind, desired, observed) {
    guard();
    const state = await session.state();
    guard();
    const record = state.tasks.find(row => row.id === id);
    if (record && record.kind !== kind) throw new Error('Identificador já pertence a outro tipo. A versão foi preservada.');
    if (record?.confirmed?.deleted) throw new Error('Registro excluído exige restauração explícita.');
    const changes = record ? changesBetween(observed ?? record.view, desired) : desired;
    if (Object.keys(changes).length) await session.enqueue(id, changes, { kind, create: !record, observed });
    guard();
  }
  function save(input) {
    // Capture the rendered revision and data before another tab can replace the projection.
    const observedState = structuredClone(lastState);
    const observedView = structuredClone(sourceView);
    const desired = structuredClone(input);
    const action = async () => {
      guard();
      await preserveDraft({ observedState, observedView, desired });
      validateBackup(desired);
      const destinations = new Set();
      for (const [field, kind] of [['tarefas','task'],['metas','goal'],['cardsTarefas','space']]) {
        for (const row of desired[field]) {
          const id = await destinationId(kind, row);
          if (destinations.has(id)) throw new Error('Identificadores ambíguos. As versões foram preservadas em rascunho.');
          destinations.add(id);
        }
      }
      const base = observedState.tasks;
      const find = (id, kind) => base.find(row => row.id === id && row.kind === kind);
      for (const raw of desired.tarefas) {
        const before = observedView.tarefas.find(row => row.id === raw.id);
        const old = find(raw.id, 'task');
        if (old?.view.seriesId && !raw.recorrencia) throw new Error('Remover a série não faz parte da mudança de frequência. O rascunho foi preservado.');
        if (old?.view.seriesId && old.view.done && !equal({ ...before, ordem: raw.ordem, recorrencia: raw.recorrencia }, raw)) {
          throw new Error('Reabra a ocorrência antes de editar seu conteúdo. O histórico e o rascunho foram preservados.');
        }
      }
      const spaces = new Map();
      for (const [position, raw] of desired.cardsTarefas.entries()) {
        if (raw._virtual && !desired.tarefas.some(task => task._spaceId === raw.id
          && !observedView.tarefas.some(before => before.id === task.id && before._spaceId === raw.id))) continue;
        const id = await destinationId('space', raw);
        const old = find(id, 'space');
        spaces.set(raw.nome, [...(spaces.get(raw.nome) ?? []), id]);
        if (!old || !equal(raw, observedView.cardsTarefas.find(row => row.id === raw.id))) {
          await update(id, 'space', { name: raw.nome, legacy: preserve(raw, old?.view.legacy, 'interface', position) }, old?.view);
        }
      }
      const ids = new Set();
      const createdIds = new Map();
      for (const [position, raw] of desired.tarefas.entries()) {
        const id = await destinationId('task', raw);
        if (ids.has(id)) throw new Error('Há identificadores ambíguos. Nenhuma união automática foi realizada.');
        ids.add(id);
        const old = find(id, 'task'), before = observedView.tarefas.find(row => row.id === raw.id);
        if (equal(raw, before)) continue;
        const candidates = spaces.get(raw.bloco) ?? [];
        const spaceId = raw._spaceId && before?._spaceId === raw._spaceId && before.bloco === raw.bloco ? raw._spaceId
          : raw._spaceId && desired.cardsTarefas.some(space => space.id === raw._spaceId && space.nome === raw.bloco)
          ? raw._spaceId : candidates.length === 1 ? candidates[0] : null;
        if (candidates.length > 1 && !spaceId) throw new Error('Espaço ambíguo. Escolha a identidade do espaço.');
        const legacy = preserve(raw, old?.view.legacy, 'interface', position);
        if (old?.view.seriesId) {
          if (raw.recorrencia !== before.recorrencia) {
            const series = find(old.view.seriesId, 'series');
            const pending = find(series?.view.pendingId, 'task');
            if (!series?.confirmed || !pending?.view || pending.view.done) throw new Error('A série está sem ocorrência futura conferida. O rascunho foi preservado.');
            await session.changeFrequency(pending.id, raw.recorrencia, pending.view, series.confirmed);
            if (equal({ ...before, recorrencia: raw.recorrencia }, raw)) continue;
          }
          if (old.view.done) continue;
          const changes = changesBetween(old.view, { text: raw.texto, description: raw.descricao ?? '',
            priority: raw.prioridade || 'p2', spaceId, legacy });
          if (Object.keys(changes).length) await session.editOccurrence(id, changes, old.view);
          if (raw.data !== before.data) await session.reschedule(id, raw.data, undefined, { ...old.view, ...changes });
        } else if (!old && raw.recorrencia) {
          const created = await session.startSeries({ seriesId: id, date: raw.data, cadence: raw.recorrencia,
            changes: { text: raw.texto, description: raw.descricao ?? '', priority: raw.prioridade || 'p2', spaceId, legacy } });
          createdIds.set(raw.id, created.id);
        } else if (old && raw.recorrencia) {
          const data = taskData(raw, legacy, spaceId);
          await update(id, 'task', data, old.view);
          await session.convertSimple(id, raw.recorrencia, { ...old.view, ...data });
        } else {
          const data = taskData(raw, legacy, spaceId);
          if (old && raw.data && raw.data !== before?.data && !old.view.done && !data.done) {
            const unchangedDate = { ...data, date: old.view.date };
            await update(id, 'task', unchangedDate, old.view);
            await session.reschedule(id, raw.data, undefined, { ...old.view, ...unchangedDate });
          } else await update(id, 'task', data, old?.view);
        }
      }
      for (const before of observedView.tarefas) {
        if (!desired.tarefas.some(row => row.id === before.id)) {
          const old = find(before.id, 'task');
          if (old.view.seriesId) await session.cancelOccurrence(before.id, old.view);
          else await session.enqueue(before.id, {}, { remove: true, observed: old.view });
        }
      }
      for (const space of desired.cardsTarefas) {
        if (space._virtual && !desired.tarefas.some(task => task._spaceId === space.id || task._displaySpaceId === space.id)) continue;
        const id = await destinationId('space', space);
        const before = observedView.tarefas.filter(task => task._spaceId === id || (space._virtual && task._displaySpaceId===space.id)).sort((a, b) => a.ordem - b.ordem).map(task => task.id);
        const ordered = desired.tarefas.filter(task => task._spaceId === space.id || (space._virtual && task._displaySpaceId===space.id)
          || (task._spaceId == null && (spaces.get(task.bloco) ?? []).length === 1
            && spaces.get(task.bloco)[0] === id)).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
        const next = await Promise.all(ordered.map(row => createdIds.get(row.id) ?? destinationId('task', row)));
        const sequenceId = await orderId(id);
        if (!equal(before, next)) await update(sequenceId, 'order', { ids: next }, find(sequenceId, 'order')?.view);
      }
      for (const [position, raw] of desired.metas.entries()) {
        if (equal(raw, observedView.metas.find(row => row.id === raw.id))) continue;
        const id = await destinationId('goal', raw), old = find(id, 'goal');
        await update(id, 'goal', { text: raw.texto, done: raw.concluida ?? false,
          legacy: preserve(raw, old?.view.legacy, 'interface', position) }, old?.view);
      }
      for (const old of observedView.metas) {
        if (!desired.metas.some(row => row.id === old.id)) await session.enqueue(old.id, {},
          { kind: 'goal', remove: true, observed: find(old.id, 'goal').view });
      }
      for (const old of observedView.cardsTarefas) {
        const record = find(old.id, 'space');
        if (record && !desired.cardsTarefas.some(row => row.id === old.id)) {
          await session.enqueue(old.id, {}, { kind: 'space', remove: true, observed: record.view });
        }
      }
      guard();
      await refresh();
      void session.flush();
      return true;
    };
    const result = serial.then(action);
    serial = result.catch(error => { if (active()) notify(error.message); });
    return result;
  }
  ready = true;
  await refresh();
  if (emergencyDrafts.has(memoryKey)) notify('Há rascunhos em memória desta conta. Baixe-os antes de fechar a aba.');
  return {
    save,
    async renameSpace(id, name) {
      const observed=structuredClone(lastState.tasks.find(row=>row.id===id&&row.kind==='space')?.view);
      await serial;guard();
      if(!observed||!name.trim())throw new Error('Confira o espaço antes de renomear.');
      await preserveDraft({renameSpace:{id,name},observed});
      await update(id,'space',{name:name.trim()},observed);
      await refresh();void session.flush();
    },
    async removeSpace(id) {
      const observed=structuredClone(lastState.tasks.find(row=>row.id===id&&row.kind==='space')?.view);
      await serial;guard();if(!observed)throw new Error('Confira o espaço antes de excluir.');
      await preserveDraft({removeSpace:id,observed});
      await session.enqueue(id,{}, {kind:'space',remove:true,observed});
      await refresh();void session.flush();
    },
    async complete(id) {
      await serial;
      guard();
      if (emergencyDrafts.has(memoryKey)) throw new Error('Preserve o rascunho em memória antes de concluir a tarefa.');
      const row = lastState.tasks.find(item => item.id === id);
      await session.complete(id, undefined, row?.view);
      await refresh();
    },
    async reopen(id) {
      await serial;
      guard();
      const row = lastState.tasks.find(item => item.id === id);
      await preserveDraft({ reopen: id, observed: row?.view });
      await session.reopen(id, row?.view);
      await refresh();
    },
    async removeOccurrence(id, mode) {
      await serial;guard();
      const row=lastState.tasks.find(r=>r.id===id);
      await preserveDraft({removeOccurrence:{id,mode},observed:row?.view});
      if(mode==='skip')await session.skipOccurrence(id,row?.view);
      else if(mode==='end')await session.cancelOccurrence(id,row?.view);
      else throw new Error('Escolha pular a ocorrência ou encerrar a série.');
      await refresh();
    },
    async profile(raw) {
      const before = lastState.tasks.find(row => row.id === 'perfil');
      const merged = { ...sourceView.profile, ...raw };
      await preserveDraft({ profile: merged, observedState: lastState, observedView: sourceView });
      await update('perfil', 'profile', { name: merged.nome ?? '', avatar: merged.avatar ?? null,
        timeZone: merged.timeZone ?? 'America/Sao_Paulo', legacy: preserve(merged, before?.view.legacy, 'interface', 0) }, before?.view);
      await refresh();
    },
    async focus(id, seconds, taskId) {
      guard();
      await preserveDraft({ focus: { id, seconds, taskId }, observedState: lastState, observedView: sourceView });
      guard();
      await session.recordFocus(id, seconds, undefined, taskId);
      await refresh();
    },
    session,
    refresh,
    emergency() { guard(); return structuredClone(emergencyDrafts.get(memoryKey) ?? []); },
    close() { closed = true; session.close(); localDb.close(); }
  };
}

