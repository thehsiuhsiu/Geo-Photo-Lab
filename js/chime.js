// 進入定點範圍時的「叮」一聲（Web Audio 即時合成，不需要音效檔）
// iPhone 規定要先點一下畫面才能出聲，所以 unlock() 會在每次點畫面時呼叫。

let ctx = null;

function audioCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

/** 在使用者點畫面時呼叫，讓之後可以自動出聲 */
export function unlock() {
  const c = audioCtx();
  if (!c) return;
  if (c.state !== 'running') c.resume().catch(() => {});
  // iOS 舊版需要真的播一小段才算解鎖
  if (!unlock.done) {
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
    unlock.done = true;
  }
}

export function ready() {
  return !!ctx && ctx.state === 'running';
}

/** 播放「叮」；volume 0～100 */
export function ding(volume) {
  const c = audioCtx();
  if (!c || volume <= 0) return;
  if (c.state !== 'running') c.resume().catch(() => {});
  // 人耳對音量是對數感受：用平方讓滑桿前段變化比較細；最大也只到 0.35，不會太吵
  const peak = 0.35 * (volume / 100) ** 2;
  const t = c.currentTime + 0.02;
  const out = c.createGain();
  out.gain.value = peak;
  out.connect(c.destination);
  // 主音 + 高八度泛音，聽起來像小鈴
  [[1568, 1, 1.2], [3136, 0.35, 0.6], [4704, 0.12, 0.3]].forEach(([freq, level, len]) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.05);
  });
}
