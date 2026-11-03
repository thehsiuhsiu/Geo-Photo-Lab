// 備份檔：以密碼加密（PBKDF2 + AES-GCM）的單一檔案，匯入時與本機資料合併
import * as db from './db.js';

const MAGIC = new TextEncoder().encode('GPL1');
const ITERATIONS = 250000;

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 產生加密的備份檔（File） */
export async function createBackup(password) {
  const [spots, photos, tombstones] = await Promise.all([db.getAllSpots(), db.getAllPhotos(), db.getAllTombstones()]);
  const photoData = [];
  for (const p of photos) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    photoData.push({ id: p.id, spotId: p.spotId, type: p.blob.type || 'image/jpeg', data: bytesToBase64(bytes) });
  }
  const payload = { app: 'geo-photo-lab', version: 1, exportedAt: Date.now(), spots, photos: photoData, tombstones };
  const plain = new TextEncoder().encode(JSON.stringify(payload));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));

  const out = new Uint8Array(MAGIC.length + salt.length + iv.length + cipher.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(cipher, 32);

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `定點照片備份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gpbak`;
  return { file: new File([out], name, { type: 'application/octet-stream' }), spotCount: spots.length, photoCount: photos.length };
}

/** 解密備份檔，回傳內容；密碼錯誤時丟出錯誤 */
export async function readBackup(file, password) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const magic = new TextDecoder().decode(buf.subarray(0, 4));
  if (magic !== 'GPL1') throw new Error('這不是定點照片的備份檔');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const key = await deriveKey(password, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf.subarray(32));
  } catch {
    throw new Error('密碼錯誤，或備份檔已損壞');
  }
  const data = JSON.parse(new TextDecoder().decode(plain));
  if (data.app !== 'geo-photo-lab') throw new Error('這不是定點照片的備份檔');
  return data;
}

/**
 * 合併：同一定點以 updatedAt 較新的為準；本機刪除較晚的不復活；備份裡刪除較晚的會刪掉本機。
 * @returns {{added:number, updated:number, kept:number, removed:number}}
 */
export async function mergeBackup(data) {
  const [localSpots, localTombs] = await Promise.all([db.getAllSpots(), db.getAllTombstones()]);
  const localById = new Map(localSpots.map((s) => [s.id, s]));
  const tombById = new Map(localTombs.map((t) => [t.id, t]));
  const photosBySpot = new Map();
  for (const p of data.photos) {
    if (!photosBySpot.has(p.spotId)) photosBySpot.set(p.spotId, []);
    photosBySpot.get(p.spotId).push(p);
  }

  const ops = { spots: [], photos: [], deletePhotoIds: [], deleteSpotIds: [], tombstones: [] };
  const result = { added: 0, updated: 0, kept: 0, removed: 0 };

  for (const s of data.spots) {
    const local = localById.get(s.id);
    const tomb = tombById.get(s.id);
    if (!local && tomb && tomb.deletedAt >= s.updatedAt) { result.kept++; continue; }
    if (local && local.updatedAt >= s.updatedAt) { result.kept++; continue; }
    if (local) {
      for (const pid of local.photoIds || []) if (!(s.photoIds || []).includes(pid)) ops.deletePhotoIds.push(pid);
      result.updated++;
    } else {
      result.added++;
    }
    ops.spots.push(s);
    for (const p of photosBySpot.get(s.id) || []) {
      ops.photos.push({ id: p.id, spotId: p.spotId, blob: new Blob([base64ToBytes(p.data)], { type: p.type }) });
    }
  }

  for (const t of data.tombstones || []) {
    const local = localById.get(t.id);
    if (local && t.deletedAt > local.updatedAt) {
      ops.deleteSpotIds.push(t.id);
      for (const pid of local.photoIds || []) ops.deletePhotoIds.push(pid);
      result.removed++;
    }
    const lt = tombById.get(t.id);
    if (!local || t.deletedAt > local.updatedAt) {
      if (!lt || t.deletedAt > lt.deletedAt) ops.tombstones.push(t);
    }
  }

  await db.applyImport(ops);
  return result;
}
