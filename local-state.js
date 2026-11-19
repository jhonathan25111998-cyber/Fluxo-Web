// Shared by all current tabs. Drafts are immutable and written before attempting a commit.
import { DATA_KEYS, snapshotStorage, buildBackup } from './backup.js';
export const STATE_KEY = 'fluxoLocalStateV2';
export const DRAFT_PREFIX = 'fluxoDraftV2:';
export const LOCK_NAME = 'fluxo-local-data-v2';
export const fingerprint = storage => JSON.stringify(snapshotStorage(storage));
export function readRevision(storage) {
  const raw = storage.getItem(STATE_KEY);
  if (raw === null) return 0;
  const state = JSON.parse(raw);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Versão local inválida.');
  return state.revision;
}
export function writeDraft(storage, draft) {
  const id = globalThis.crypto.randomUUID();
  const record = { ...draft, id, createdAt: new Date().toISOString() };
  const raw = JSON.stringify(record);
  storage.setItem(DRAFT_PREFIX + id, raw);
  if (storage.getItem(DRAFT_PREFIX + id) !== raw) throw new Error('Não foi possível preservar esta edição.');
  return record;
}
export function listDrafts(storage) {
  const drafts = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(DRAFT_PREFIX)) {
      try { drafts.push(JSON.parse(storage.getItem(key))); } catch { /* retain unreadable original */ }
    }
  }
  return drafts;
}
export function commitLocal(storage, draft, expectedRevision, expectedFingerprint) {
  // Call only under the Web Lock. Byte comparison also detects legacy-tab writes.
  const revision = readRevision(storage);
  if (revision !== expectedRevision || fingerprint(storage) !== expectedFingerprint) {
    return { conflict: true, revision, draft };
  }
  const before = snapshotStorage(storage);
  const previousState = storage.getItem(STATE_KEY);
  for (const [key, raw] of Object.entries(draft.values)) {
    if (!DATA_KEYS.includes(key) || (raw !== null && typeof raw !== 'string')) throw new Error('Campo local inválido.');
  }
  buildBackup({getItem:key=>Object.prototype.hasOwnProperty.call(draft.values,key)?draft.values[key]:storage.getItem(key)});
  try {
    for (const [key, raw] of Object.entries(draft.values)) {
      if (!DATA_KEYS.includes(key)) throw new Error('Campo local não permitido.');
      if (raw === null) storage.removeItem(key); else storage.setItem(key, raw);
    }
    const state = { revision: revision + 1, draftId: draft.id, before, previousState };
    storage.setItem(STATE_KEY, JSON.stringify(state));
    for (const [key, raw] of Object.entries(draft.values)) {
      if (storage.getItem(key) !== raw) throw new Error('Gravação local não confirmada.');
    }
    return { conflict: false, revision: state.revision, fingerprint: fingerprint(storage) };
  } catch (error) {
    // Both the immutable draft and previous bytes remain available for recovery.
    for (const [key, raw] of Object.entries(before)) {
      try { if (raw === null) storage.removeItem(key); else storage.setItem(key, raw); } catch { /* retained in draft/state */ }
    }
    try { if (previousState === null) storage.removeItem(STATE_KEY); else storage.setItem(STATE_KEY, previousState); } catch { /* fail closed */ }
    throw error;
  }
}
