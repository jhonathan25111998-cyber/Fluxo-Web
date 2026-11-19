// Pure validation and local recovery. This module never accesses Firebase.
export const RECOVERY_KEY = 'fluxoRecoveryV1';
export const EXTRA_KEY = 'fluxoBackupExtrasV1';
export const ARRAY_KEYS = ['tarefas', 'metas', 'cardsTarefas', 'cardsMetas'];
export const NUMBER_KEYS = ['tempoTotalFocado', 'tempoFocadoHoje', 'tarefasReagendadasHoje'];
export const DATE_KEYS = ['ultimaDataFoco', 'ultimaDataReset', 'ultimaDataReagendamento'];
export const DATA_KEYS = [...ARRAY_KEYS, ...NUMBER_KEYS, ...DATE_KEYS, 'profile', EXTRA_KEY];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = x => JSON.parse(JSON.stringify(x));

function decode(value, field) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new Error(`JSON inválido em ${field}. Nenhum dado foi restaurado.`); }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validateArray(value, field) {
  const rows = decode(value, field);
  if (!Array.isArray(rows)) throw new Error(`${field} deve ser uma lista.`);
  for (const row of rows) {
    if (!object(row)) throw new Error(`Registro inválido em ${field}.`);
    if (!(typeof row.id === 'string' && row.id.length > 0) &&
        !(typeof row.id === 'number' && Number.isFinite(row.id))) {
      throw new Error(`Identificador inválido em ${field}.`);
    }
    const label = field.startsWith('cards') ? 'nome' : 'texto';
    if (typeof row[label] !== 'string') throw new Error(`${label} inválido em ${field}.`);
    for (const key of ['descricao', 'bloco', 'recorrencia', 'serieId', 'prioridade']) {
      if (own(row, key) && row[key] !== null && typeof row[key] !== 'string') {
        throw new Error(`${key} inválido em ${field}.`);
      }
    }
    if (own(row, 'data') && row.data !== null && row.data !== '' && !validDate(row.data)) {
      throw new Error(`Data inválida em ${field}.`);
    }
    for (const key of ['concluida', 'atingida']) {
      if (own(row, key) && typeof row[key] !== 'boolean') throw new Error(`${key} inválido.`);
    }
    for (const key of ['tempoGasto', 'ordem']) {
      if (own(row, key) && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)) {
        throw new Error(`${key} inválido.`);
      }
    }
  }
  // Do not deduplicate, rename legacy recurrence values, or discard unknown fields.
  return clone(rows);
}

