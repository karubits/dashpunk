/* XENEON EDGE audio visualizer — Winamp-style modes driven by system audio.
   Python pushes ~30 chunks/s of base64 PCM (1024 s16le mono samples) via
   window.__audio; that push is the render clock (no free-running rAF), so
   drawing stops the moment capture stops. All buffers are allocated once —
   the web process runs 24/7 under a hard memory cap. */

"use strict";

// ── DSP buffers (allocated once) ───────────────────────────────────

const VIZ_FFT = 1024;
const vizRaw = new Uint8Array(VIZ_FFT * 2);
const vizSamples = new Int16Array(vizRaw.buffer);
const vizRe = new Float32Array(VIZ_FFT);
const vizIm = new Float32Array(VIZ_FFT);

const vizHann = new Float32Array(VIZ_FFT);
const vizRev = new Uint16Array(VIZ_FFT);
const vizCos = new Float32Array(VIZ_FFT / 2);
const vizSin = new Float32Array(VIZ_FFT / 2);
for (let i = 0; i < VIZ_FFT; i++) {
  vizHann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (VIZ_FFT - 1));
  let r = 0, x = i;
  for (let b = 0; b < 10; b++) { r = (r << 1) | (x & 1); x >>= 1; }
  vizRev[i] = r;
}
for (let i = 0; i < VIZ_FFT / 2; i++) {
  vizCos[i] = Math.cos((-2 * Math.PI * i) / VIZ_FFT);
  vizSin[i] = Math.sin((-2 * Math.PI * i) / VIZ_FFT);
}

function vizFFT() {
  for (let i = 0; i < VIZ_FFT; i++) {
    const j = vizRev[i];
    if (j > i) {
      let t = vizRe[i]; vizRe[i] = vizRe[j]; vizRe[j] = t;
      t = vizIm[i]; vizIm[i] = vizIm[j]; vizIm[j] = t;
    }
  }
  for (let len = 2; len <= VIZ_FFT; len <<= 1) {
    const half = len >> 1, step = VIZ_FFT / len;
    for (let i = 0; i < VIZ_FFT; i += len) {
      for (let k = 0; k < half; k++) {
        const w = k * step;
        const wr = vizCos[w], wi = vizSin[w];
        const a = i + k, b = a + half;
        const tr = vizRe[b] * wr - vizIm[b] * wi;
        const ti = vizRe[b] * wi + vizIm[b] * wr;
        vizRe[b] = vizRe[a] - tr; vizIm[b] = vizIm[a] - ti;
        vizRe[a] += tr; vizIm[a] += ti;
      }
    }
  }
}

// ── log-spaced bands + smoothing/peaks ─────────────────────────────

let NB = 0;
let bandLo, bandHi, bands, peaks, peakVel;
let vizBass = 0, vizMid = 0, vizTreble = 0, vizEnergy = 0;
let lastChunkTs = 0;

function vizInitBands() {
  NB = Math.max(16, Math.min(96, (sysinfo.viz && sysinfo.viz.bars) || 48));
  bandLo = new Uint16Array(NB);
  bandHi = new Uint16Array(NB);
  bands = new Float32Array(NB);
  peaks = new Float32Array(NB);
  peakVel = new Float32Array(NB);
  const fMin = 50, fMax = 16000, binHz = 44100 / VIZ_FFT;
  let lo = Math.max(1, Math.round(fMin / binHz));
  for (let i = 0; i < NB; i++) {
    let hi = Math.round((fMin * Math.pow(fMax / fMin, (i + 1) / NB)) / binHz);
    if (hi <= lo) hi = lo + 1;
    if (hi > VIZ_FFT / 2 - 1) hi = VIZ_FFT / 2 - 1;
    bandLo[i] = Math.min(lo, VIZ_FFT / 2 - 2);
    bandHi[i] = hi;
    lo = hi;
  }
}

