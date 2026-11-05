export const CACHE_VERSION = 'terrain-d8-v2';
export const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const DATABASE = 'watershed-local';
let databasePromise;
let available = true;
let enabled = true;
try { if (typeof document !== 'undefined') enabled = globalThis.localStorage?.getItem('watershed-cache-enabled') !== 'false'; } catch {}

export function cacheEnabled() { return enabled; }

export function setCacheEnabled(value) {
  enabled = Boolean(value);
  try { if (typeof document !== 'undefined') globalThis.localStorage?.setItem('watershed-cache-enabled', String(enabled)); } catch {}
}

function openDatabase() {
  if (!globalThis.indexedDB) { available = false; return Promise.resolve(null); }
  if (!databasePromise) databasePromise = new Promise(resolve => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('data');
      request.result.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      available = true;
      request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
      resolve(request.result);
    };
    request.onerror = () => { available = false; databasePromise = null; resolve(null); };
    request.onblocked = () => { available = false; resolve(null); };
  });
  return databasePromise;
}

export async function readCached(key) {
  if (!enabled) return null;
  try {
    const database = await openDatabase();
    if (!database) return null;
    return await new Promise(resolve => {
      const transaction = database.transaction(['data', 'metadata'], 'readwrite');
      const request = transaction.objectStore('data').get(`${CACHE_VERSION}:${key}`);
      const metadata = transaction.objectStore('metadata');
      const details = metadata.get(`${CACHE_VERSION}:${key}`);
      let value = null;
      request.onsuccess = () => { value = request.result ?? null; };
      details.onsuccess = () => {
        if (details.result) metadata.put({ ...details.result, used: Date.now() });
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () => { available = false; resolve(null); };
    });
  } catch { available = false; return null; }
}

export async function writeCached(key, value, kind, bytes) {
  if (!enabled || bytes > MAX_CACHE_BYTES) return false;
  try {
    const database = await openDatabase();
    if (!database) return false;
    return await new Promise(resolve => {
      const transaction = database.transaction(['data', 'metadata'], 'readwrite');
      const data = transaction.objectStore('data');
      const metadata = transaction.objectStore('metadata');
      const fullKey = `${CACHE_VERSION}:${key}`;
      const request = metadata.getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(entry => entry.key !== fullKey).sort((first, second) => first.used - second.used);
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0) + bytes;
        for (const entry of entries) {
          if (total <= MAX_CACHE_BYTES) break;
          data.delete(entry.key); metadata.delete(entry.key); total -= entry.bytes;
        }
        data.put(value, fullKey);
        metadata.put({ key: fullKey, kind, bytes, used: Date.now() });
      };
      transaction.oncomplete = () => { available = true; resolve(true); };
      transaction.onerror = transaction.onabort = () => { available = false; resolve(false); };
    });
  } catch { available = false; return false; }
}

export async function cacheStats() {
  try {
    const database = await openDatabase();
    if (!database) return { available: false, bytes: 0, tiles: 0, models: 0, watersheds: 0 };
    return await new Promise(resolve => {
      const transaction = database.transaction('metadata');
      const request = transaction.objectStore('metadata').getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(entry => entry.key.startsWith(`${CACHE_VERSION}:`));
        resolve({ available, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), tiles: entries.filter(entry => entry.kind === 'tile').length, models: entries.filter(entry => entry.kind === 'model').length, watersheds: entries.filter(entry => entry.kind === 'watershed').length });
      };
      request.onerror = () => resolve({ available: false, bytes: 0, tiles: 0, models: 0, watersheds: 0 });
    });
  } catch { return { available: false, bytes: 0, tiles: 0, models: 0, watersheds: 0 }; }
}

export async function clearCache() {
  const database = await openDatabase();
  if (!database) return false;
  return new Promise(resolve => {
    const transaction = database.transaction(['data', 'metadata'], 'readwrite');
    transaction.objectStore('data').clear(); transaction.objectStore('metadata').clear();
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = transaction.onabort = () => resolve(false);
  });
}