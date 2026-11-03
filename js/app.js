import * as db from './db.js';
import { createBackup, readBackup, mergeBackup } from './backup.js';
import { distance, formatDistance, formatDateTime, shrinkPhoto, escapeHtml, isIOS, isStandalone } from './util.js';

const DEFAULT_RADIUS = 20;
const LEAVE_MARGIN = 5; // 已在定點內時，多 5 公尺才算離開，避免邊界上畫面來回跳
const NEAREST_COUNT = 3;
const BACKUP_REMIND_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 1000;

const $ = (id) => document.getElementById(id);

const state = {
  spots: [],
  pos: null, // {lat, lng, accuracy, ts}
  geoError: null,
  currentId: null, // 目前定點
  selectedId: null, // 範圍內多個定點時，手動切換到的那個
  previewId: null, // 範圍外手動預覽的定點
  viewKey: '',
  dirtySince: null,
  lastBackupAt: null,
  wakeEnabled: true,
};

// ---------- 照片網址快取 ----------
const photoUrls = new Map();
async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const p = await db.getPhoto(id);
  if (!p) return null;
  const url = URL.createObjectURL(p.blob);
  photoUrls.set(id, url);
  return url;
}
function forgetPhotoUrls() {
  for (const url of photoUrls.values()) URL.revokeObjectURL(url);
  photoUrls.clear();
}

// ---------- 提示 ----------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- 資料 ----------
async function loadSpots() {
  state.spots = await db.getAllSpots();
  state.dirtySince = await db.getMeta('dirtySince');
  state.lastBackupAt = await db.getMeta('lastBackupAt');
  state.viewKey = '';
  render();
}

function spotDistance(s) {
  if (!state.pos) return null;
  return distance(state.pos.lat, state.pos.lng, s.lat, s.lng);
}

