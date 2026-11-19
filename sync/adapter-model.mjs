import { equal, blankTask } from './runtime/task-model.mjs';
import { operationDigest } from './operations.mjs';
import { cadenceAt, cadenceOf } from './runtime/recurrence.mjs';

export const knownTask = ['id','texto','descricao','data','bloco','prioridade','concluida','recorrencia','serieId','ordem'];
export async function destinationId(kind, raw, source = 'interface', force = false) {
  if (!force && typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.id) && raw.id !== 'perfil') return raw.id;
  return 'map_' + (await operationDigest({ kind, id: raw.id, type: typeof raw.id, source })).slice(0, 40);
}
export async function orderId(spaceId) {
  return 'ordem_' + (spaceId.length <= 122 ? spaceId : await operationDigest(spaceId));
}
export function preserve(raw, previous, source, position) {
  const represented = new Set([...knownTask, 'nome', 'avatar', 'timeZone', '_spaceId', '_displaySpaceId', '_virtual', 'tempoGastoLegado', 'tempoGasto']);
  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !represented.has(key)));
  return {
    ...(previous ?? {}),
    original: previous?.original ?? structuredClone(raw),
    audit: previous?.audit ?? { id: raw.id ?? null, type: typeof raw.id, source, position },
    fields: { ...previous?.fields, ...structuredClone(extras) }
  };
}
export function taskData(raw, legacy, spaceId) {
  const { seriesId, ordinal, completedOn, ...simple } = blankTask;
  return {
    ...simple, text: raw.texto, description: raw.descricao ?? '', date: raw.data || null,
    priority: raw.prioridade || 'p3', done: raw.concluida ?? false, spaceId,
    legacy
  };
}
export function changesBetween(current, desired) {
  return Object.fromEntries(Object.entries(desired).filter(([key, value]) => !equal(current[key], value)));
}
export function retainUnknown(previous, incoming) {
  if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object'
    || Array.isArray(previous) || Array.isArray(incoming)) return structuredClone(incoming);
  const result = structuredClone(previous);
  for (const [key, value] of Object.entries(incoming)) {
    Object.defineProperty(result, key, { value: retainUnknown(Object.hasOwn(previous, key) ? previous[key] : undefined, value),
      enumerable: true, configurable: true, writable: true });
  }
  return result;
}
export function orderedTasks(tasks, ids = []) {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) =>
    (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id));
}
const cadence = { daily: 'diaria', weekdays: 'dias_uteis', weekly: 'semanal', monthly: 'mensal' };
export async function legacyView(state) {
  const active = state.tasks.filter(row => row.view);
  const spaces = active.filter(row => row.kind === 'space').map(row => ({
    ...row.view.legacy?.fields, id: row.id, nome: row.view.name, _virtual: false
  }));
  // An unassigned task stays visible even when its space has not arrived yet.
  let fallbackId = 'sem-espaco';
  while (spaces.some(row => row.id === fallbackId)) fallbackId += '_';
  const fallback = { id: fallbackId, nome: 'Sem espaço', _virtual: true };
  const spaceFor = id => spaces.find(row => row.id === id) ?? fallback;
  const tasks = active.filter(row => row.kind === 'task').map(row => {
    const d = row.view;
    let series = active.find(item => item.id === d.seriesId && item.kind === 'series')?.view
      ?? state.operations?.find(op => op.command === 'startSeries' && op.args.seriesId === d.seriesId && op.status === 'pending')?.args.series;
    const conversion = state.operations?.find(op => op.command === 'convertSimple' && op.id === row.id && op.status === 'pending');
    if (!series && conversion) series = { cadence: cadenceOf(conversion.args.cadence) };
    const pendingRule = state.operations?.filter(op => op.command === 'changeFrequency' && op.id === row.id && op.status === 'pending').at(-1);
    const visibleCadence = pendingRule && !d.done ? cadenceOf(pendingRule.args.cadence) : series && cadenceAt(series, d.ordinal);
    return { ...d.legacy?.fields, id: row.id, texto: d.text, descricao: d.description,
      data: d.date, prioridade: d.priority, concluida: d.done, concluidaEm: d.completedOn ?? d.legacy?.fields?.concluidaEm ?? null,
      recorrencia: series ? cadence[visibleCadence] : '', serieId: d.seriesId,
      bloco: spaceFor(d.spaceId).nome, _spaceId: d.spaceId, _displaySpaceId: spaceFor(d.spaceId).id };
  });
  if (!spaces.length || tasks.some(task => task._displaySpaceId === fallback.id)) spaces.push(fallback);
  for (const space of spaces) {
    const sequenceId = await orderId(space.id);
    const order = active.find(row => row.kind === 'order' && row.id === sequenceId)?.view.ids ?? [];
    const sorted = orderedTasks(tasks.filter(row => row._spaceId === space.id
      || (space.id === fallback.id && !spaces.some(item => item.id === row._spaceId))), order);
    sorted.forEach((row, index) => { row.ordem = index; });
  }
  const goals = active.filter(row => row.kind === 'goal').map(row => ({
    ...row.view.legacy?.fields, id: row.id, texto: row.view.text, concluida: row.view.done
  }));
  const profile = active.find(row => row.id === 'perfil' && row.kind === 'profile')?.view;
  return {
    tarefas: tasks, metas: goals, cardsTarefas: spaces,
    profile: profile ? { ...profile.legacy?.fields, nome: profile.name, avatar: profile.avatar, timeZone: profile.timeZone } : {}
  };
}

