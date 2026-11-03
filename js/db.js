// 本機資料庫（IndexedDB）：定點、參考照片、刪除紀錄、設定
const DB_NAME = 'geo-photo-lab';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('spots')) db.createObjectStore('spots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('spotId', 'spotId');
      }
      // 刪除紀錄：匯入舊備份時，避免已刪除的定點又跑回來
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('交易中止'));
  });
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function getAllSpots() {
  const db = await open();
  return reqP(db.transaction('spots').objectStore('spots').getAll());
}

export async function getSpot(id) {
  const db = await open();
  return reqP(db.transaction('spots').objectStore('spots').get(id));
}

export async function getPhoto(id) {
  const db = await open();
  return reqP(db.transaction('photos').objectStore('photos').get(id));
}

export async function getAllPhotos() {
  const db = await open();
  return reqP(db.transaction('photos').objectStore('photos').getAll());
}

export async function getAllTombstones() {
  const db = await open();
  return reqP(db.transaction('tombstones').objectStore('tombstones').getAll());
}

/**
 * 儲存定點：一併寫入新照片、刪除移除的照片。
 * @param {object} spot
 * @param {{id:string, blob:Blob}[]} newPhotos
 * @param {string[]} removedPhotoIds
 */
export async function saveSpot(spot, newPhotos = [], removedPhotoIds = []) {
  const db = await open();
  const tx = db.transaction(['spots', 'photos', 'tombstones'], 'readwrite');
  tx.objectStore('spots').put(spot);
  const ps = tx.objectStore('photos');
  for (const p of newPhotos) ps.put({ id: p.id, spotId: spot.id, blob: p.blob });
  for (const id of removedPhotoIds) ps.delete(id);
  tx.objectStore('tombstones').delete(spot.id);
  await txDone(tx);
  await markDirty();
}

export async function deleteSpot(id) {
  const db = await open();
  const tx = db.transaction(['spots', 'photos', 'tombstones'], 'readwrite');
  const spot = await reqP(tx.objectStore('spots').get(id));
  if (spot) for (const pid of spot.photoIds || []) tx.objectStore('photos').delete(pid);
  tx.objectStore('spots').delete(id);
  tx.objectStore('tombstones').put({ id, deletedAt: Date.now() });
  await txDone(tx);
  await markDirty();
}

/**
 * 匯入時以單一交易套用合併結果。
 * @param {{spots:object[], photos:{id,spotId,blob}[], deletePhotoIds:string[], deleteSpotIds:string[], tombstones:object[]}} ops
 */
export async function applyImport(ops) {
  const db = await open();
  const tx = db.transaction(['spots', 'photos', 'tombstones'], 'readwrite');
  const ss = tx.objectStore('spots');
  const ps = tx.objectStore('photos');
  const ts = tx.objectStore('tombstones');
  for (const id of ops.deletePhotoIds) ps.delete(id);
  for (const id of ops.deleteSpotIds) ss.delete(id);
  for (const s of ops.spots) { ss.put(s); ts.delete(s.id); }
  for (const p of ops.photos) ps.put(p);
  for (const t of ops.tombstones) ts.put(t);
  await txDone(tx);
}

export async function getMeta(key, fallback = null) {
  const db = await open();
  const v = await reqP(db.transaction('meta').objectStore('meta').get(key));
  return v === undefined ? fallback : v;
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await txDone(tx);
}

// 「未備份的變更」從何時開始；匯出備份後清除
async function markDirty() {
  const since = await getMeta('dirtySince');
  if (!since) await setMeta('dirtySince', Date.now());
}

export async function markBackedUp() {
  await setMeta('dirtySince', null);
  await setMeta('lastBackupAt', Date.now());
}