// ---------- 定位 ----------
let watchId = null;
function startWatch() {
  if (!('geolocation' in navigator)) {
    state.geoError = '這個瀏覽器不支援定位';
    render();
    return;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() };
      state.geoError = null;
      render();
    },
    (err) => {
      if (err.code === 1) state.geoError = '定位權限被拒絕。請到 iPhone「設定 › 隱私權與安全性 › 定位服務」允許 Safari 網站使用定位，再重新開啟。';
      else if (err.code === 3) state.geoError = null; // 逾時：繼續等
      else state.geoError = '暫時無法取得位置，請移到空曠處。';
      render();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

// ---------- 螢幕常亮 ----------
let wakeLock = null;
async function applyWakeLock() {
  const supported = 'wakeLock' in navigator;
  $('sWakeHint').textContent = supported ? '' : '這支手機的瀏覽器不支援，請升級 iOS 或調整「自動鎖定」時間。';
  if (!supported) return;
  if (state.wakeEnabled && document.visibilityState === 'visible') {
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  } else if (wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ---------- 畫面：主畫面 ----------
function computeView() {
  if (state.previewId) {
    const s = state.spots.find((x) => x.id === state.previewId);
    if (s) return { mode: 'preview', spot: s, others: [] };
    state.previewId = null;
  }
  if (!state.spots.length) return { mode: 'empty' };
  if (!state.pos) return { mode: 'waiting' };

  const withD = state.spots.map((s) => ({ s, d: spotDistance(s) })).sort((a, b) => a.d - b.d);
  const inRange = withD.filter(({ s, d }) => d <= s.radius + (s.id === state.currentId ? LEAVE_MARGIN : 0));
  if (inRange.length) {
    let cur = inRange.find((x) => x.s.id === state.selectedId) || inRange[0];
    if (!inRange.some((x) => x.s.id === state.selectedId)) state.selectedId = null;
    state.currentId = cur.s.id;
    return { mode: 'here', spot: cur.s, others: inRange.filter((x) => x !== cur).map((x) => x.s) };
  }
  state.currentId = null;
  state.selectedId = null;
  return { mode: 'away', nearest: withD.slice(0, NEAREST_COUNT).map((x) => x.s) };
}

function render() {
  renderStatus();
  renderBanners();
  const v = computeView();
  const key = [v.mode, v.spot?.id, v.spot?.updatedAt, (v.others || []).map((s) => s.id).join(','), (v.nearest || []).map((s) => s.id).join(','), state.spots.length].join('|');
  if (key !== state.viewKey) {
    state.viewKey = key;
    renderMain(v);
  }
  updateDistances();
}

function renderStatus() {
  const el = $('gpsStatus');
  if (state.geoError && !state.pos) { el.textContent = '無法定位'; el.className = 'status bad'; return; }
  if (!state.pos) { el.textContent = '定位中…'; el.className = 'status'; return; }
  const acc = Math.round(state.pos.accuracy);
  el.textContent = `誤差 ±${acc} 公尺`;
  el.className = 'status ' + (acc > (currentRadius() ?? DEFAULT_RADIUS) ? 'warn' : 'ok');
}

function currentRadius() {
  const s = state.spots.find((x) => x.id === state.currentId);
  if (s) return s.radius;
  if (!state.pos || !state.spots.length) return null;
  let best = null;
  for (const x of state.spots) {
    const d = spotDistance(x);
    if (!best || d < best.d) best = { d, r: x.radius };
  }
  return best.r;
}

function renderBanners() {
  const out = [];
  if (isIOS && !isStandalone) {
    out.push(`<div class="banner info">請先用 Safari「分享 › 加入主畫面」，之後<b>從主畫面圖示開啟</b>再新增定點。Safari 分頁裡的資料可能被 iPhone 清除，也和主畫面 App 分開。</div>`);
  }
  if (state.geoError) out.push(`<div class="banner bad">${escapeHtml(state.geoError)}</div>`);
  if (state.pos) {
    const r = currentRadius();
    if (r != null && state.pos.accuracy > r) {
      out.push(`<div class="banner warn">定位誤差 ±${Math.round(state.pos.accuracy)} 公尺，比觸發半徑 ${r} 公尺還大，顯示的定點可能不準。</div>`);
    }
    if (Date.now() - state.pos.ts > STALE_MS) {
      out.push(`<div class="banner warn">位置已 ${Math.round((Date.now() - state.pos.ts) / 1000)} 秒沒有更新。</div>`);
    }
  }
  if (state.dirtySince && Date.now() - state.dirtySince > BACKUP_REMIND_MS) {
    out.push(`<div class="banner info">定點有變更，已超過 7 天沒備份。<button class="link" data-open-settings>去備份</button></div>`);
  }
  const html = out.join('');
  const box = $('banners');
  if (box.innerHTML !== html) box.innerHTML = html;
}

function renderMain(v) {
  const main = $('main');
  if (v.mode === 'empty') {
    main.innerHTML = `<div class="empty"><p class="big">還沒有任何定點</p><p>站在現場按「用目前位置新增」，或用地圖選點新增。</p></div>`;
    return;
  }
  if (v.mode === 'waiting') {
    main.innerHTML = `<div class="empty"><p class="big">正在取得位置…</p><p>第一次使用請允許定位。</p></div>`;
    return;
  }
  if (v.mode === 'away') {
    main.innerHTML = `
      <div class="away">
        <p class="away-title">不在任何定點範圍內</p>
        <p class="hint">最近的定點（點一下先看照片）</p>
        <ul class="spot-list">${v.nearest.map(spotRow).join('')}</ul>
      </div>`;
    main.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => {
      state.previewId = b.dataset.preview;
      render();
      window.scrollTo(0, 0);
    }));
    return;
  }
  // here / preview
  const s = v.spot;
  const others = v.others.length
    ? `<div class="others"><span>也在範圍內：</span>${v.others.map((o) => `<button class="chip" data-select="${o.id}">${escapeHtml(o.name)}</button>`).join('')}</div>`
    : '';
  const previewBar = v.mode === 'preview'
    ? `<div class="preview-bar">預覽中（不一定在現場）<button class="btn small" id="endPreview">回到自動顯示</button></div>`
    : '';
  main.innerHTML = `
    ${previewBar}
    <article class="spot-view ${v.mode}">
      <div class="spot-head">
        <div>
          <h2>${escapeHtml(s.name)}</h2>
          <span class="dist" data-dist-for="${s.id}"></span>
        </div>
        <button class="btn small" data-edit="${s.id}">編輯</button>
      </div>
      ${others}
      ${s.note ? `<p class="note">${escapeHtml(s.note)}</p>` : ''}
      <div class="gallery" id="gallery">${(s.photoIds || []).length ? '' : '<p class="hint">這個定點還沒有參考照片。</p>'}</div>
    </article>`;
  main.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => {
    state.selectedId = b.dataset.select;
    render();
    window.scrollTo(0, 0);
  }));
  $('endPreview')?.addEventListener('click', () => { state.previewId = null; render(); });
  main.querySelector('[data-edit]').addEventListener('click', () => openEditor(s));
  fillGallery(s);
}