window.__audio = (b64) => {
  if (!NB) vizInitBands();
  const bin = atob(b64);
  const n = Math.min(bin.length, vizRaw.length);
  for (let i = 0; i < n; i++) vizRaw[i] = bin.charCodeAt(i);

  for (let i = 0; i < VIZ_FFT; i++) {
    vizRe[i] = (vizSamples[i] / 32768) * vizHann[i];
    vizIm[i] = 0;
  }
  vizFFT();

  for (let b = 0; b < NB; b++) {
    let m = 0;
    for (let k = bandLo[b]; k <= bandHi[b]; k++) {
      const mag = vizRe[k] * vizRe[k] + vizIm[k] * vizIm[k];
      if (mag > m) m = mag;
    }
    // Hann coherent gain 0.5 → full-scale sine peaks at N/4
    const db = 20 * Math.log10((4 * Math.sqrt(m)) / VIZ_FFT + 1e-7);
    let v = (db + 60) / 54; // −60 dB floor … −6 dB ceiling
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    bands[b] = v > bands[b] ? v : bands[b] * 0.78 + v * 0.22;
    if (bands[b] > peaks[b]) { peaks[b] = bands[b]; peakVel[b] = 0; }
  }
  for (let b = 0; b < NB; b++) {
    peakVel[b] += 0.0025;
    peaks[b] -= peakVel[b];
    if (peaks[b] < bands[b]) peaks[b] = bands[b];
  }

  const nBass = Math.max(2, NB >> 3), trebleFrom = NB - (NB >> 2);
  let sb = 0, st = 0, se = 0;
  for (let i = 0; i < nBass; i++) sb += bands[i];
  for (let i = trebleFrom; i < NB; i++) st += bands[i];
  for (let i = 0; i < NB; i++) se += bands[i];
  vizBass += (sb / nBass - vizBass) * 0.5;
  vizTreble += (st / (NB - trebleFrom) - vizTreble) * 0.5;
  vizMid = Math.max(0, (se / NB) * 1.5 - (vizBass + vizTreble) * 0.25);
  vizEnergy += (se / NB - vizEnergy) * 0.3;

  lastChunkTs = performance.now();
  vizRender();
};

// ── palettes (precomputed — no per-frame string building) ──────────

function vizPalette(stops) {
  const out = [];
  const segs = stops.length - 1;
  for (let i = 0; i < 64; i++) {
    const f = (i / 64) * segs, s = Math.min(segs - 1, f | 0), t = f - s;
    const a = stops[s], b = stops[s + 1];
    out.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},` +
      `${Math.round(a[1] + (b[1] - a[1]) * t)},` +
      `${Math.round(a[2] + (b[2] - a[2]) * t)})`);
  }
  return out;
}
// Palettes follow the active theme (THEME comes from app.js, loaded first).
// Rebuilt by window.__vizTheme on theme change; called once at file end.
let VIZ_PAL, VIZ_STARPAL;
function vizRebuildPalettes() {
  const tr = (s) => s.split(",").map(Number);
  const A = tr(THEME.accentT), B = tr(THEME.accent2T), W = tr(THEME.warnT);
  VIZ_PAL = vizPalette([A, B, W, A]); // loopable hue cycle
  VIZ_STARPAL = vizPalette([[200, 225, 255], A, B]);
  barsGradKey = ""; // invalidate the size-keyed cached spectrum gradient
}

// ── mode: SPECTRUM (classic bars + peak caps + reflection) ─────────

let barsGrad = null, barsGradKey = "";

function drawBars(ctx, w, h) {
  const key = w + "x" + h;
  if (barsGradKey !== key) {
    barsGradKey = key;
    barsGrad = ctx.createLinearGradient(0, h, 0, 0);
    barsGrad.addColorStop(0, `rgba(${THEME.accentT},0.92)`);
    barsGrad.addColorStop(0.55, `rgba(${THEME.accentT},0.92)`);
    barsGrad.addColorStop(0.8, `rgba(${THEME.accent2T},0.95)`);
    barsGrad.addColorStop(1, `rgba(${THEME.accent2T},0.95)`);
  }
  const base = h - Math.max(40, h * 0.14);
  const availH = base - 26;
  const gap = Math.max(2, (w / NB) * 0.18);
  const bw = (w - 40 - gap * (NB - 1)) / NB;
  ctx.fillStyle = barsGrad;
  for (let i = 0; i < NB; i++) {
    const x = 20 + i * (bw + gap);
    const bh = Math.max(bands[i] * availH, 2);
    ctx.fillRect(x, base - bh, bw, bh);
  }
  ctx.globalAlpha = 0.16; // reflection
  for (let i = 0; i < NB; i++) {
    const x = 20 + i * (bw + gap);
    ctx.fillRect(x, base + 5, bw, Math.max(bands[i] * availH, 2) * 0.3);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(${THEME.warnT},0.9)`;
  for (let i = 0; i < NB; i++) {
    const x = 20 + i * (bw + gap);
    ctx.fillRect(x, base - Math.max(peaks[i] * availH, 2) - 5, bw, 3);
  }
  ctx.fillStyle = `rgba(${THEME.accentT},0.45)`;
  ctx.fillRect(20, base + 1, w - 40, 1.5);
}

