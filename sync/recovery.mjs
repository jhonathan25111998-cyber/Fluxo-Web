import { operationDigest } from './operations.mjs';
import { transactionDone } from '../backup.js';

export async function makeBackup({ uid, generation }, state) {
  const data = { format: 'fluxo-ensaio-1', uid, generation, ...state };
  return JSON.stringify({ data, digest: await operationDigest(data) });
}

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('FluxoRecuperacaoEnsaio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('copies', { autoIncrement: true })
      .createIndex('account', ['uid', 'generation']);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function recover(raw, owner, active, storage) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('JSON inválido. A cópia não foi aplicada.'); }
  const data = value?.data;
  if (data?.format !== 'fluxo-ensaio-1' || data.uid !== owner.uid || data.generation !== owner.generation
    || !Array.isArray(data.tasks) || !Array.isArray(data.operations)
    || [...data.tasks, ...data.operations].some(row => row?.uid !== owner.uid || row?.generation !== owner.generation)
    || await operationDigest(data) !== value.digest) throw new Error('Cópia inválida ou de outra conta.');
  const db = await open();
  try {
    if (!active()) throw new Error('A sessão mudou.');
    storage.setItem('fluxoSyncSecurityPause', 'copia-em-revisao');
    const tx = db.transaction('copies', 'readwrite', { durability: 'strict' });
    const complete = transactionDone(tx);
    const store = tx.objectStore('copies');
    const request = store.add({ uid: owner.uid, generation: owner.generation, raw });
    let verified = false;
    request.onsuccess = () => {
      const read = store.get(request.result);
      read.onsuccess = () => {
        verified = read.result?.raw === raw;
        if (!verified) tx.abort();
      };
    };
    await complete;
    if (!verified) throw new Error('Falha ao conferir a cópia.');
  } finally { db.close(); }
}
export async function savedRecovery(owner) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('copies').objectStore('copies').index('account')
        .openCursor(IDBKeyRange.only([owner.uid, owner.generation]), 'prev');
      request.onsuccess = () => resolve(request.result?.value.raw);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