async function fillGallery(s) {
  const gallery = $('gallery');
  const ids = s.photoIds || [];
  const urls = [];
  for (const id of ids) {
    const url = await photoUrl(id);
    if (url) urls.push(url);
  }
  if ($('gallery') !== gallery) return; // 畫面已換
  urls.forEach((url, i) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${s.name} 參考照片 ${i + 1}`;
    img.addEventListener('click', () => openViewer(urls, i));
    gallery.appendChild(img);
  });
}

function spotRow(s) {
  return `<li><button class="spot-row" data-preview="${s.id}">
    <span class="name">${escapeHtml(s.name)}</span>
    <span class="dist" data-dist-for="${s.id}"></span>
  </button></li>`;
}

function updateDistances() {
  document.querySelectorAll('[data-dist-for]').forEach((el) => {
    const s = state.spots.find((x) => x.id === el.dataset.distFor);
    const d = s && spotDistance(s);
    el.textContent = d == null ? '' : formatDistance(d);
  });
}

// ---------- 定點清單 ----------
function openSheet(id) { $(id).hidden = false; document.body.classList.add('sheet-open'); }
function closeSheet(id) {
  $(id).hidden = true;
  if (![...document.querySelectorAll('.sheet')].some((s) => !s.hidden)) document.body.classList.remove('sheet-open');
}

function openList() {
  const rows = state.spots
    .map((s) => ({ s, d: spotDistance(s) }))
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.s.name.localeCompare(b.s.name, 'zh-Hant'));
  $('listBody').innerHTML = rows.length
    ? `<ul class="spot-list">${rows.map(({ s, d }) => `<li><button class="spot-row" data-edit="${s.id}">
        <span class="name">${escapeHtml(s.name)}<small>${(s.photoIds || []).length} 張照片・半徑 ${s.radius} 公尺</small></span>
        <span class="dist">${d == null ? '' : formatDistance(d)}</span>
      </button></li>`).join('')}</ul>`
    : '<p class="hint center">還沒有任何定點。</p>';
  $('listBody').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const s = state.spots.find((x) => x.id === b.dataset.edit);
    if (s) openEditor(s);
  }));
  openSheet('listSheet');
}

// ---------- 編輯定點 ----------
let draft = null;

function openEditor(spot, presetPos) {
  if (spot) {
    draft = {
      isNew: false,
      original: spot,
      lat: spot.lat, lng: spot.lng,
      photos: (spot.photoIds || []).map((id) => ({ id, isNew: false })),
      removed: [],
    };
    $('fName').value = spot.name;
    $('fRadius').value = spot.radius;
    $('fNote').value = spot.note || '';
  } else {
    draft = { isNew: true, original: null, lat: presetPos.lat, lng: presetPos.lng, accuracy: presetPos.accuracy, photos: [], removed: [] };
    $('fName').value = '';
    $('fRadius').value = DEFAULT_RADIUS;
    $('fNote').value = '';
  }
  $('editTitle').textContent = spot ? '編輯定點' : '新增定點';
  $('editDelete').hidden = !spot;
  $('fPhotoHint').textContent = '';
  renderDraftCoord();
  renderDraftPhotos();
  openSheet('editSheet');
}

function renderDraftCoord() {
  const acc = draft.accuracy ? `（定位誤差 ±${Math.round(draft.accuracy)} 公尺）` : '';
  $('fCoord').textContent = `${draft.lat.toFixed(6)}, ${draft.lng.toFixed(6)} ${acc}`;
}

async function renderDraftPhotos() {
  const box = $('fPhotos');
  const items = [];
  for (const [i, p] of draft.photos.entries()) {
    const url = p.isNew ? p.url : await photoUrl(p.id);
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    wrap.innerHTML = `<img src="${url}" alt=""><button type="button" class="thumb-del" aria-label="移除這張">✕</button>`;
    wrap.querySelector('button').addEventListener('click', () => {
      const [removed] = draft.photos.splice(i, 1);
      if (removed.isNew) URL.revokeObjectURL(removed.url);
      else draft.removed.push(removed.id);
      renderDraftPhotos();
    });
    items.push(wrap);
  }
  box.replaceChildren(...items);
}

async function addDraftFiles(files) {
  const hint = $('fPhotoHint');
  let done = 0;
  for (const f of files) {
    hint.textContent = `處理照片中… ${done + 1}/${files.length}`;
    try {
      const blob = await shrinkPhoto(f);
      draft.photos.push({ id: db.newId(), isNew: true, blob, url: URL.createObjectURL(blob) });
    } catch {
      toast(`有一張照片無法讀取：${f.name}`);
    }
    done++;
  }
  hint.textContent = '';
  renderDraftPhotos();
}

function discardDraft() {
  if (draft) for (const p of draft.photos) if (p.isNew) URL.revokeObjectURL(p.url);
  draft = null;
  closeSheet('editSheet');
}

async function saveDraft(e) {
  e.preventDefault();
  const name = $('fName').value.trim();
  const radius = Math.round(Number($('fRadius').value));
  if (!name) { toast('請輸入名稱'); return; }
  if (!(radius >= 5 && radius <= 1000)) { toast('觸發半徑請填 5～1000 公尺'); return; }
  const now = Date.now();
  const o = draft.original;
  const spot = {
    id: o ? o.id : db.newId(),
    name,
    lat: draft.lat,
    lng: draft.lng,
    radius,
    note: $('fNote').value.trim(),
    photoIds: draft.photos.map((p) => p.id),
    createdAt: o ? o.createdAt : now,
    updatedAt: now,
  };
  const newPhotos = draft.photos.filter((p) => p.isNew).map((p) => ({ id: p.id, blob: p.blob }));
  try {
    await db.saveSpot(spot, newPhotos, draft.removed);
  } catch (err) {
    toast('儲存失敗：' + (err?.message || '手機空間可能不足'));
    return;
  }
  for (const p of draft.photos) if (p.isNew) { photoUrls.set(p.id, p.url); }
  for (const id of draft.removed) { const u = photoUrls.get(id); if (u) URL.revokeObjectURL(u); photoUrls.delete(id); }
  draft = null;
  closeSheet('editSheet');
  closeSheet('listSheet');
  toast('已儲存');
  await loadSpots();
}

async function deleteDraftSpot() {
  const s = draft?.original;
  if (!s) return;
  if (!confirm(`確定刪除「${s.name}」和它的照片？`)) return;
  await db.deleteSpot(s.id);
  discardDraft();
  closeSheet('listSheet');
  if (state.previewId === s.id) state.previewId = null;
  toast('已刪除');
  await loadSpots();
}

// ---------- 地圖選點 ----------
let map = null;
let mapLayer = null;
let mapResolve = null;

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true, attributionControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
}

function pickOnMap(initial) {
  openSheet('mapSheet');
  ensureMap();
  mapLayer.clearLayers();
  for (const s of state.spots) {
    L.circle([s.lat, s.lng], { radius: s.radius, color: '#2f6f5e', weight: 2, fillOpacity: 0.15 })
      .bindTooltip(s.name).addTo(mapLayer);
  }
  if (state.pos) {
    L.circleMarker([state.pos.lat, state.pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(mapLayer);
  }
  const start = initial || state.pos || { lat: 23.7, lng: 121 };
  setTimeout(() => {
    map.invalidateSize();
    map.setView([start.lat, start.lng], initial || state.pos ? 18 : 7);
  }, 50);
  return new Promise((resolve) => { mapResolve = resolve; });
}

function finishMap(result) {
  closeSheet('mapSheet');
  if (mapResolve) { mapResolve(result); mapResolve = null; }
}

// ---------- 看大圖 ----------
let viewer = { urls: [], i: 0 };
function openViewer(urls, i) {
  viewer = { urls, i };
  showViewer();
  $('viewer').hidden = false;
}
function showViewer() {
  $('viewerImg').src = viewer.urls[viewer.i];
  $('viewerCount').textContent = `${viewer.i + 1} / ${viewer.urls.length}`;
  $('viewerPrev').hidden = viewer.i === 0;
  $('viewerNext').hidden = viewer.i === viewer.urls.length - 1;
}
function stepViewer(n) {
  const j = viewer.i + n;
  if (j < 0 || j >= viewer.urls.length) return;
  viewer.i = j;
  showViewer();
}

// ---------- 設定與備份 ----------
let exportFile = null;
let exportUrl = null;

function openSettings() {
  $('sWake').checked = state.wakeEnabled;
  $('sLastBackup').textContent = formatDateTime(state.lastBackupAt);
  $('exportResult').hidden = true;
  $('importResult').textContent = '';
  openSheet('settingsSheet');
}

async function onExport(e) {
  e.preventDefault();
  const p1 = $('ePass1').value;
  const p2 = $('ePass2').value;
  if (p1.length < 4) { toast('密碼至少 4 個字'); return; }
  if (p1 !== p2) { toast('兩次密碼不一樣'); return; }
  const btn = e.submitter || $('exportForm').querySelector('button');
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const { file, spotCount, photoCount } = await createBackup(p1);
    exportFile = file;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(file);
    $('exportDownload').href = exportUrl;
    $('exportDownload').download = file.name;
    $('exportInfo').textContent = `已產生：${spotCount} 個定點、${photoCount} 張照片（${(file.size / 1024 / 1024).toFixed(1)} MB）。請存到「檔案」App 或其他安全的地方。`;
    $('exportResult').hidden = false;
    $('ePass1').value = '';
    $('ePass2').value = '';
  } catch (err) {
    toast('備份失敗：' + (err?.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = '產生備份檔';
  }
}

async function markExported() {
  await db.markBackedUp();
  state.dirtySince = null;
  state.lastBackupAt = Date.now();
  $('sLastBackup').textContent = formatDateTime(state.lastBackupAt);
  render();
}

async function onShareExport() {
  if (!exportFile) return;
  if (navigator.canShare && navigator.canShare({ files: [exportFile] })) {
    try {
      await navigator.share({ files: [exportFile] });
      await markExported();
      toast('備份完成');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('無法分享，請改按「下載」');
    }
  } else {
    $('exportDownload').click();
  }
}

async function onImport(e) {
  e.preventDefault();
  const file = $('iFile').files[0];
  const pass = $('iPass').value;
  if (!file) return;
  const out = $('importResult');
  out.textContent = '匯入中…';
  try {
    const data = await readBackup(file, pass);
    const r = await mergeBackup(data);
    forgetPhotoUrls();
    out.textContent = `完成：新增 ${r.added}、更新 ${r.updated}、保留手機版本 ${r.kept}、刪除 ${r.removed} 個定點。`;
    $('iPass').value = '';
    $('iFile').value = '';
    await loadSpots();
  } catch (err) {
    out.textContent = err?.message || '匯入失敗';
  }
}

// ---------- 事件 ----------
function bind() {
  $('btnList').addEventListener('click', openList);
  $('btnSettings').addEventListener('click', openSettings);
  $('banners').addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSettings(); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.closest('.sheet').id)));

  $('btnAddHere').addEventListener('click', () => {
    if (!state.pos) { toast('還沒取得位置，請稍候'); return; }
    openEditor(null, state.pos);
  });
  $('btnAddMap').addEventListener('click', async () => {
    const p = await pickOnMap(null);
    if (p) openEditor(null, p);
  });

  $('editForm').addEventListener('submit', saveDraft);
  $('editCancel').addEventListener('click', discardDraft);
  $('editDelete').addEventListener('click', deleteDraftSpot);
  $('fUseHere').addEventListener('click', () => {
    if (!state.pos) { toast('還沒取得位置'); return; }
    draft.lat = state.pos.lat; draft.lng = state.pos.lng; draft.accuracy = state.pos.accuracy;
    renderDraftCoord();
  });
  $('fUseMap').addEventListener('click', async () => {
    const p = await pickOnMap({ lat: draft.lat, lng: draft.lng });
    if (p && draft) { draft.lat = p.lat; draft.lng = p.lng; draft.accuracy = null; renderDraftCoord(); }
  });
  $('fFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await addDraftFiles(files);
  });

  $('mapCancel').addEventListener('click', () => finishMap(null));
  $('mapConfirm').addEventListener('click', () => {
    const c = map.getCenter();
    finishMap({ lat: c.lat, lng: c.lng });
  });
  $('mapLocate').addEventListener('click', () => {
    if (state.pos) map.setView([state.pos.lat, state.pos.lng], 18);
    else toast('還沒取得位置');
  });

  $('viewerClose').addEventListener('click', () => { $('viewer').hidden = true; });
  $('viewerPrev').addEventListener('click', () => stepViewer(-1));
  $('viewerNext').addEventListener('click', () => stepViewer(1));
  let touchX = null;
  $('viewer').addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('viewer').addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
    touchX = null;
  });

  $('sWake').addEventListener('change', async (e) => {
    state.wakeEnabled = e.target.checked;
    await db.setMeta('wakeEnabled', state.wakeEnabled);
    applyWakeLock();
  });
  $('exportForm').addEventListener('submit', onExport);
  $('exportShare').addEventListener('click', onShareExport);
  $('exportDownload').addEventListener('click', () => { markExported(); });
  $('importForm').addEventListener('submit', onImport);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startWatch();
      applyWakeLock();
      render();
    }
  });
  setInterval(render, 5000); // 更新「多久沒更新」與備份提醒
}

async function init() {
  bind();
  state.wakeEnabled = await db.getMeta('wakeEnabled', true);
  await loadSpots();
  startWatch();
  applyWakeLock();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
