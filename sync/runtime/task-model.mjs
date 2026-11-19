import { isLocalDate } from '../monthly.mjs';
import { validTimeZone } from './recurrence.mjs';

const limits = { text: 500, description: 20000, spaceId: 128 };
export function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function validJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
    && Object.values(value).every(validJSON);
}
export const editable = ['text', 'description', 'date', 'spaceId', 'priority', 'done'];
export const blankTask = {
  text: '', description: '', date: null, spaceId: null, priority: 'p2',
  done: false, seriesId: null, ordinal: null, completedOn: null
};
const defaults = {
  task: blankTask, goal: { text: '', done: false },
  profile: { name: '', avatar: null, timeZone: 'America/Sao_Paulo' },
  space: { name: '' }, order: { ids: [] }, archive: { source: {} }
};
export const fieldsFor = kind => [
  ...(kind === 'task' ? [...editable, 'completedOn'] : Object.keys(defaults[kind] || {})),
  ...(['task', 'goal', 'profile', 'space'].includes(kind) ? ['legacy'] : [])
];
export const blankFor = kind => defaults[kind];

export function validateChanges(changes, kind = 'task') {
  const fields = Object.keys(changes);
  if (!fields.length || fields.some(field => !fieldsFor(kind).includes(field))) {
    throw new TypeError('Selecione campos válidos para este registro.');
  }
  for (const [field, value] of Object.entries(changes)) {
    const valid = field === 'legacy' || field === 'source' ? value !== null && !Array.isArray(value)
      && typeof value === 'object' && validJSON(value) && JSON.stringify(value).length <= 200000
      && (field !== 'legacy' || ['original','audit','fields'].every(key => value[key] !== null
        && typeof value[key] === 'object' && !Array.isArray(value[key]))
        && Object.keys(value).every(key => ['original','audit','fields'].includes(key)))
      : field === 'ids' ? Array.isArray(value) && value.length <= 5000 && new Set(value).size === value.length
        && value.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))
      : field === 'timeZone' ? !!validTimeZone(value)
      : field === 'name' ? typeof value === 'string' && value.length <= 200
      : field === 'avatar' ? value === null || (typeof value === 'string' && value.length <= 200000
        && /^(https:\/\/[^\s]+|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+)$/.test(value))
      : ['date', 'completedOn'].includes(field) ? value === null || isLocalDate(value)
      : field === 'priority' ? ['p1', 'p2', 'p3'].includes(value)
      : field === 'done' ? typeof value === 'boolean'
      : (field === 'spaceId' && value === null) ||
        (typeof value === 'string' && value.length <= limits[field] && (field !== 'text' || value.trim()));
    if (!valid) throw new TypeError('Campo inválido: ' + field);
  }
}

export class TaskConflict extends Error {
  constructor(message, remote) {
    super(message);
    this.remote = remote;
  }
}

export function applyToConfirmed(op, remote) {
  const kind = op.kind ?? 'task';
  if (op.action === 'create') {
    if (remote) throw new TaskConflict('O identificador já existe.', remote);
    return { ...blankFor(kind), ...op.changes };
  }
  if (!remote || remote.kind !== kind || (kind === 'task' && remote.data.seriesId !== null)) {
    throw new TaskConflict('O registro foi removido ou requer uma operação específica.', remote);
  }
  if (op.restoration) {
    if (!equal(remote, op.reviewedRemote)) throw new TaskConflict('O registro mudou depois da prévia do backup. Confira as versões.', remote);
    return { ...remote.data, ...op.changes };
  }
  if (op.resolves !== undefined) {
    if (remote.revision !== op.baseRevision) {
      throw new TaskConflict('A tarefa mudou depois da sua conferência. Revise a versão atual.', remote);
    }
    return ['delete', 'keepDeleted'].includes(op.action) ? remote.data : { ...remote.data, ...op.changes };
  }
  if (remote.deleted) throw new TaskConflict('A tarefa foi excluída em outro dispositivo.', remote);
  if (remote.revision < op.baseRevision) {
    throw new TaskConflict('A revisão remota é anterior à base da operação.', remote);
  }
  if (op.action === 'delete') {
    if (fieldsFor(kind).some(field => !equal(remote.data[field], op.localBefore[field]))) {
      throw new TaskConflict('A tarefa recebeu uma edição antes da exclusão.', remote);
    }
    return remote.data;
  }
  for (const [field, value] of Object.entries(op.changes)) {
    if (!equal(remote.data[field] ?? null, op.before[field]) && !equal(remote.data[field], value)) {
      throw new TaskConflict('Edições divergentes no campo ' + field + '.', remote);
    }
  }
  return { ...remote.data, ...op.changes };
}

export function resolutionIntent(remote, desired) {
  if (typeof desired.deleted !== 'boolean') throw new TypeError('Escolha o estado da tarefa.');
  if (!remote || !blankFor(remote.kind) || (remote.kind === 'task' && remote.data.seriesId !== null)) {
    throw new Error('O registro remoto precisa estar disponível para conciliação.');
  }
  if (desired.deleted) return { action: remote.deleted ? 'keepDeleted' : 'delete', changes: {} };
  const fields = fieldsFor(remote.kind).filter(field => desired.data[field] !== undefined);
  const changes = Object.fromEntries(fields.map(field => [field, desired.data[field]]));
  validateChanges(changes, remote.kind);
  const differs = fields.some(field => !equal(remote.data[field], changes[field]));
  return { action: remote.deleted ? (differs ? 'restoreEdit' : 'restore') : 'update', changes };
}
