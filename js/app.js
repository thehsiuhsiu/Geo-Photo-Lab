import * as db from './db.js';
import { createBackup, readBackup, mergeBackup } from './backup.js';
import { distance, formatDistance, formatDateTime, shrinkPhoto, escapeHtml, isIOS, isStandalone } from './util.js';

const DEFAULT_RADIUS = 20;
const LEAVE_MARGIN = 5; // 已在定點內時，多 5 公尺才算離開，避免邊界上畫面來回跳
const NEAREST_COUNT = 3;
const BACKUP_REMIND_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 1000;
const MAX_SWITCH_ACCURACY = 50; // 定位誤差超過這個公尺數，不拿來切換定點

const $ = (id) => document.getElementById(id);

// ---------- 圖示（SF Symbols 風格線條） ----------
const svg = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  list: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  chevron: '<svg class="chev" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>',
  chevronSm: svg('<path d="M9 6l6 6-6 6"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  plusCircle: svg('<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><line x1="12" y1="7.5" x2="12" y2="16.5" stroke="#fff"/><line x1="7.5" y1="12" x2="16.5" y2="12" stroke="#fff"/>'),
  more: svg('<circle cx="12" cy="12" r="10"/><circle cx="8" cy="12" r=".8" fill="currentColor"/><circle cx="12" cy="12" r=".8" fill="currentColor"/><circle cx="16" cy="12" r=".8" fill="currentColor"/>'),
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  x: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', '0 0 24 24'),
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-9 8"/>'),
  camera: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  locate: svg('<path d="M3 11l18-8-8 18-2-8z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
};

const state = {
  spots: [],
  lists: [],
  activeListIds: new Set(), // 觸發清單
  pos: null, // {lat, lng, accuracy, ts}
  geoError: null,
  currentId: null, // 目前定點
  selectedId: null, // 範圍內多個定點時，手動切換到的那個
  previewId: null, // 範圍外手動預覽的定點
  decided: false, // 是否已用夠準的定位判斷過一次
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

// ---------- 提示、選單、對話框 ----------
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/** iOS 風格動作選單；回傳被選的項目 value，取消回傳 null */
function chooseAction(title, items) {
  return new Promise((resolve) => {
    const sheet = $('actionSheet');
    const group = $('actionGroup');
    group.innerHTML = (title ? `<div class="action-title">${escapeHtml(title)}</div>` : '')
      + items.map((it, i) => `<button class="action-btn ${it.danger ? 'danger' : ''}" data-i="${i}">${escapeHtml(it.label)}</button>`).join('');
    const done = (v) => {
      sheet.hidden = true;
      sheet.onclick = null;
      resolve(v);
    };
    sheet.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b) done(items[Number(b.dataset.i)].value);
      else if (e.target === sheet || e.target.id === 'actionCancel') done(null);
    };
    sheet.hidden = false;
  });
}

function confirmDanger(message, label) {
  return chooseAction(message, [{ label, value: true, danger: true }]).then((v) => v === true);
}

/** 輸入文字的對話框；取消回傳 null */
function askText(title, value) {
  return new Promise((resolve) => {
    const dlg = $('textDialog');
    const input = $('textInput');
    $('textTitle').textContent = title;
    input.value = value;
    dlg.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const done = (v) => {
      dlg.hidden = true;
      $('textForm').onsubmit = null;
      $('textCancel').onclick = null;
      resolve(v);
    };
    $('textForm').onsubmit = (e) => { e.preventDefault(); done(input.value.trim()); };
    $('textCancel').onclick = () => done(null);
  });
}

// ---------- 資料 ----------
async function loadSpots() {
  state.lists = await db.getAllLists();
  if (!state.lists.length) {
    const now = Date.now();
    const l = { id: db.newId(), name: '清單1', createdAt: now, updatedAt: now };
    await db.saveList(l);
    state.lists = [l];
  }
  state.lists.sort((a, b) => a.createdAt - b.createdAt);
  const listIds = new Set(state.lists.map((l) => l.id));
  state.activeListIds = new Set((await db.getMeta('activeListIds', [])).filter((id) => listIds.has(id)));
  state.spots = await db.getAllSpots();
  // 修正：清單不存在就拿掉；一個都沒有就放進第一個清單
  const fixes = [];
  for (const s of state.spots) {
    const ids = (s.listIds || []).filter((id) => listIds.has(id));
    if (!ids.length) ids.push(state.lists[0].id);
    if (ids.length !== (s.listIds || []).length || ids.some((id, i) => id !== s.listIds[i])) { s.listIds = ids; fixes.push(s); }
  }
  if (fixes.length) await db.putSpotsRaw(fixes);
  state.dirtySince = await db.getMeta('dirtySince');
  state.lastBackupAt = await db.getMeta('lastBackupAt');
  state.viewKey = '';
  render();
  if (!$('manageSheet').hidden) renderManage();
}

