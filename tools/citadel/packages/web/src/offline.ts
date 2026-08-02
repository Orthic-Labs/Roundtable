import type { QueuedWrite, Snapshot } from './types';

const DB = 'roundtable-pwa';
const VERSION = 1;
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'request_id' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(store: 'queue' | 'cache', mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
export const offlineStore = {
  enqueue: (write: QueuedWrite) => transaction('queue', 'readwrite', store => store.put(write)),
  remove: (requestId: string) => transaction('queue', 'readwrite', store => store.delete(requestId)),
  list: async () => (await transaction<QueuedWrite[]>('queue', 'readonly', store => store.getAll())).sort((a, b) => a.created_at_ms - b.created_at_ms),
  saveSnapshot: (snapshot: Snapshot) => transaction('cache', 'readwrite', store => store.put(snapshot, 'snapshot')),
  loadSnapshot: () => transaction<Snapshot | undefined>('cache', 'readonly', store => store.get('snapshot')),
};