// ── mode: SCOPE (oscilloscope with chromatic ghost) ────────────────

function drawScope(ctx, w, h) {
  const mid = h / 2, amp = h * 0.42;
  ctx.lineWidth = 2;
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    for (let i = 0; i < VIZ_FFT; i += 2) {
      const x = (i / (VIZ_FFT - 2)) * w;
      const y = mid + (pass ? 0 : 3) - (vizSamples[i] / 32768) * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (pass === 0) {
      ctx.strokeStyle = THEME.accent2;
      ctx.globalAlpha = 0.4;
    } else {
      ctx.strokeStyle = THEME.accent;
      ctx.globalAlpha = 1;
      ctx.shadowColor = THEME.accent;
      ctx.shadowBlur = THEME.glow ? 10 : 0;
    }
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

// ── mode: RADIAL (spokes on a bass-pulsing ring) ───────────────────

let radialRot = 0;

function drawRadial(ctx, w, h) {
  const cx = w / 2, cy = h / 2;
  radialRot += 0.004 + vizBass * 0.02;
  const breathe = 1 + 0.02 * Math.sin(performance.now() / 900);
  const rMax = Math.min(cx, cy) - 16;
  const r0 = rMax * (0.3 + vizBass * 0.12) * breathe;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, ((2 * Math.PI * r0) / NB) * 0.45);
  for (let i = 0; i < NB; i++) {
    const a = radialRot + (i / NB) * 2 * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    const len = Math.max(bands[i] * (rMax - r0), 3);
    ctx.strokeStyle = VIZ_PAL[(((i * 64) / NB) | 0) % 64];
    ctx.globalAlpha = 0.35 + bands[i] * 0.65;
    ctx.beginPath();
    ctx.moveTo(cx + ca * r0, cy + sa * r0);
    ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
    ctx.stroke();
  }
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r0 - 8, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ── mode: HYPERSPACE (starfield fly-through, speed = the music) ────

const N_STARS = 420;
const starX = new Float32Array(N_STARS);
const starY = new Float32Array(N_STARS);
const starZ = new Float32Array(N_STARS);
const starPZ = new Float32Array(N_STARS);
let starsInit = false;

function resetStar(i) {
  starX[i] = Math.random() * 2 - 1;
  starY[i] = Math.random() * 2 - 1;
  starZ[i] = 0.15 + Math.random() * 0.85;
  starPZ[i] = starZ[i];
}

function drawStars(ctx, w, h) {
  if (!starsInit) {
    starsInit = true;
    for (let i = 0; i < N_STARS; i++) resetStar(i);
  }
  const cx = w / 2, cy = h / 2, k = Math.min(w, h) * 0.5;
  const speed = 0.0025 + vizEnergy * 0.02 + vizBass * 0.028;
  ctx.lineCap = "round";
  for (let i = 0; i < N_STARS; i++) {
    starPZ[i] = starZ[i];
    starZ[i] -= speed * (0.5 + (i % 5) * 0.16);
    if (starZ[i] <= 0.02) { resetStar(i); continue; }
    const sx = cx + (starX[i] / starZ[i]) * k;
    const sy = cy + (starY[i] / starZ[i]) * k;
    if (sx < -24 || sx > w + 24 || sy < -24 || sy > h + 24) { resetStar(i); continue; }
    const px = cx + (starX[i] / starPZ[i]) * k;
    const py = cy + (starY[i] / starPZ[i]) * k;
    const depth = 1 - starZ[i];
    ctx.strokeStyle = VIZ_STARPAL[Math.min(63, ((depth * 26 + vizTreble * 37) | 0))];
    ctx.globalAlpha = 0.2 + depth * 0.8;
    ctx.lineWidth = 0.6 + depth * 2.4;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ── mode: WORMHOLE (receding tunnel rings warped by the spectrum) ──

const WH_RINGS = 26, WH_SEG = 44;
let whT = 0, whRot = 0;

function drawWormhole(ctx, w, h) {
  whT += 0.004 + vizEnergy * 0.024;
  whRot += 0.012 + vizTreble * 0.03;
  const cx = w / 2, cy = h / 2;
  const vx = cx + Math.cos(whRot * 0.31) * w * 0.09;
  const vy = cy + Math.sin(whRot * 0.43) * h * 0.14;
  const maxR = Math.hypot(w, h) * 0.55;
  ctx.lineCap = "round";
  for (let i = 0; i < WH_RINGS; i++) {
    const p = (i / WH_RINGS + whT) % 1; // 0 = far, →1 = at the viewer
    const r = 6 + maxR * Math.pow(p, 2.4);
    const rcx = vx + (cx - vx) * p + Math.cos(whRot + p * 9) * 16 * vizBass;
    const rcy = vy + (cy - vy) * p + Math.sin(whRot + p * 9) * 12 * vizBass;
    const band = bands[(((1 - p) * (NB - 1)) | 0)] || 0;
    const wob = r * 0.22 * band;
    ctx.strokeStyle = VIZ_PAL[((p * 40 + vizEnergy * 23 + i) | 0) % 64];
    ctx.globalAlpha = 0.1 + p * 0.85;
    ctx.lineWidth = 1 + p * 3;
    ctx.beginPath();
    for (let s = 0; s <= WH_SEG; s++) {
      const a = (s / WH_SEG) * 2 * Math.PI;
      const rr = r + wob * Math.sin(a * 5 + whRot * 2 + i);
      const x = rcx + Math.cos(a) * rr, y = rcy + Math.sin(a) * rr;
      s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ── mode: WARP (MilkDrop-style canvas feedback) ────────────────────

let warpA = null, warpB = null, warpW = 0, warpH = 0, warpPhase = 0, warpFrame = 0;

function drawWarp(ctx, w, h) {
  const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1); // half-res feedback
  if (!warpA || warpW !== hw || warpH !== hh) {
    warpW = hw; warpH = hh;
    warpA = document.createElement("canvas");
    warpB = document.createElement("canvas");
    warpA.width = warpB.width = hw;
    warpA.height = warpB.height = hh;
  }
  const b = warpB.getContext("2d");
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, hw, hh);
  b.translate(hw / 2, hh / 2);
  b.rotate(0.004 + vizBass * 0.02);
  const sc = 1.015 + vizBass * 0.03;
  b.scale(sc, sc);
  b.globalAlpha = 0.96;
  b.drawImage(warpA, -hw / 2, -hh / 2);
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalAlpha = 1;
  if ((warpFrame++ & 7) === 0) { // keep brightness from saturating
    b.fillStyle = "rgba(0,0,0,0.05)";
    b.fillRect(0, 0, hw, hh);
  }
  warpPhase += 0.02 + vizEnergy * 0.06;
  b.globalCompositeOperation = "lighter";
  b.lineWidth = 2;
  b.strokeStyle = VIZ_PAL[((warpPhase * 6) | 0) % 64];
  const ccx = hw / 2, ccy = hh / 2, rBase = Math.min(hw, hh) * 0.3;
  b.beginPath();
  for (let s = 0; s <= NB; s++) {
    const a = (s / NB) * 2 * Math.PI + warpPhase;
    const rr = rBase * (0.7 + bands[s % NB] * 0.7);
    const x = ccx + Math.cos(a) * rr, y = ccy + Math.sin(a) * rr;
    s === 0 ? b.moveTo(x, y) : b.lineTo(x, y);
  }
  b.closePath();
  b.stroke();
  b.globalCompositeOperation = "source-over";
  const t = warpA; warpA = warpB; warpB = t;
  ctx.drawImage(warpA, 0, 0, w, h);
}

// ── mode registry + rendering ──────────────────────────────────────

const VIZ_MODES = [
  { id: "bars", name: "SPECTRUM", draw: drawBars },
  { id: "scope", name: "SCOPE", draw: drawScope },
  { id: "radial", name: "RADIAL", draw: drawRadial },
  { id: "stars", name: "HYPERSPACE", draw: drawStars },
  { id: "wormhole", name: "WORMHOLE", draw: drawWormhole },
  { id: "warp", name: "WARP", draw: drawWarp },
];
let modeIdx = 0;
let vizModeInited = false;

function vizRender() {
  if (!vizActive || !NB) return;
  const p = prepCanvas($("viz-canvas"));
  if (!p) return;
  VIZ_MODES[modeIdx].draw(p.ctx, p.w, p.h);
}

function vizSetMode(i, flash) {
  modeIdx = ((i % VIZ_MODES.length) + VIZ_MODES.length) % VIZ_MODES.length;
  const m = VIZ_MODES[modeIdx];
  $("viz-mode-lbl").textContent = m.name;
  try { localStorage.setItem("viz-mode", m.id); } catch (e) { /* file:// origin */ }
  if (flash) {
    const f = $("viz-flash");
    f.hidden = false;
    f.textContent = m.name;
    f.classList.remove("show");
    void f.offsetWidth; // restart the fade-out animation
    f.classList.add("show");
  }
}

function vizEnsureMode() {
  if (vizModeInited) return;
  vizModeInited = true;
  let id = null;
  try { id = localStorage.getItem("viz-mode"); } catch (e) { /* best effort */ }
  if (!id && sysinfo.viz) id = sysinfo.viz.mode;
  const i = VIZ_MODES.findIndex((m) => m.id === id);
  vizSetMode(i >= 0 ? i : 0, false);
}

// tap cycles modes; a swipe (>80px, handled on #pages) still flips pages —
// no `click` here, since a swipe ending on the canvas would fire one too
(() => {
  const cv = $("viz-canvas");
  let tx = 0, ty = 0, tt = 0, lastCycle = 0;
  cv.addEventListener("pointerdown", (e) => {
    tx = e.clientX; ty = e.clientY; tt = performance.now();
  });
  cv.addEventListener("pointerup", (e) => {
    const now = performance.now();
    // debounce: the touch panel can deliver a duplicate emulated-mouse
    // pointer sequence for one physical tap — don't advance twice
    if (Math.hypot(e.clientX - tx, e.clientY - ty) < 12 &&
        now - tt < 400 && now - lastCycle > 350) {
      lastCycle = now;
      vizEnsureMode();
      vizSetMode(modeIdx + 1, true);
      vizRender();
    }
  });
})();

// ── page lifecycle: capture on/off + idle watchdog ─────────────────

let vizActive = false;
let idleTimer = null;

window.__vizPage = (page) => {
  const active = page === 4;
  if (active === vizActive) return;
  vizActive = active;
  send({ cmd: "viz-active", active });
  if (active) {
    vizEnsureMode();
    if (!NB) vizInitBands();
    if (!idleTimer) idleTimer = setInterval(vizIdleTick, 80);
    vizRender();
  } else if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
};

// keeps the canvas alive (settling bars, drifting stars) when no audio
// chunks arrive — parec respawning, sink suspended, or plain silence
function vizIdleTick() {
  if (performance.now() - lastChunkTs < 400) return;
  for (let i = 0; i < NB; i++) {
    bands[i] *= 0.92;
    peaks[i] = Math.max(peaks[i] * 0.96 - 0.002, bands[i]);
  }
  for (let i = 0; i < VIZ_FFT; i++) vizSamples[i] = (vizSamples[i] * 0.8) | 0;
  vizBass *= 0.92; vizMid *= 0.92; vizTreble *= 0.92; vizEnergy *= 0.92;
  vizRender();
}

// ── media overlay (top-right card + transport + like) ──────────────

window.__vizMedia = (m) => {
  const card = $("viz-media"), ctr = $("viz-controls");
  ctr.hidden = !m;
  if (m) {
    $("v-play").innerHTML = m.status === "Playing" ? ICON.pause : ICON.play;
    $("v-prev").disabled = !m.canPrev;
    $("v-next").disabled = !m.canNext;
    updateHeart($("v-like"), m);
  }
  const show = !!(m && m.title);
  card.hidden = !show;
  if (!show) return;
  const t = $("viz-title"), a = $("viz-artist");
  if (t.textContent !== m.title) t.textContent = m.title;
  const artist = m.artist || "";
  if (a.textContent !== artist) a.textContent = artist;
  const img = $("viz-art");
  if (m.art && img.dataset.src !== m.art) {
    img.dataset.src = m.art;
    img.style.display = "";
    img.src = m.art;
  }
  if (!m.art) img.style.display = "none";
};

$("viz-art").addEventListener("error", () => ($("viz-art").style.display = "none"));
$("v-play").addEventListener("click", () => send({ cmd: "media", action: "playpause" }));
$("v-prev").addEventListener("click", () => send({ cmd: "media", action: "previous" }));
$("v-next").addEventListener("click", () => send({ cmd: "media", action: "next" }));
$("v-like").addEventListener("click", (e) => heartTap(e.currentTarget));

// theme hook: rebuild palettes now and whenever the theme changes
window.__vizTheme = vizRebuildPalettes;
vizRebuildPalettes();
