export const ACCOUNT_PREFIX = 'fluxo:uid:';

export function accountStorage(storage, uid) {
  if (typeof uid !== 'string' || !uid) throw new Error('Conta inválida.');
  const prefix = ACCOUNT_PREFIX + encodeURIComponent(uid) + ':';
  const keys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter(key => key?.startsWith(prefix));
  return {
    prefix,
    get length() { return keys().length; },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(key) { return storage.getItem(prefix + key); },
    setItem(key, value) { storage.setItem(prefix + key, value); },
    removeItem(key) { storage.removeItem(prefix + key); }
  };
}