function activeSpots() {
  return state.spots.filter((s) => s.listIds.some((id) => state.activeListIds.has(id)));
}

async function saveActive() {
  await db.setMeta('activeListIds', [...state.activeListIds]);
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
  if (!supported) {
    $('sWakeHint').textContent = '這支手機的瀏覽器不支援，請升級 iOS，或到 iPhone 設定調整「自動鎖定」時間。';
    return;
  }
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

// ---------- 外觀（自動／淺色／深色） ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function getThemePref() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme() {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeColor')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.classList.toggle('on', b.dataset.themeOpt === pref));
}
function setTheme(pref) {
  try { localStorage.setItem('theme', pref); } catch { /* 無法儲存就只套用這次 */ }
  applyTheme();
}

// ---------- 主畫面 ----------
function isReliable() {
  return !!state.pos && state.pos.accuracy <= MAX_SWITCH_ACCURACY;
}

function computeView() {
  if (state.previewId) {
    const s = state.spots.find((x) => x.id === state.previewId);
    if (s) return { mode: 'preview', spot: s, others: [] };
    state.previewId = null;
  }
  if (!state.spots.length) return { mode: 'empty' };
  if (!state.activeListIds.size) return { mode: 'paused' };
  const spots = activeSpots();
  if (!spots.length) return { mode: 'noActiveSpots' };
  if (!state.pos) return { mode: 'waiting' };

  const withD = spots.map((s) => ({ s, d: spotDistance(s) })).sort((a, b) => a.d - b.d);
  const inRange = withD.filter(({ s, d }) => d <= s.radius + (s.id === state.currentId ? LEAVE_MARGIN : 0));
  // 誤差太大：維持上一次的判斷，不切換照片
  if (!isReliable() && state.decided) {
    const held = withD.find((x) => x.s.id === state.currentId);
    if (held) return { mode: 'here', spot: held.s, others: inRange.filter((x) => x.s.id !== held.s.id).map((x) => x.s) };
    if (!state.currentId) return { mode: 'away', nearest: withD.slice(0, NEAREST_COUNT).map((x) => x.s) };
  }
  if (isReliable()) state.decided = true;
  if (inRange.length) {
    const cur = inRange.find((x) => x.s.id === state.selectedId) || inRange[0];
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
  renderTriggerPill();
  renderBanners();
  const v = computeView();
  const key = [v.mode, v.spot?.id, v.spot?.updatedAt, (v.others || []).map((s) => s.id).join(','), (v.nearest || []).map((s) => s.id).join(','), state.spots.length, [...state.activeListIds].join(',')].join('|');
  if (key !== state.viewKey) {
    state.viewKey = key;
    renderMain(v);
  }
  updateDistances();
}

function renderTriggerPill() {
  const names = state.lists.filter((l) => state.activeListIds.has(l.id)).map((l) => l.name);
  const text = names.length ? names.join('、') : '已暫停觸發';
  const bar = $('listBar');
  if (bar.dataset.text === text) return;
  bar.dataset.text = text;
  bar.innerHTML = `<span class="dot"></span><span class="txt">${escapeHtml(text)}</span>${ICON.chevronSm}`;
  bar.classList.toggle('paused', !names.length);
}

function currentRadius() {
  const s = state.spots.find((x) => x.id === state.currentId);
  if (s) return s.radius;
  const spots = activeSpots();
  if (!state.pos || !spots.length) return null;
  let best = null;
  for (const x of spots) {
    const d = spotDistance(x);
    if (!best || d < best.d) best = { d, r: x.radius };
  }
  return best.r;
}

function renderStatus() {
  const el = $('gpsStatus');
  if (state.geoError && !state.pos) { el.textContent = '無法定位'; el.className = 'status bad'; return; }
  if (!state.pos) { el.textContent = '定位中…'; el.className = 'status'; return; }
  const acc = Math.round(state.pos.accuracy);
  el.textContent = `誤差 ±${acc} 公尺`;
  el.className = 'status ' + (acc > (currentRadius() ?? DEFAULT_RADIUS) ? 'warn' : 'ok');
}

function renderBanners() {
  const out = [];
  if (isIOS && !isStandalone) {
    out.push(`<div class="banner"><span>請先按 Safari 的「分享 › 加入主畫面」，之後<b>從主畫面圖示開啟</b>再新增定點。Safari 分頁裡的資料和主畫面 App 是分開的。</span></div>`);
  }
  if (state.geoError) out.push(`<div class="banner bad"><span>${escapeHtml(state.geoError)}</span></div>`);
  if (state.pos) {
    const r = currentRadius();
    if (!isReliable()) {
      out.push(`<div class="banner warn"><span>定位誤差 ±${Math.round(state.pos.accuracy)} 公尺太大，${state.decided ? '暫時不切換定點' : '顯示的定點可能不準'}。</span></div>`);
    } else if (r != null && state.pos.accuracy > r) {
      out.push(`<div class="banner warn"><span>定位誤差 ±${Math.round(state.pos.accuracy)} 公尺，比觸發半徑 ${r} 公尺大，顯示的定點可能不準。</span></div>`);
    }
    if (Date.now() - state.pos.ts > STALE_MS) {
      out.push(`<div class="banner warn"><span>位置已 ${Math.round((Date.now() - state.pos.ts) / 1000)} 秒沒有更新。</span></div>`);
    }
  }
  if (state.dirtySince && Date.now() - state.dirtySince > BACKUP_REMIND_MS) {
    out.push(`<div class="banner"><span>定點有變更，已超過 7 天沒備份。<button class="link" data-open-settings>去備份</button></span></div>`);
  }
  const html = out.join('');
  const box = $('banners');
  if (box.innerHTML !== html) box.innerHTML = html;
}

function emptyState(icon, title, text, btnLabel) {
  return `<div class="empty"><div class="ico">${icon}</div><h2>${title}</h2><p>${text}</p>${btnLabel ? `<button class="btn-fill" data-manage>${btnLabel}</button>` : ''}</div>`;
}

function renderMain(v) {
  const main = $('main');
  if (v.mode === 'empty') {
    main.innerHTML = emptyState(ICON.pin, '還沒有任何定點', '到「管理」新增清單和定點。', '開始新增定點');
  } else if (v.mode === 'paused') {
    main.innerHTML = emptyState(ICON.pause, '已暫停觸發', '目前沒有勾選任何清單，不會顯示照片。', '選擇觸發清單');
  } else if (v.mode === 'noActiveSpots') {
    main.innerHTML = emptyState(ICON.list, '觸發中的清單沒有定點', '新增定點，或改選其他清單。', '前往管理');
  } else if (v.mode === 'waiting') {
    main.innerHTML = emptyState(ICON.locate, '正在取得位置…', '第一次使用請允許定位。', '');
  } else if (v.mode === 'away') {
    main.innerHTML = `
      <p class="group-title">不在任何定點範圍內・最近的定點</p>
      <div class="group">${v.nearest.map((s) => spotCell(s, `data-preview="${s.id}"`)).join('')}</div>
      <p class="group-foot">點一下可以先看照片。</p>`;
    fillThumbs(main);
  } else {
    renderSpotCard(main, v);
  }
  main.querySelectorAll('[data-manage]').forEach((b) => b.addEventListener('click', openManage));
  main.querySelectorAll('[data-preview]').forEach((b) => b.addEventListener('click', () => {
    state.previewId = b.dataset.preview;
    render();
    window.scrollTo(0, 0);
  }));
}

function spotCell(s, attrs) {
  const n = (s.photoIds || []).length;
  return `<button class="cell spot-cell" ${attrs}>
    ${n ? `<img class="thumb-sm" data-thumb="${s.photoIds[0]}" alt="">` : `<span class="thumb-sm blank">${ICON.photo}</span>`}
    <span class="name">${escapeHtml(s.name)}<small>${n} 張照片</small></span>
    <span class="dist" data-dist-for="${s.id}"></span>
    ${ICON.chevron}
  </button>`;
}

async function fillThumbs(root) {
  for (const img of root.querySelectorAll('img[data-thumb]')) {
    const url = await photoUrl(img.dataset.thumb);
    if (url) img.src = url;
  }
}

function renderSpotCard(main, v) {
  const s = v.spot;
  const ids = s.photoIds || [];
  const preview = v.mode === 'preview';
  main.innerHTML = `
    ${preview ? `<div class="preview-note"><span>預覽中，你不在這個定點</span><button class="btn-tinted" id="endPreview">返回</button></div>` : ''}
    <article class="spot-card">
      ${ids.length ? '<img class="hero" id="heroImg" alt="">' : ''}
      <div class="spot-info">
        <div class="spot-top">
          <div>
            <div class="here-tag ${preview ? 'preview' : ''}">${preview ? '預覽' : '你在這裡'}</div>
            <h2>${escapeHtml(s.name)}</h2>
            <span class="dist" data-dist-for="${s.id}"></span>
          </div>
          <button class="btn-tinted" data-edit="${s.id}">編輯</button>
        </div>
        ${s.note ? `<p class="note">${escapeHtml(s.note)}</p>` : ''}
      </div>
      ${ids.length > 1 ? '<div class="more-photos" id="morePhotos"></div>' : ''}
      ${ids.length ? '' : '<p class="no-photo">這個定點還沒有參考照片。</p>'}
    </article>
    ${v.others.length ? `
      <p class="group-title others-title">也在範圍內・點一下切換</p>
      <div class="group others-group">${v.others.map((o) => spotCell(o, `data-select="${o.id}"`)).join('')}</div>` : ''}`;
  fillThumbs(main);
  main.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => {
    state.selectedId = b.dataset.select;
    render();
    window.scrollTo(0, 0);
  }));
  $('endPreview')?.addEventListener('click', () => { state.previewId = null; render(); });
  main.querySelector('[data-edit]').addEventListener('click', () => openEditor(s));
  fillPhotos(s);
}

