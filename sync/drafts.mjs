import { transactionDone } from '../backup.js';
function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('FluxoIntegracaoRascunhos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { autoIncrement: true })
      .createIndex('owner', ['uid', 'generation']);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function keepDraft(uid, data, guard, generation) {
  if (!generation) throw new Error("Geração não definida.");
  const db = await open();
  try {
    guard();
    const tx = db.transaction('drafts', 'readwrite', { durability: 'strict' });
    const complete = transactionDone(tx);
    const request = tx.objectStore('drafts').add({ uid, generation, data, status: 'preservado' });
    let key;
    request.onsuccess = () => {
      key = request.result;
      const verification = tx.objectStore('drafts').get(key);
      verification.onsuccess = () => {
        if (JSON.stringify(verification.result?.data) !== JSON.stringify(data)) tx.abort();
      };
    };
    await complete;
    guard();
    return key;
  } finally { db.close(); }
}
export async function listDrafts(uid, generation) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').index('owner').getAll([uid, generation]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
