const DATABASE = 'agan-im-analysis-collections';
let databasePromise;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!databasePromise) databasePromise = new Promise(resolve => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('collections')) request.result.createObjectStore('collections', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => { databasePromise = null; resolve(null); };
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

export async function listAnalysisCollections() {
  const database = await openDatabase();
  if (!database) return [];
  return new Promise(resolve => {
    const request = database.transaction('collections').objectStore('collections').getAll();
    request.onsuccess = () => resolve(request.result.sort((first, second) => second.savedAt - first.savedAt));
    request.onerror = () => resolve([]);
  });
}

export async function saveAnalysisCollection(name, analyses) {
  const database = await openDatabase();
  if (!database) throw new Error('Local collection storage is unavailable.');
  const collection = {
    id: globalThis.crypto?.randomUUID?.() || `collection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: name.trim().slice(0, 60),
    savedAt: Date.now(),
    analyses: analyses.map(({ mask, model, ...analysis }) => ({ ...analysis, modelKey: model?.key || null })),
  };
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('collections', 'readwrite');
    transaction.objectStore('collections').put(collection);
    transaction.oncomplete = () => resolve(collection);
    transaction.onerror = transaction.onabort = () => reject(new Error('The collection could not be saved in browser storage.'));
  });
}

export async function deleteAnalysisCollection(id) {
  const database = await openDatabase();
  if (!database) return false;
  return new Promise(resolve => {
    const transaction = database.transaction('collections', 'readwrite');
    transaction.objectStore('collections').delete(id);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = transaction.onabort = () => resolve(false);
  });
}
