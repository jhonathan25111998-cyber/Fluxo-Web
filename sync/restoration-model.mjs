import { validateBackup } from '../backup.js';
import { operationDigest } from './operations.mjs';
import { blankTask, fieldsFor, validateChanges, equal } from './runtime/task-model.mjs';
import { destinationId, taskData, preserve, retainUnknown } from './adapter-model.mjs';

const blockedKinds = ['series', 'completion', 'completionReversal', 'focus', 'reschedule', 'archive'];
export const SPACE_REVIEW = 'O vínculo por nome de espaço precisa de correspondência explícita.';
export async function restorationPreview(raw, owner, readRemote, confirmUnowned = false) {
  let file;
  try { file = JSON.parse(raw); } catch { throw new Error('JSON inválido. Nenhum registro foi alterado.'); }
  const sourceDigest = await operationDigest(raw);
  const source = 'backup_' + sourceDigest;
  const proposals = [];
  if (file?.data?.format === 'fluxo-ensaio-1') {
    const payload = file.data;
    if (payload.uid !== owner.uid || payload.generation !== owner.generation
      || await operationDigest(payload) !== file.digest
      || !Array.isArray(payload.tasks) || !Array.isArray(payload.operations)) throw new Error('Cópia inválida ou de outra conta ou geração.');
    if ([...payload.tasks, ...payload.operations].some(row => row?.uid !== owner.uid || row?.generation !== owner.generation)) {
      throw new Error('Há registros de outra conta na cópia.');
    }
    for (const row of payload.tasks) {
      const data = row.view ?? (row.confirmed?.deleted ? null : row.confirmed?.data);
      if (!data) continue;
      proposals.push({ originalId: row.id, id: row.id, kind: row.kind ?? row.confirmed?.kind ?? 'task',
        data: structuredClone(data), raw: structuredClone(row), ambiguous: false });
    }
  } else {
    if (file?.fluxoOwnerUid && file.fluxoOwnerUid !== owner.uid) throw new Error('Este backup pertence a outra conta.');
    if (!file?.fluxoOwnerUid && !confirmUnowned) throw new Error('Confirme a propriedade do backup sem identificação de conta.');
    const { values } = validateBackup(file);
    for (const [field, kind] of [['tarefas','task'], ['metas','goal'], ['cardsTarefas','space']]) {
      const list = values[field] ?? [];
      for (const [position, row] of list.entries()) {
        const duplicates = list.filter(other => typeof other.id === typeof row.id && other.id === row.id).length > 1;
        const ambiguous = duplicates || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) || row.id === 'perfil';
        const id = await destinationId(kind, row, source + '_' + field + '_' + position, ambiguous);
        const legacy = preserve(row, null, source + '_' + field, position);
        const data = kind === 'task' ? taskData(row, legacy, null)
          : kind === 'goal' ? { text: row.texto, done: row.concluida ?? row.atingida ?? false, legacy }
          : { name: row.nome, legacy };
        proposals.push({ originalId: row.id, id, kind, data, raw: row, ambiguous,
          limitation: kind === 'goal' && row.concluida != null && row.atingida != null && row.concluida !== row.atingida
            ? 'Os campos de conclusão da meta discordam. Confira as versões.'
            : kind === 'task' && (row.recorrencia || row.serieId) ? 'A série antiga precisa de revisão conjunta.'
            : kind === 'task' && row.bloco ? SPACE_REVIEW : null });
      }
    }
    if (values.profile) proposals.push({ originalId: 'perfil', id: 'perfil', kind: 'profile', raw: values.profile, ambiguous: false,
      data: { name: values.profile.nome ?? '', avatar: values.profile.avatar ?? null,
        timeZone: values.profile.timeZone ?? 'America/Sao_Paulo', legacy: preserve(values.profile, null, source, 0) } });
  }
  const keys = new Set();
  for (const [index, proposal] of proposals.entries()) {
    proposal.index = index;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(proposal.id)) throw new Error('Identificador de destino inválido na cópia.');
    if (keys.has(proposal.id)) proposal.limitation = 'Identificador repetido entre registros. Preserve as versões para mapeamento.';
    keys.add(proposal.id);
    if (blockedKinds.includes(proposal.kind) || proposal.data.seriesId) {
      proposal.limitation = proposal.limitation ?? 'Histórico ou recorrência preservado para conferência específica.';
    }
    if (!proposal.limitation) {
      const fields = Object.fromEntries(Object.entries(proposal.data).filter(([field]) => fieldsFor(proposal.kind).includes(field)));
      if (Object.keys(proposal.data).some(field => !fieldsFor(proposal.kind).includes(field) && !['seriesId', 'ordinal'].includes(field))) {
        proposal.limitation = 'Há campos sem contrato na cópia. O arquivo será preservado integralmente.';
      } else validateChanges(fields, proposal.kind);
    }
    proposal.remote = await readRemote(proposal.id);
    if (proposal.remote && proposal.remote.kind !== proposal.kind) proposal.limitation = 'O destino já pertence a outro tipo de registro.';
    proposal.status = proposal.limitation ? 'revisão necessária' : proposal.ambiguous ? 'sem correspondência segura'
      : !proposal.remote ? 'novo' : proposal.remote.deleted ? 'excluído'
      : equal(proposal.remote.data, proposal.data) ? 'igual' : 'divergente';
    proposal.differences = proposal.remote ? [...new Set([...Object.keys(proposal.remote.data), ...Object.keys(proposal.data)])]
      .filter(field => !equal(proposal.remote.data[field], proposal.data[field])) : [];
  }
  // Collisions affect every participant, including the first occurrence.
  for (const proposal of proposals) {
    if (proposals.filter(row => row.id === proposal.id).length > 1) {
      proposal.limitation = 'Identificador repetido entre registros. Preserve as versões para mapeamento.';
      proposal.status = 'revisão necessária';
    }
    proposal.spaceRequired = proposal.limitation === SPACE_REVIEW;
  }
  return { raw, digest: sourceDigest, proposals, counters: 'Históricos e eventos permanecem separados. Nenhum evento será recriado.' };
}

export function restorationData(proposal) {
  const incoming = structuredClone(proposal.data);
  if (proposal.kind === 'task') {
    const { seriesId, ordinal, ...fields } = incoming;
    if (seriesId != null || ordinal != null) throw new Error('A recorrência exige revisão específica.');
    Object.assign(incoming, fields);
    delete incoming.seriesId;
    delete incoming.ordinal;
  }
  const previous = proposal.remote?.data.legacy;
  if (previous) {
    incoming.legacy = {
      ...previous,
      fields: retainUnknown(previous.fields, incoming.legacy?.fields ?? {})
    };
  }
  return incoming;
}