export function validateBackup(input) {
  const source = decode(input, 'arquivo');
  if (!object(source) || !own(source, 'tarefas')) throw new Error('Backup sem lista de tarefas.');
  const values = {};
  for (const key of ARRAY_KEYS) {
    if (key !== 'tarefas' && (source[key] == null || decode(source[key], key) === null)) continue;
    if (own(source, key)) values[key] = validateArray(source[key], key);
  }
  for (const key of NUMBER_KEYS) {
    if (!own(source, key) || source[key] === null) continue;
    const raw = source[key];
    if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === '') {
      throw new Error(`Contador inválido: ${key}.`);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Contador inválido: ${key}.`);
    values[key] = n;
  }
  for (const key of DATE_KEYS) {
    if (!own(source, key) || source[key] === null) continue;
    if (source[key] !== '' && !validDate(source[key])) throw new Error(`Data inválida: ${key}.`);
    values[key] = source[key];
  }
  if (own(source, 'profile') && source.profile !== null) {
    const p = decode(source.profile, 'profile');
    if (!object(p)) throw new Error('Perfil inválido.');
    for (const key of ['nome', 'avatar']) {
      if (own(p, key) && p[key] !== null && typeof p[key] !== 'string') throw new Error('Perfil inválido.');
    }
    values.profile = clone(p);
  }
  return { values, source: clone(source) };
}

export function snapshotStorage(storage) {
  return Object.fromEntries(DATA_KEYS.map(key => [key, storage.getItem(key)]));
}

export function buildBackup(storage) {
  let extras = {};
  const rawExtras = storage.getItem(EXTRA_KEY);
  if (rawExtras !== null) {
    extras = decode(rawExtras, EXTRA_KEY);
    if (!object(extras)) throw new Error('Campos extras do backup inválidos.');
  }
  const source = { ...extras, formatoFluxo: 1, exportadoEm: new Date().toISOString() };
  for (const key of DATA_KEYS.filter(k => k !== EXTRA_KEY)) {
    const raw = storage.getItem(key);
    if (raw !== null) source[key] = raw;
    else delete source[key];
  }
  if (!own(source, 'tarefas')) source.tarefas = [];
  const { values } = validateBackup(source);
  return { ...source, ...values };
}

export function recoveryBlocked(storage) {
  // Fail closed, including a damaged journal. Never automatically remove this guard.
  return storage.getItem(RECOVERY_KEY) !== null;
}

export function prepareRestore(storage, input, uid) {
  if (!uid) throw new Error('Entre na conta antes de restaurar.');
  const validated = input?.rawStorage ? validateRawSnapshot(input.rawStorage) : validateBackup(input);
  const previousJournal = storage.getItem(RECOVERY_KEY);
  const journal = {
    version: 1, status: 'prepared', uid, createdAt: new Date().toISOString(),
    before: snapshotStorage(storage), previousJournal, source: validated.source,
    values: validated.values, rawStorage: input?.rawStorage ? clone(input.rawStorage) : undefined
  };
  const raw = JSON.stringify(journal);
  storage.setItem(RECOVERY_KEY, raw);
  if (storage.getItem(RECOVERY_KEY) !== raw) throw new Error('Não foi possível preservar a cópia anterior.');
  return journal;
}

export function commitRestore(storage, journal) {
  const current = JSON.parse(storage.getItem(RECOVERY_KEY));
  if (current.status !== 'prepared' || current.uid !== journal.uid ||
      JSON.stringify(current) !== JSON.stringify(journal)) throw new Error('Restauração concorrente.');
  const { values } = journal.rawStorage ? validateRawSnapshot(journal.rawStorage) : validateBackup(journal.source);
  const entries = journal.rawStorage ? Object.entries(journal.rawStorage) : Object.entries(values).map(([key, value]) => [key,
    ARRAY_KEYS.includes(key) || key === 'profile' ? JSON.stringify(value) : String(value)]);
  if (!journal.rawStorage) entries.push([EXTRA_KEY, JSON.stringify(journal.source)]);
  try {
    for (const [key, raw] of entries) {
      if (raw === null) storage.removeItem(key); else storage.setItem(key, raw);
    }
    for (const [key, raw] of entries) {
      if (storage.getItem(key) !== raw) throw new Error('Verificação da gravação falhou.');
    }
    validateBackup(buildBackup(storage));
    storage.setItem(RECOVERY_KEY, JSON.stringify({ ...journal, status: 'restored' }));
    if (JSON.parse(storage.getItem(RECOVERY_KEY)).status !== 'restored') throw new Error('Journal não confirmado.');
  } catch (error) {
    // Original raw strings remain in the journal even if rollback cannot finish.
    for (const [key, raw] of Object.entries(journal.before)) {
      try { if (raw === null) storage.removeItem(key); else storage.setItem(key, raw); } catch { /* journal retained */ }
    }
    throw error;
  }
  return true;
}

export function validateRawSnapshot(raw) {
  if (!object(raw) || DATA_KEYS.some(key => !own(raw, key)) || Object.keys(raw).some(key => !DATA_KEYS.includes(key))) {
    throw new Error('Cópia integral incompleta ou inválida.');
  }
  const payload = { tarefas: [] };
  for (const key of DATA_KEYS) {
    if (raw[key] !== null && typeof raw[key] !== 'string') throw new Error('Valor bruto inválido.');
    if (key === EXTRA_KEY) {
      if (raw[key] !== null && !object(decode(raw[key], key))) throw new Error('Campos extras inválidos.');
    } else if (raw[key] !== null) payload[key] = raw[key];
  }
  return validateBackup(payload);
}

export function readLocalJSON(storage, key, fallback, onError = () => {}) {
  const raw = storage.getItem(key);
  if (raw === null) return clone(fallback);
  try {
    if (ARRAY_KEYS.includes(key)) return validateArray(raw, key);
    const value = JSON.parse(raw);
    if (!object(value)) throw new Error('Objeto inválido.');
    return value;
  } catch (error) {
    // Keep the original bytes at their original key; caller must block writes.
    onError(key, error);
    return clone(fallback);
  }
}

export function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Falha na transação de backup.'));
    tx.onabort = () => reject(tx.error || new Error('Transação de backup cancelada.'));
  });
}
