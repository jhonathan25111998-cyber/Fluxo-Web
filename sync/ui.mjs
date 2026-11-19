import { validateBackup } from '../backup.js';
import { accountStorage } from '../account-storage.js';
import { blankFor, fieldsFor } from './runtime/task-model.mjs';

import { summarizeEvents, canonicalTimeZone, displayTimeZone } from './runtime/recurrence.mjs';
import { orderedTasks, orderId } from './adapter-model.mjs';

const labels = {
  completedOn: 'Dia da conclusão', legacy: 'Dados legados preservados', ids: 'Ordem compartilhada', source: 'Fonte arquivada', name: 'Nome', avatar: 'Endereço da foto', timeZone: 'Fuso horário IANA (ex.: America/Sao_Paulo)',
  text: 'Título', description: 'Descrição', date: 'Data', spaceId: 'Espaço',
  priority: 'Prioridade', done: 'Concluída'
};
const priorities = { p1: 'Alta', p2: 'Média', p3: 'Baixa' };
const $ = id => document.getElementById(id);
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, callback) {
  const el = element('button', text);
  el.type = 'button';
  el.addEventListener('click', callback);
  return el;
}
function notice(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function display(field, value) {
  if (field === 'done') return value ? 'Sim' : 'Não';
  if (field === 'priority') return priorities[value] ?? '—';
  return value && typeof value === 'object' ? JSON.stringify(value) : value || '—';
}
function formFields(container, values, kind) {
  container.replaceChildren();
  for (const field of fieldsFor(kind).filter(field => field !== 'legacy')) {
    const label = element('label', labels[field]);
    const input = element(field === 'description' ? 'textarea' : field === 'priority' ? 'select' : 'input');
    input.name = field;
    if (field === 'priority') {
      for (const [value, title] of Object.entries(priorities)) input.add(new Option(title, value));
    } else if (field === 'done') {
      input.type = 'checkbox';
      input.checked = values[field];
    } else if (['date', 'completedOn'].includes(field)) input.type = 'date';
    if (field !== 'done') input.value = values[field] ?? '';
    if (field === 'text') { input.required = true; input.maxLength = 500; }
    if (field === 'description') input.maxLength = 20000;
    if (field === 'spaceId') input.maxLength = 128;
    label.append(input);
    container.append(label);
  }
}
function readFields(container, kind) {
  return Object.fromEntries(fieldsFor(kind).filter(field => field !== 'legacy').map(field => {
    const input = container.querySelector('[name="' + field + '"]');
    const value = field === 'done' ? input.checked
      : ['date', 'completedOn', 'spaceId', 'avatar'].includes(field) ? input.value || null : input.value;
    return [field, value];
  }));
}
function versionCard(title, version, kind) {
  const card = element('article');
  card.append(element('h3', title));
  if (!version?.data) {
    card.append(element('p', 'O registro ainda não existia.'));
    return card;
  }
  card.append(element('p', version.deleted ? 'Excluída' : 'Ativa', 'badge'));
  const details = element('dl');
  for (const field of fieldsFor(kind)) {
    details.append(element('dt', labels[field]), element('dd', display(field, version.data[field])));
  }
  card.append(details);
  return card;
}

export function mountLabUI({ session, identity }) {
  let edited, reviewed, recurring, renderVersion = 0, reviewVersion = 0, backupVersion = 0;
  const decision = $('decision');
  function ensureActive(current) {
    if (!current || current !== session()) throw new Error('A sessão mudou.');
  }
  async function act(work, errorTarget = 'notice') {
    const current = session();
    notice(errorTarget);
    try { ensureActive(current); await work(current); }
    catch (error) { if (current === session()) notice(errorTarget, error.message); }
  }
  function send(current) {
    if (current === session()) {
      void render();
      void current.flush();
    }
  }
  function editRecord(current, id, kind, task) {
    edited = { current, id, kind, task };
    $('editor-title').textContent = { task: 'Editar tarefa', goal: 'Editar meta', profile: 'Editar perfil' }[kind];
    formFields($('edit-fields'), { ...blankFor(kind), ...task?.view }, kind);
    $('editor').showModal();
  }
  async function render() {
    const current = session(), version = ++renderVersion;
    $('workspace').hidden = !current;
    $('logout').hidden = !current;
    if (!current) return;
    let state;
    try { state = await current.state(); }
    catch (error) { if (current === session()) notice('notice', error.message); return; }
    if (current !== session() || version !== renderVersion) return;
    const rows = state.tasks.filter(task => task.view && (task.kind ?? 'task') === 'task');
    const spaces = state.tasks.filter(row => row.kind === 'space' && row.view);
    const orderKeys = new Map(await Promise.all(spaces.map(async space => [space.id, await orderId(space.id)])));
    if (current !== session() || version !== renderVersion) return;
    $('shared-order').replaceChildren();
    for (const space of spaces) {
      const sequenceId = orderKeys.get(space.id);
      const record = state.tasks.find(row => row.id === sequenceId && row.kind === 'order');
      const tasks = orderedTasks(rows.filter(row => row.view.spaceId === space.id), record?.view?.ids);
      const section = element('article', undefined, 'row');
      section.dataset.space = space.id;
      section.append(element('h3', space.view.name));
      tasks.forEach((task, index) => {
        const line = element('p', task.view.text);
        const move = direction => void act(async active => {
          const ids = tasks.map(row => row.id);
          const target = index + direction;
          if (target < 0 || target >= ids.length) return;
          [ids[index], ids[target]] = [ids[target], ids[index]];
          await active.enqueue(sequenceId, { ids },
            { kind: 'order', create: !record, observed: record?.view });
          send(active);
        });
        line.append(button('Subir ' + task.view.text, () => move(-1)),
          button('Descer ' + task.view.text, () => move(1)));
        section.append(line);
      });
      $('shared-order').append(section);
    }
    $('tasks').replaceChildren(...rows.map(task => {
      const row = element('article', undefined, 'row');
      row.dataset.task = task.id;
      const actions = element('div', undefined, 'actions');
      if (task.view.seriesId) {
        const date = element('input');
        date.type = 'date';
        date.value = task.view.date;
        date.setAttribute('aria-label', 'Nova data de ' + task.view.text);
        if (!task.view.done) {
          actions.append(button('Concluir ocorrência', () => void act(async active => {
            await active.complete(task.id, undefined, task.view);
            send(active);
          })), date, button('Reagendar', () => void act(async active => {
            await active.reschedule(task.id, date.value, undefined, task.view);
            send(active);
          })), button('Pular ocorrência', () => void act(async active => {
            if (!confirm('Pular somente esta ocorrência? A próxima data válida será criada e a série continuará.')) return;
            await active.skipOccurrence(task.id,task.view);send(active);
          })), button('Encerrar série', () => void act(async active => {
            if (!confirm('Encerrar a série? A ocorrência ficará guardada para recuperação.')) return;
            await active.cancelOccurrence(task.id, task.view);
            send(active);
          })));
        }
      } else actions.append(button('Editar', () => editRecord(current, task.id, 'task', task)),
        button('Excluir', () => void act(async active => {
          if (!confirm('Excluir esta tarefa? O conteúdo será guardado para recuperação.')) return;
          await active.enqueue(task.id, {}, { remove: true, observed: task.view });
          send(active);
        })));
      if (!task.view.seriesId && !task.view.done) actions.append(button('Concluir tarefa', () => void act(async active => {
        await active.complete(task.id, undefined, task.view);
        send(active);
      })));
      row.append(element('h3', task.view.text));
      if (task.view.seriesId) row.append(element('p', task.view.date + (task.view.done ? ' · Concluída' : ' · Recorrente')));
      row.append(actions);
      return row;
    }));
    if (!rows.length) $('tasks').append(element('p', 'Nenhuma tarefa ativa.'));
    $('goals').replaceChildren(...state.tasks.filter(row => row.kind === 'goal' && row.view).map(goal => {
      const row = element('article', undefined, 'row');
      row.append(element('h3', goal.view.text), element('p', goal.view.done ? 'Concluída' : 'Em andamento'),
        button('Editar meta', () => editRecord(current, goal.id, 'goal', goal)));
      return row;
    }));
    const profile = state.tasks.find(row => row.id === 'perfil' && row.kind === 'profile' && row.view);
    $('profile-summary').textContent = (profile?.view.name || 'Sem nome') + ' · '
      + (profile?.view.timeZone ?? blankFor('profile').timeZone);
    const zoneProblem=displayTimeZone(profile?.view.timeZone).problem;
    if(zoneProblem)$('profile-summary').textContent+=' · '+zoneProblem;
    $('edit-profile').onclick = () => editRecord(current, 'perfil', 'profile', profile);
    const { confirmed } = summarizeEvents(state.tasks.filter(row => row.confirmed)
      .map(row => ({ id: row.id, ...row.confirmed })));
    $('totals').textContent = Math.floor(confirmed.focusSeconds / 60) + ' min e '
      + confirmed.focusSeconds % 60 + ' s de foco · ' + confirmed.completions + ' conclusões · '
      + confirmed.reschedules + ' reagendamentos confirmados';
    const conflicts = state.operations.filter(op => ['conflict', 'resolved', 'rejected', 'archived'].includes(op.status));
    $('conflicts').replaceChildren(...conflicts.map(op => {
      const row = element('article', undefined, 'row');
      row.dataset.conflict = op.sequence;
      const waiting = state.operations.some(item => item.resolves === op.sequence && item.status === 'pending');
      const lastFailure = state.operations.filter(item => item.resolves === op.sequence && item.status === 'resolutionFailed').at(-1);
      const label = op.status === 'archived' ? 'Tentativa arquivada; conteúdo preservado' : op.status === 'resolved' ? 'Resolvido e confirmado' : waiting
        ? 'Decisão pendente de confirmação' : op.status === 'rejected' ? 'Envio recusado · versão guardada' : 'Conflito pendente';
      row.append(element('h3', op.localBefore?.text ?? op.localBefore?.name ?? op.changes?.text ?? op.id), element('p', label, 'badge'));
      if (lastFailure && op.status === 'conflict' && !waiting) row.append(element('p', lastFailure.problem.message));
      if (op.status === 'conflict' && !waiting && !op.command) row.append(button('Conferir versões', () => void openReview(op.sequence)));
      if (op.status === 'conflict' && !waiting && op.command === 'completeSimple') row.append(button('Conferir conclusão', () => void openReview(op.sequence)));
      if (op.status === 'conflict' && !waiting && op.command === 'reopenSimple') row.append(button('Conferir reabertura', () => void openReview(op.sequence)));
      if (op.status === 'conflict' && !waiting && op.command === 'rescheduleSimple') row.append(button('Conferir reagendamento', () => void openReview(op.sequence)));
      if (op.status === 'conflict' && !waiting && op.command === 'convertSimple') row.append(button('Conferir conversão', () => void openReview(op.sequence)));
      if (op.restoration && ['conflict','rejected'].includes(op.status) && !waiting) {
        row.append(button('Arquivar tentativa e conferir de novo', () => void act(async active => {
          const owner = identity();
          const storage = accountStorage(localStorage, owner.uid);
          storage.setItem('fluxoRestorationPauseV6', 'restauracao-em-revisao');
          await active.archiveRestoration(op.sequence);
          ensureActive(active);
          const latest = await active.state();
          ensureActive(active);
          storage.setItem('fluxoRestorePreparedV6', JSON.stringify({ uid: owner.uid, generation: owner.generation,
            digest: op.sourceDigest, operations: latest.operations.filter(item => item.restoration
              && item.sourceDigest === op.sourceDigest && item.status === 'pending').map(item => item.opId) }));
          notice('notice', 'Tentativa preservada em arquivo local. Confira o backup novamente ou libere os outros envios por sua decisão.');
          void render();
        })));
      }
      if (op.status === 'archived') row.append(versionCard('Versão do arquivo preservada', { data: op.changes }, op.kind ?? 'task'));
      if (op.status === 'conflict' && !waiting && op.command && op.localBefore?.seriesId) {
        row.append(button('Rever recorrência', () => void act(async active => {
          const review = await active.reviewSeries(op.sequence);
          ensureActive(active);
          recurring = { active, review, sequence: op.sequence };
          $('series-versions').replaceChildren(
            versionCard('Versão original', { data: op.localBefore }, 'task'),
            versionCard('Minha tentativa', { data: { ...op.localBefore, ...op.changes } }, 'task'),
            versionCard('Estado confirmado', review.task, 'task'));
          const successor = review.successor?.remote.data;
          $('series-message').textContent = successor
            ? 'Ocorrência pendente conferida: ' + successor.text + ' · ' + successor.date
            : 'A série está sem ocorrência pendente.';
          if (op.command === 'changeFrequency') $('series-message').textContent += ' · Frequência solicitada: ' + op.args.cadence + ' · Confirmada: ' + review.series.remote.data.cadence;
          const available = !review.task.deleted && (op.command === 'reopenOccurrence' ? review.task.data.done
            : !review.task.data.done && (review.task.data.reopened || review.series.remote.data.pendingId === review.id));
          $('series-decision').elements.choice.querySelector('[value=local]').disabled = !available;
          $('series-decision').elements.choice.querySelector('[value=date]').disabled = !available || ['changeFrequency','reopenOccurrence'].includes(op.command);
          $('series-decision').reset();
          $('series-review').showModal();
        })));
      }
      if (op.command && op.problem) {
        const details = element('details');
        details.append(element('summary', 'Conferir ação preservada'), element('p', op.problem.message));
        if (op.kind === 'task') {
          details.append(versionCard('Versão original', { data: op.localBefore }, 'task'),
            versionCard('Minha alteração', { data: { ...op.localBefore, ...op.changes },
              deleted: op.action === 'delete' }, 'task'),
            versionCard('Versão remota na recusa', op.problem.remote, 'task'));
        }
        row.append(details);
      }
      return row;
    }));
    if (!conflicts.length) $('conflicts').append(element('p', 'Nenhum conflito registrado.'));
    if (reviewed?.current === current && $('review').open) {
      const latest = state.tasks.find(row => row.id === reviewed.op.id)?.confirmed;
      if (latest?.revision > reviewed.remote?.revision) {
        notice('review-notice', 'A tarefa mudou. Confira a versão atual antes de confirmar.');
      }
    }
  }
  async function openReview(sequence) {
    const version = ++reviewVersion;
    const manualDraft = reviewed?.op.sequence === sequence && decision.elements.choice.value === 'manual'
      ? readFields($('decision-fields'), reviewed.kind) : null;
    await act(async current => {
      const { op, remote } = await current.review(sequence);
      ensureActive(current);
      if (version !== reviewVersion) return;
      if (!remote) throw new Error('A versão remota não está disponível. A sua edição continua guardada.');
      const kind = op.kind ?? 'task';
      const local = { data: { ...blankFor(kind), ...op.localBefore, ...op.changes }, deleted: op.action === 'delete' };
      reviewed = { current, op, remote, local, kind };
      $('versions').replaceChildren(versionCard('Versão original', { data: op.localBefore, deleted: false }, kind),
        versionCard('Minha alteração', local, kind), versionCard('Versão remota', remote, kind));
      for (const reference of op.reviewedReferences ?? []) $('versions').append(versionCard('Espaço conferido', reference.remote, 'space'));
      if (op.command === 'convertSimple') $('versions').append(element('p', 'Converter a tarefa atual, preservando seu conteúdo. Frequência solicitada: ' + op.args.cadence));
      decision.reset();
      decision.elements.choice.querySelector('[value=fields]').hidden = !op.localBefore || local.deleted || remote.deleted;
      decision.elements.choice.querySelector('[value=manual]').hidden = kind === 'order';
      if (op.command === 'convertSimple') {
        decision.elements.choice.querySelector('[value=fields]').hidden = true;
        decision.elements.choice.querySelector('[value=manual]').hidden = true;
      }
      $('decision-fields').replaceChildren();
      notice('review-notice');
      if (manualDraft) {
        decision.elements.choice.value = 'manual';
        formFields($('decision-fields'), manualDraft, kind);
        notice('review-notice', 'Sua versão escrita foi mantida. Compare com a versão remota atual.');
      }
      if (!$('review').open) $('review').showModal();
    }, $('review').open ? 'review-notice' : 'notice');
  }
  decision.elements.choice.addEventListener('change', () => {
    const container = $('decision-fields');
    container.replaceChildren();
    if (!reviewed) return;
    const { op, remote, local, kind } = reviewed;
    const choice = decision.elements.choice.value;
    if (choice === 'manual') formFields(container, local.data, kind);
    if (choice === 'fields' && op.localBefore && !local.deleted && !remote.deleted) {
      for (const field of fieldsFor(kind)) {
        const label = element('label', labels[field]);
        const select = element('select');
        select.name = field;
        select.required = true;
        select.add(new Option('Escolha uma versão', ''));
        select.add(new Option('Minha: ' + display(field, local.data[field]), 'local'));
        select.add(new Option('Remota: ' + display(field, remote.data[field]), 'remote'));
        const original = op.localBefore[field], mine = local.data[field], theirs = remote.data[field];
        select.value = mine === theirs || mine === original ? 'remote' : theirs === original ? 'local' : '';
        label.append(select);
        container.append(label);
      }
    }
    if (remote.deleted && ['manual', 'local'].includes(choice) && (choice === 'manual' || !local.deleted)) {
      notice('review-notice', 'Confirmar esta escolha vai restaurar a tarefa excluída.');
    }
  });
  decision.addEventListener('submit', event => {
    event.preventDefault();
    const view = reviewed;
    if (!view) return;
    const submit = decision.querySelector('[type=submit]');
    submit.disabled = true;
    void act(async current => {
      if (view.current !== current) throw new Error('Abra o conflito na sessão atual.');
      const choice = decision.elements.choice.value;
      let desired;
      if (choice === 'remote') desired = view.remote;
      else if (choice === 'local') desired = view.local;
      else if (choice === 'manual') desired = { deleted: false, data: readFields($('decision-fields'), view.kind) };
      else if (choice === 'fields' && !view.local.deleted && !view.remote.deleted) {
        const data = Object.fromEntries(fieldsFor(view.kind).map(field => {
          const side = $('decision-fields').querySelector('[name="' + field + '"]').value;
          if (!side) throw new Error('Escolha uma versão para cada campo em conflito.');
          return [field, view[side].data[field]];
        }));
        desired = { deleted: false, data };
      } else throw new Error('Escolha o que deseja manter.');
      await current.resolve(view.op.sequence, view.remote, desired, undefined, view.op.reviewedReferences ?? [], choice);
      ensureActive(current);
      $('review').close();
      notice('notice', 'Decisão registrada. Aguardando confirmação.');
      send(current);
    }, 'review-notice').finally(() => { submit.disabled = false; });
  });
  $('review-reload').addEventListener('click', () => { if (reviewed) void openReview(reviewed.op.sequence); });
  $('series-decision').onsubmit = event => {
    event.preventDefault();
    const context = recurring;
    if (!context) return;
    void act(async active => {
      if (context.active !== active) throw new Error('A sessão mudou.');
      await active.resolveSeries(context.sequence, context.review,
        $('series-decision').elements.choice.value, $('series-decision').elements.date.value);
      ensureActive(active);
      $('series-review').close();
      send(active);
    });
  };
  for (const close of document.querySelectorAll('[data-close]')) close.onclick = () => close.closest('dialog').close();
  $('review').addEventListener('close', () => { reviewVersion++; reviewed = undefined; });
  $('create').addEventListener('submit', event => {
    event.preventDefault();
    void act(async current => {
      await current.enqueue(crypto.randomUUID(), { text: $('create').elements.text.value }, { create: true });
      ensureActive(current);
      $('create').reset();
      send(current);
    });
  });
  $('edit-form').addEventListener('submit', event => {
    event.preventDefault();
    const view = edited;
    void act(async current => {
      if (view?.current !== current) return;
      const values = readFields($('edit-fields'), view.kind);
      if(view.kind==='profile'&&values.timeZone!==(view.task?.view.timeZone??'America/Sao_Paulo'))values.timeZone=canonicalTimeZone(values.timeZone);
      const completing = view.kind === 'task' && !view.task.view.done && values.done;
      const reopening = view.kind === 'task' && view.task.view.done && !values.done;
      const changes = Object.fromEntries(fieldsFor(view.kind).filter(field => Object.hasOwn(values, field) && values[field] !== view.task?.view[field]
        && !((completing || reopening) && ['done','completedOn'].includes(field)))
        .map(field => [field, values[field]]));
      if (Object.keys(changes).length) await current.enqueue(view.id, changes, {
        kind: view.kind, create: !view.task, observed: view.task?.view
      });
      if (completing) await current.complete(view.id);
      if (reopening) await current.reopen(view.id);
      ensureActive(current);
      $('editor').close();
      send(current);
    });
  });
  const forms = {
    'series-form': (current, fields) => current.startSeries({
      seriesId: crypto.randomUUID(), date: fields.date.value, cadence: fields.cadence.value,
      changes: { text: fields.text.value }
    }),
    'goal-form': (current, fields) => current.enqueue('goal_' + crypto.randomUUID(),
      { text: fields.text.value }, { kind: 'goal', create: true }),
    'focus-form': (current, fields) => current.recordFocus('focus_' + crypto.randomUUID(), Number(fields.seconds.value))
  };
  for (const [id, submit] of Object.entries(forms)) {
    $(id).addEventListener('submit', event => {
      event.preventDefault();
      void act(async current => {
        await submit(current, $(id).elements);
        ensureActive(current);
        $(id).reset();
        send(current);
      });
    });
  }
  $('sync').onclick = () => void act(current => current.flush());
  $('backup').onchange = () => {
    const file = $('backup').files[0];
    const version = ++backupVersion;
    $('backup-preview').replaceChildren();
    if (!file) return;
    void act(async current => {
      const { source, values } = validateBackup(await file.text());
      ensureActive(current);
      if (source.fluxoOwnerUid && source.fluxoOwnerUid !== identity().uid) {
        throw new Error('Este backup foi exportado por outra conta.');
      }
      const results = [];
      for (const task of values.tarefas) {
        ensureActive(current);
        const name = task.texto;
        if (typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id) || task.recorrencia || task.serieId) {
          results.push(name + ' — identificação antiga ou recorrência. Confira o arquivo original.');
          continue;
        }
        const existing = await current.readRecord(task.id);
        const local = (await current.state()).tasks.some(row => row.id === task.id);
        if (existing || local) {
          results.push(name + (existing?.deleted ? ' — tarefa excluída. O backup não vai restaurá-la.' : ' — já existe. A versão atual foi preservada.'));
          continue;
        }
        results.push(name + ' — sem correspondência. Nenhum dado foi importado.');
      }
      ensureActive(current);
      if (version !== backupVersion) return;
      const target = $('backup-preview');
      target.replaceChildren(...results.map(result => element('p', result)));
    });
  };
  return {
    render,
    clear() {
      renderVersion++; reviewVersion++; backupVersion++;
      edited = reviewed = recurring = undefined;
      for (const id of ['editor', 'review', 'series-review']) if ($(id).open) $(id).close();
      for (const id of ['tasks', 'goals', 'totals', 'profile-summary', 'conflicts', 'versions', 'decision-fields', 'edit-fields', 'backup-preview', 'shared-order', 'series-versions', 'series-message']) $(id).replaceChildren();
      $('backup').value = '';
      for (const id of ['create', ...Object.keys(forms)]) $(id).reset();
      notice('notice');
      notice('review-notice');
      $('status').textContent = 'Escolha uma conta para começar.';
      void render();
    }
  };
}