async function fillPhotos(s) {
  const hero = $('heroImg');
  if (!hero) return;
  const urls = [];
  for (const id of s.photoIds || []) {
    const url = await photoUrl(id);
    if (url) urls.push(url);
  }
  if ($('heroImg') !== hero || !urls.length) return; // 畫面已換
  hero.src = urls[0];
  hero.alt = `${s.name} 參考照片 1`;
  hero.addEventListener('click', () => openViewer(urls, 0));
  const more = $('morePhotos');
  urls.slice(1).forEach((url, i) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${s.name} 參考照片 ${i + 2}`;
    img.addEventListener('click', () => openViewer(urls, i + 1));
    more?.appendChild(img);
  });
}

function updateDistances() {
  document.querySelectorAll('[data-dist-for]').forEach((el) => {
    const s = state.spots.find((x) => x.id === el.dataset.distFor);
    const d = s && spotDistance(s);
    el.textContent = d == null ? '' : formatDistance(d);
  });
}

// ---------- 全螢幕頁 ----------
function openSheet(id) { $(id).hidden = false; document.body.classList.add('sheet-open'); }
function closeSheet(id) {
  $(id).hidden = true;
  if (![...document.querySelectorAll('.sheet')].some((s) => !s.hidden)) document.body.classList.remove('sheet-open');
}

// ---------- 管理：清單與定點 ----------
function openManage() {
  renderManage();
  openSheet('manageSheet');
}

function renderManage() {
  const body = $('manageBody');
  const scroll = body.scrollTop;
  body.innerHTML = state.lists.map((l) => {
    const spots = state.spots.filter((s) => s.listIds.includes(l.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const on = state.activeListIds.has(l.id);
    return `
      <section class="${on ? '' : 'list-off'}">
        <div class="list-head">
          <h3>${escapeHtml(l.name)}<span class="count">${spots.length}</span></h3>
          <input type="checkbox" class="switch" data-toggle="${l.id}" ${on ? 'checked' : ''} aria-label="觸發「${escapeHtml(l.name)}」">
          <button class="more-btn" data-more="${l.id}" aria-label="清單選項">${ICON.more}</button>
        </div>
        <div class="group">
          ${spots.map((s) => spotCell(s, `data-edit="${s.id}"`)).join('')}
          <button class="cell add-cell" data-add="${l.id}">${ICON.plusCircle}<span>新增定點</span></button>
        </div>
      </section>`;
  }).join('') + `
    <p class="manage-hint">開關打開的清單，裡面的定點才會觸發。</p>
    <div class="group new-list"><button class="cell action-cell" id="btnNewList">${ICON.plusCircle}<span>新增清單</span></button></div>`;
  body.scrollTop = scroll;
  fillThumbs(body);
  updateDistances();

  body.querySelectorAll('[data-toggle]').forEach((i) => i.addEventListener('change', async () => {
    if (i.checked) state.activeListIds.add(i.dataset.toggle); else state.activeListIds.delete(i.dataset.toggle);
    i.closest('section').classList.toggle('list-off', !i.checked);
    await saveActive();
    state.previewId = null;
    render();
  }));
  body.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => listMenu(b.dataset.more)));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const s = state.spots.find((x) => x.id === b.dataset.edit);
    if (s) openEditor(s);
  }));
  body.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addSpot(b.dataset.add)));
  $('btnNewList').addEventListener('click', newList);
}

async function addSpot(listId) {
  const how = await chooseAction('新增定點', [
    { label: '用目前位置', value: 'here' },
    { label: '在地圖上選', value: 'map' },
  ]);
  if (how === 'here') {
    if (!state.pos) { toast('還沒取得位置，請稍候'); return; }
    openEditor(null, state.pos, listId);
  } else if (how === 'map') {
    const p = await pickOnMap(null);
    if (p) openEditor(null, p, listId);
  }
}

async function listMenu(id) {
  const l = state.lists.find((x) => x.id === id);
  if (!l) return;
  const v = await chooseAction(l.name, [
    { label: '重新命名', value: 'rename' },
    { label: '刪除清單', value: 'delete', danger: true },
  ]);
  if (v === 'rename') renameList(l);
  else if (v === 'delete') startDeleteList(l);
}

async function newList() {
  const names = new Set(state.lists.map((l) => l.name));
  let n = state.lists.length + 1;
  while (names.has(`清單${n}`)) n++;
  const name = await askText('新增清單', `清單${n}`);
  if (name == null) return;
  const now = Date.now();
  const l = { id: db.newId(), name: (name || `清單${n}`).slice(0, 30), createdAt: now, updatedAt: now };
  await db.saveList(l);
  state.activeListIds.add(l.id);
  await saveActive();
  await loadSpots();
  $('manageBody').scrollTop = $('manageBody').scrollHeight;
}

async function renameList(l) {
  const name = await askText('重新命名清單', l.name);
  if (!name || name === l.name) return;
  await db.saveList({ ...l, name: name.slice(0, 30), updatedAt: Date.now() });
  await loadSpots();
}

let deletingListId = null;

async function startDeleteList(l) {
  if (state.lists.length === 1) { toast('至少要保留一個清單，可以改名'); return; }
  const only = state.spots.filter((s) => s.listIds.length === 1 && s.listIds[0] === l.id);
  deletingListId = l.id;
  if (!only.length) {
    if (await confirmDanger(`刪除「${l.name}」？裡面的定點還屬於其他清單，不會被刪除。`, '刪除清單')) await doDeleteList('move', null);
    return;
  }
  $('ldInfo').textContent = `「${l.name}」裡有 ${only.length} 個定點只屬於這個清單（${only.slice(0, 5).map((s) => s.name).join('、')}${only.length > 5 ? '…' : ''}），要怎麼處理？`;
  $('ldTarget').innerHTML = state.lists.filter((x) => x.id !== l.id).map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  document.querySelector('input[name=ldMode][value=move]').checked = true;
  syncDeleteMode();
  openSheet('listDeleteSheet');
}

function syncDeleteMode() {
  const move = document.querySelector('input[name=ldMode][value=move]').checked;
  $('ldTargetCell').style.display = move ? '' : 'none';
}

async function confirmDeleteList() {
  const mode = document.querySelector('input[name=ldMode]:checked').value;
  if (mode === 'delete') {
    const n = state.spots.filter((s) => s.listIds.length === 1 && s.listIds[0] === deletingListId).length;
    if (!(await confirmDanger(`${n} 個定點和它們的照片會一起刪除，無法復原。`, '刪除清單和定點'))) return;
  }
  await doDeleteList(mode, $('ldTarget').value);
  closeSheet('listDeleteSheet');
}

async function doDeleteList(mode, targetId) {
  const id = deletingListId;
  const now = Date.now();
  const changed = [];
  const removed = [];
  for (const s of state.spots) {
    if (!s.listIds.includes(id)) continue;
    const rest = s.listIds.filter((x) => x !== id);
    if (rest.length) changed.push({ ...s, listIds: rest, updatedAt: now });
    else if (mode === 'delete') removed.push(s.id);
    else changed.push({ ...s, listIds: [targetId], updatedAt: now });
  }
  await db.deleteList(id, changed, removed);
  state.activeListIds.delete(id);
  await saveActive();
  deletingListId = null;
  if (removed.includes(state.previewId)) state.previewId = null;
  toast(removed.length ? `已刪除清單和 ${removed.length} 個定點` : '已刪除清單');
  await loadSpots();
}

// ---------- 編輯定點 ----------
let draft = null;

function openEditor(spot, presetPos, listId) {
  if (spot) {
    draft = {
      original: spot,
      lat: spot.lat, lng: spot.lng,
      photos: (spot.photoIds || []).map((id) => ({ id, isNew: false })),
      removed: [],
      listIds: new Set(spot.listIds),
    };
    $('fName').value = spot.name;
    $('fRadius').value = spot.radius;
    $('fNote').value = spot.note || '';
  } else {
    draft = {
      original: null, lat: presetPos.lat, lng: presetPos.lng, accuracy: presetPos.accuracy, photos: [], removed: [],
      listIds: new Set(listId ? [listId] : state.activeListIds),
    };
    $('fName').value = '';
    $('fRadius').value = DEFAULT_RADIUS;
    $('fNote').value = '';
  }
  $('editTitle').textContent = spot ? '編輯定點' : '新增定點';
  $('editDeleteGroup').hidden = !spot;
  $('fPhotoHint').textContent = '';
  renderDraftLists();
  renderDraftCoord();
  renderDraftPhotos();
  $('editForm').scrollTop = 0;
  openSheet('editSheet');
}

function renderDraftLists() {
  const box = $('fLists');
  box.innerHTML = state.lists.map((l) => `<button type="button" class="cell ${draft.listIds.has(l.id) ? 'checked' : ''}" data-list="${l.id}"><span>${escapeHtml(l.name)}</span>${ICON.check.replace('<svg', '<svg class="check-mark"')}</button>`).join('');
  box.querySelectorAll('[data-list]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.list;
    if (draft.listIds.has(id)) draft.listIds.delete(id); else draft.listIds.add(id);
    b.classList.toggle('checked', draft.listIds.has(id));
  }));
}

function renderDraftCoord() {
  const acc = draft.accuracy ? `・誤差 ±${Math.round(draft.accuracy)} 公尺` : '';
  $('fCoord').textContent = `${draft.lat.toFixed(6)}, ${draft.lng.toFixed(6)}${acc}`;
}

async function renderDraftPhotos() {
  const box = $('fPhotos');
  const items = [];
  for (const [i, p] of draft.photos.entries()) {
    const url = p.isNew ? p.url : await photoUrl(p.id);
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `<img src="${url}" alt=""><button type="button" class="photo-del" aria-label="移除這張">${ICON.x}</button>`;
    tile.querySelector('button').addEventListener('click', () => {
      const [removed] = draft.photos.splice(i, 1);
      if (removed.isNew) URL.revokeObjectURL(removed.url);
      else draft.removed.push(removed.id);
      renderDraftPhotos();
    });
    items.push(tile);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'photo-add';
  add.innerHTML = `${ICON.camera}<span>拍照或選照片</span>`;
  add.addEventListener('click', () => $('fFile').click());
  items.push(add);
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
  e?.preventDefault();
  if (!draft) return;
  const name = $('fName').value.trim();
  const radius = Math.round(Number($('fRadius').value));
  if (!name) { toast('請輸入名稱'); $('fName').focus(); return; }
  if (!(radius >= 5 && radius <= 1000)) { toast('觸發半徑請填 5～1000 公尺'); return; }
  const listIds = state.lists.map((l) => l.id).filter((id) => draft.listIds.has(id));
  if (!listIds.length) { toast('請至少選一個清單'); return; }
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
    listIds,
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
  for (const p of draft.photos) if (p.isNew) photoUrls.set(p.id, p.url);
  for (const id of draft.removed) { const u = photoUrls.get(id); if (u) URL.revokeObjectURL(u); photoUrls.delete(id); }
  draft = null;
  closeSheet('editSheet');
  toast(listIds.some((id) => state.activeListIds.has(id)) ? '已儲存' : '已儲存（所屬清單目前沒有在觸發）');
  await loadSpots();
}

async function deleteDraftSpot() {
  const s = draft?.original;
  if (!s) return;
  if (!(await confirmDanger(`刪除「${s.name}」和它的照片？`, '刪除定點'))) return;
  await db.deleteSpot(s.id);
  discardDraft();
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
  map = L.map('map', { zoomControl: false, attributionControl: true });
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
    L.circle([s.lat, s.lng], { radius: s.radius, color: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#007aff', weight: 2, fillOpacity: 0.12 })
      .bindTooltip(s.name).addTo(mapLayer);
  }
  if (state.pos) {
    L.circleMarker([state.pos.lat, state.pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1 }).addTo(mapLayer);
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
  $('importResult').textContent = '會與手機現有的清單和定點合併，同一筆保留較新的那份。';
  openSheet('settingsSheet');
}

async function onExport(e) {
  e.preventDefault();
  const p1 = $('ePass1').value;
  const p2 = $('ePass2').value;
  if (p1.length < 4) { toast('密碼至少 4 個字'); return; }
  if (p1 !== p2) { toast('兩次密碼不一樣'); return; }
  const btn = $('exportBtn');
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const { file, spotCount, photoCount } = await createBackup(p1);
    exportFile = file;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(file);
    $('exportDownload').href = exportUrl;
    $('exportDownload').download = file.name;
    $('exportInfo').textContent = `${spotCount} 個定點、${photoCount} 張照片，${(file.size / 1024 / 1024).toFixed(1)} MB`;
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
  const out = $('importResult');
  if (!file) { toast('請先選擇備份檔'); return; }
  out.textContent = '匯入中…';
  try {
    const data = await readBackup(file, pass);
    const r = await mergeBackup(data);
    if (r.newListIds.length) {
      for (const id of r.newListIds) state.activeListIds.add(id);
      await saveActive();
    }
    forgetPhotoUrls();
    out.textContent = `完成：新增 ${r.added}、更新 ${r.updated}、保留手機版本 ${r.kept}、刪除 ${r.removed} 個定點。`;
    $('iPass').value = '';
    $('iFile').value = '';
    $('iFileName').textContent = '選擇檔案';
    await loadSpots();
  } catch (err) {
    out.textContent = err?.message || '匯入失敗';
  }
}

// ---------- 事件 ----------
function bind() {
  $('btnManage').innerHTML = ICON.list;
  $('btnSettings').innerHTML = ICON.gear;
  $('mapLocate').innerHTML = ICON.locate;

  $('btnManage').addEventListener('click', openManage);
  $('btnSettings').addEventListener('click', openSettings);
  $('listBar').addEventListener('click', openManage);
  $('banners').addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSettings(); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.closest('.sheet').id)));

  $('editForm').addEventListener('submit', saveDraft);
  $('editSave').addEventListener('click', saveDraft);
  $('editCancel').addEventListener('click', discardDraft);
  $('editDelete').addEventListener('click', deleteDraftSpot);
  $('fUseHere').addEventListener('click', () => {
    if (!state.pos) { toast('還沒取得位置'); return; }
    draft.lat = state.pos.lat; draft.lng = state.pos.lng; draft.accuracy = state.pos.accuracy;
    renderDraftCoord();
    toast('已改用目前位置');
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

  $('ldCancel').addEventListener('click', () => closeSheet('listDeleteSheet'));
  $('ldConfirm').addEventListener('click', confirmDeleteList);
  document.querySelectorAll('input[name=ldMode]').forEach((r) => r.addEventListener('change', syncDeleteMode));

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

  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeOpt)));
  darkQuery.addEventListener?.('change', applyTheme);
  $('sWake').addEventListener('change', async (e) => {
    state.wakeEnabled = e.target.checked;
    await db.setMeta('wakeEnabled', state.wakeEnabled);
    applyWakeLock();
  });
  $('exportForm').addEventListener('submit', onExport);
  $('exportShare').addEventListener('click', onShareExport);
  $('exportDownload').addEventListener('click', () => { markExported(); });
  $('iFile').addEventListener('change', (e) => { $('iFileName').textContent = e.target.files[0]?.name || '選擇檔案'; });
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
  applyTheme();
  state.wakeEnabled = await db.getMeta('wakeEnabled', true);
  await loadSpots();
  startWatch();
  applyWakeLock();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
