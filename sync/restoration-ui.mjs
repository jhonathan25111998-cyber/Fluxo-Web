import { restorationPreview, restorationData } from './restoration-model.mjs';
import { accountStorage } from '../account-storage.js';
import { keepDraft } from './drafts.mjs';

const el = id => document.getElementById(id);
function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
export function mountRestoration({ owner, message }) {
  let preview, selections, targets, links, version = 0;
  const report = value => { el('restoration-status').textContent = value; message(value); };
  const clear = (resetConsent = false) => {
    version++;
    preview = selections = targets = links = undefined;
    el('restoration-status').textContent = '';
    el('restore-preview').replaceChildren();
    el('apply-restoration').disabled = true;
    if (resetConsent) el('unowned-backup').checked = false;
  };
  el('recovery-file').addEventListener('change', () => clear(true));
  const act = work => {
    const current = owner();
    void work().catch(error => { if (owner() === current) report(error.message); });
  };
  el('preview-restoration').onclick = () => act(async () => {
    clear();
    const requested = version;
    const current = owner();
    if (!current) throw new Error('Entre com sua conta.');
    const file = el('recovery-file').files[0];
    if (!file) throw new Error('Escolha o arquivo para conferir.');
    const raw = await file.text();
    if (owner() !== current || version !== requested) return;
    const prepared = await restorationPreview(raw, current, id => current.session.readRecord(id), el('unowned-backup').checked);
    if (owner() !== current || version !== requested) return;
    preview = { ...prepared, owner: current };
    const context = preview;
    selections = new Map();
    targets = new Map();
    links = new Map();
    const state = await current.session.state();
    if (owner() !== current || preview !== context) return;
    const target = el('restore-preview');
    target.append(text('p', prepared.counters));
    for (const item of prepared.proposals) {
      const row = text('article', '');
      row.className = 'row';
      row.dataset.restore = item.index;
      row.append(text('h3', item.data.text ?? item.data.name ?? item.originalId),
        text('p', item.status + (item.differences.length ? ' · Diferenças: ' + item.differences.join(', ') : '')));
      if (item.limitation) row.append(text('p', item.limitation));
      const versions = document.createElement('details');
      const content = text('pre', JSON.stringify({ arquivo: item.raw, atual: item.remote }, null, 2));
      versions.append(text('summary', 'Conferir conteúdo original e atual'), content);
      row.append(versions);
      const label = text('label', 'Decisão');
      const select = document.createElement('select');
      select.add(new Option('Guardar o arquivo e manter o estado atual', 'archive'));
      if ((!item.limitation || item.spaceRequired) && item.status !== 'igual') {
        const apply = new Option(item.ambiguous ? 'Criar registro separado com origem preservada'
          : item.remote?.deleted ? 'Restaurar explicitamente o registro excluído'
          : item.remote ? 'Aplicar esta versão após conferência' : 'Acrescentar este registro', 'incoming');
        apply.disabled = item.spaceRequired;
        select.add(apply);
      }
      selections.set(item.index, select);
      label.append(select);
      row.append(label);
      if (item.ambiguous && (!item.limitation || item.spaceRequired)) {
        const targetLabel = text('label', 'Correspondência escolhida por você');
        const target = document.createElement('select');
        target.add(new Option('Manter como registro separado', ''));
        for (const record of state.tasks.filter(record => record.confirmed?.kind === item.kind
          && !record.confirmed.data.seriesId && !state.operations.some(op => op.id === record.id && ['pending','conflict','rejected'].includes(op.status)))) {
          target.add(new Option((record.confirmed.deleted ? 'Excluído · ' : '') +
            (record.confirmed.data.text ?? record.confirmed.data.name ?? record.id) + ' · ' + record.id.slice(0, 12), record.id));
        }
        target.onchange = () => act(async () => {
          const id = target.value;
          select.value = 'archive';
          select.dataset.targetReviewing = 'true';
          select.options[1].disabled = true;
          targets.delete(item.index);
          const remote = id ? await current.session.readRecord(id) : item.remote;
          if (owner() !== current || preview !== context || target.value !== id) return;
          if (id) targets.set(item.index, { id, remote });
          content.textContent = JSON.stringify({ arquivo: item.raw, atual: remote }, null, 2);
          select.options[1].textContent = id ? 'Aplicar nesta correspondência após conferir as versões' : 'Criar registro separado com origem preservada';
          select.options[1].disabled = (item.spaceRequired && !links.has(item.index)) || !!select.dataset.spaceReviewing;
          delete select.dataset.targetReviewing;
        });
        targetLabel.append(target);
        row.append(targetLabel);
      }
      if (item.spaceRequired) {
        const label = text('label', 'Espaço escolhido para este registro');
        const space = document.createElement('select');
        space.add(new Option('Manter arquivado até conferir o vínculo', ''));
        space.add(new Option('Deixar sem vínculo e preservar o nome antigo', ':sem-vinculo:'));
        for (const record of state.tasks.filter(record => record.confirmed?.kind === 'space' && !record.confirmed.deleted)) {
          space.add(new Option(record.confirmed.data.name + ' · ' + record.id.slice(0, 12), record.id));
        }
        space.onchange = () => act(async () => {
          const id = space.value;
          select.value = 'archive';
          select.dataset.spaceReviewing = 'true';
          select.options[1].disabled = true;
          links.delete(item.index);
          if (id) {
            const remote = id === ':sem-vinculo:' ? null : await current.session.readRecord(id);
            if (owner() !== current || preview !== context || space.value !== id) return;
            if (id !== ':sem-vinculo:' && (remote?.kind !== 'space' || remote.deleted)) throw new Error('O espaço mudou. Confira o vínculo novamente.');
            links.set(item.index, { spaceId: id === ':sem-vinculo:' ? null : id,
              references: remote ? [{ id, remote }] : [] });
            select.options[1].disabled = !!select.dataset.targetReviewing;
          }
          delete select.dataset.spaceReviewing;
        });
        label.append(space);
        row.append(label);
      }
      target.append(row);
    }
    el('apply-restoration').disabled = false;
    report('Prévia pronta. Nenhum registro foi alterado.');
  });
  el('apply-restoration').onclick = () => act(async () => {
    const view = preview;
    if (!view || view.owner !== owner()) throw new Error('Confira o arquivo nesta sessão.');
    const current = view.owner;
    const storage = accountStorage(localStorage, current.uid);
    if ([...selections.values()].some(select => select.dataset.targetReviewing || select.dataset.spaceReviewing)) throw new Error('Aguarde a conferência da correspondência escolhida.');
    const choices = view.proposals.filter(item => selections.get(item.index).value === 'incoming')
      .map(item => {
        const link = links.get(item.index);
        return { ...item, ...targets.get(item.index),
          ...(link ? { data: { ...item.data, spaceId: link.spaceId }, references: link.references } : {}) };
      });
    const guard = () => { if (owner() !== current) throw new Error('A sessão mudou.'); };
    if (!choices.length) {
      const state = await current.session.state();
      guard();
      await keepDraft(current.uid, { type: 'backupPorRegistro', raw: view.raw, digest: view.digest, state,
        decisions: view.proposals.map(item => ({ index: item.index, decision: 'arquivar' })) }, guard, current.generation);
      guard();
      el('apply-restoration').disabled = true;
      report('Arquivo arquivado e conferido. Nenhum registro foi preparado para envio.');
      return;
    }
    const before = storage.getItem('fluxoRestorationPauseV6');
    if (before && before !== 'restauracao-em-revisao') throw new Error('Há outro bloqueio de segurança. Ele será preservado.');
    storage.setItem('fluxoRestorationPauseV6', 'restauracao-em-revisao');
    const state = await current.session.state();
    guard();
    const previous = JSON.parse(storage.getItem('fluxoRestorePreparedV6') ?? 'null');
    if (previous?.operations?.some(id => state.operations.some(op => op.opId === id && op.status === 'pending'))) {
      throw new Error('Já há uma restauração preparada. Confira a preparação anterior antes de iniciar outra.');
    }
    await keepDraft(current.uid, { type: 'backupPorRegistro', raw: view.raw, digest: view.digest, state,
      decisions: choices.map(item => ({ index: item.index, id: item.id, remote: item.remote, references: item.references ?? [] })) }, guard, current.generation);
    guard();
    const operations = await current.session.queueRestoration(choices.map(item => ({
      id: item.id, kind: item.kind, data: restorationData(item), remote: item.remote, references: item.references ?? []
    })), view.digest);
    guard();
    if (storage.getItem('fluxoRestorationPauseV6') !== 'restauracao-em-revisao') throw new Error('Outro bloqueio foi aplicado. As operações continuam preservadas.');
    storage.setItem('fluxoRestorePreparedV6', JSON.stringify({ uid: current.uid, generation: current.generation,
      digest: view.digest, operations: operations.map(op => op.opId) }));
    el('apply-restoration').disabled = true;
    report('Restauração preparada localmente. Envio pausado até sua liberação.');
  });
  el('release-restoration').onclick = () => act(async () => {
    const current = owner();
    if (!current) throw new Error('Entre com sua conta.');
    const storage = accountStorage(localStorage, current.uid);
    const token = JSON.parse(storage.getItem('fluxoRestorePreparedV6') ?? 'null');
    if (token?.uid !== current.uid || token.generation !== current.generation
      || storage.getItem('fluxoRestorationPauseV6') !== 'restauracao-em-revisao') throw new Error('Não há preparação válida para liberar nesta conta.');
    if (preview && preview.digest !== token.digest) throw new Error('A preparação pendente pertence a outro arquivo. Confira a prévia correta antes de liberar.');
    for (const key of ['fluxoRecoveryV1', 'fluxoLocalConflictV2', 'fluxoEnvioPendente', 'fluxoSyncSecurityPause']) {
      if (storage.getItem(key) !== null) throw new Error('Outro bloqueio de recuperação ou conflito precisa ser conferido.');
    }
    const state = await current.session.state();
    if (owner() !== current) return;
    const decided = source => state.operations.some(op => op.resolves === source.sequence && op.status === 'pending');
    if (state.operations.some(op => op.status === 'rejected' || op.status === 'conflict' && !decided(op))
      || !token.operations.every(id => state.operations.some(op => op.opId === id
        && (['pending','confirmed'].includes(op.status) || op.status === 'conflict' && decided(op))))) {
      throw new Error('Há versões pendentes de conciliação. O envio continua pausado.');
    }
    storage.removeItem('fluxoRestorationPauseV6');
    report('Envio liberado por sua decisão. Aguarde as confirmações ou confira novos conflitos.');
    await current.session.flush();
  });
  return { clear };
}



