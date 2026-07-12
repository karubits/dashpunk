/* DASHPUNK dashboard logic — receives state pushed from the Python side,
   sends commands back over the WebKit script-message bridge. */

"use strict";

const $ = (id) => document.getElementById(id);
const HIST = 60;

// crisp themed icons instead of platform emoji
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 6h2v12H6zM18 6v12l-8.5-6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z"/></svg>',
  volMuted: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm18.6 5.9-2.9-2.9 2.9-2.9-1.6-1.6-2.9 2.9-2.9-2.9-1.6 1.6 2.9 2.9-2.9 2.9 1.6 1.6 2.9-2.9 2.9 2.9z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M7 7h10v10H7z"/></svg>',
  radio: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7.05 16.95l1.41-1.41a4 4 0 0 1 0-7.08L7.05 7.05a6 6 0 0 0 0 9.9zm9.9 0a6 6 0 0 0 0-9.9l-1.41 1.41a4 4 0 0 1 0 7.08l1.41 1.41zM4.22 19.78l1.42-1.42a8 8 0 0 1 0-12.72L4.22 4.22a10 10 0 0 0 0 15.56zm15.56 0a10 10 0 0 0 0-15.56l-1.42 1.42a8 8 0 0 1 0 12.72l1.42 1.42z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  heartO: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>',
};

const hist = { cpu: [], gpu: [], rx: [], tx: [] };
let lastState = null;
let volGrabbedUntil = 0; // ignore pushed volume while user drags the slider
let heartHoldUntil = 0; // ignore pushed liked-state right after a like tap

// ── bridge ─────────────────────────────────────────────────────────

function send(obj) {
  try {
    window.webkit.messageHandlers.bridge.postMessage(JSON.stringify(obj));
  } catch (e) {
    console.log("bridge unavailable:", e);
  }
}

// ── themes ─────────────────────────────────────────────────────────
// Palette lives in CSS vars ([data-theme] blocks in style.css); THEME caches
// the values canvas drawing needs. Python owns the persisted choice and
// pushes it in __static (also the crash-reload restore path).

const THEMES = ["cyberpunk", "lcars", "catppuccin", "monokai", "mayukai", "dracula"];
const THEME_LBL = {
  cyberpunk: "CYBER", lcars: "LCARS", catppuccin: "CATPPN",
  monokai: "MNKAI", mayukai: "MAYU", dracula: "DRAC",
};
const THEME = {
  name: "cyberpunk", glow: true,
  accentT: "0,240,255", accent2T: "255,42,109",
  goodT: "57,255,20", warnT: "252,238,10",
  accent: "rgb(0,240,255)", accent2: "rgb(255,42,109)",
  good: "rgb(57,255,20)", warn: "rgb(252,238,10)",
};

window.__applyTheme = (name) => {
  if (!THEMES.includes(name)) name = "cyberpunk";
  THEME.name = name;
  document.documentElement.dataset.theme = name;
  const cs = getComputedStyle(document.documentElement);
  const triple = (v, fb) => (cs.getPropertyValue(v).trim() || fb);
  THEME.accentT = triple("--accent-rgb", THEME.accentT);
  THEME.accent2T = triple("--accent2-rgb", THEME.accent2T);
  THEME.goodT = triple("--good-rgb", THEME.goodT);
  THEME.warnT = triple("--warn-rgb", THEME.warnT);
  // rgb() form: drawArea's gradient string-replace keeps working
  for (const k of ["accent", "accent2", "good", "warn"])
    THEME[k] = `rgb(${THEME[k + "T"]})`;
  THEME.glow = name === "cyberpunk";
  const lbl = document.querySelector("#act-theme .act-lbl");
  if (lbl) lbl.textContent = THEME_LBL[name];
  if (window.__vizTheme) window.__vizTheme();
  if (lastState) {
    // repaint canvases directly; __update would double-push history samples
    renderSystem(lastState.sys);
    renderGpu(lastState.gpu);
    renderNet(lastState.net);
  }
  ambientStart(); // (re)arm theme-scoped ambient effects
};

// ── ambient effects (theme-scoped; every timer dies on theme switch) ──

const AMBIENT = { timers: new Set() };
const rnd = (a, b) => a + Math.random() * (b - a);

function ambientLater(ms, fn) {
  const t = setTimeout(() => { AMBIENT.timers.delete(t); fn(); }, ms);
  AMBIENT.timers.add(t);
}

function ambientStop() {
  for (const t of AMBIENT.timers) clearTimeout(t);
  AMBIENT.timers.clear();
  const a = $("ambient");
  if (a) a.innerHTML = "";
  document.documentElement.classList.remove("glitching");
}

// catppuccin: a gentle sakura shower every few minutes
function sakuraBurst() {
  if (THEME.name !== "catppuccin") return;
  const a = $("ambient");
  const n = 14 + ((Math.random() * 10) | 0);
  for (let i = 0; i < n; i++) {
    ambientLater(rnd(0, 12000), () => {
      if (THEME.name !== "catppuccin") return;
      const p = document.createElement("span");
      p.className = "sakura";
      const inner = document.createElement("span");
      inner.className = "sakura-inner";
      inner.textContent = "\u{1F338}";
      p.appendChild(inner);
      p.style.left = rnd(-2, 100) + "vw";
      p.style.fontSize = rnd(13, 24) + "px";
      p.style.opacity = rnd(0.55, 0.9).toFixed(2);
      p.style.animationDuration = rnd(16, 28) + "s"; // slow, lazy drift
      inner.style.animationDuration = rnd(2.4, 4.5) + "s";
      p.addEventListener("animationend", () => p.remove());
      a.appendChild(p);
    });
  }
  ambientLater(rnd(4, 9) * 60000, sakuraBurst);
}

// catppuccin: an invisible cat wanders across, leaving paw prints that
// appear step by step along a gently wavy path and fade away
function pawTrail() {
  if (THEME.name !== "catppuccin") return;
  const a = $("ambient");
  const rtl = Math.random() < 0.5;         // walk direction
  const y0 = rnd(18, 78);                  // path start/end height (vh)
  const y1 = Math.min(85, Math.max(12, y0 + rnd(-24, 24)));
  const steps = 14 + ((Math.random() * 8) | 0);
  const wobble = rnd(1.5, 4);              // sine wobble amplitude (vh)
  const cadence = rnd(220, 320);           // ms between steps
  for (let i = 0; i < steps; i++) {
    ambientLater(i * cadence + rnd(0, 60), () => {
      if (THEME.name !== "catppuccin") return;
      const t = i / (steps - 1);
      const x = rtl ? 102 - t * 106 : -2 + t * 106;
      const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 3) * wobble;
      // face the paw along the travel direction
      const dx = (rtl ? -1 : 1) * (106 / steps);
      const dy = (y1 - y0) / steps + Math.cos(t * Math.PI * 3) * wobble * 0.2;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      const p = document.createElement("span");
      p.className = "paw";
      p.textContent = "\u{1F43E}";
      p.style.left = x + "vw";
      p.style.top = y + "vh";
      p.style.fontSize = rnd(15, 20) + "px";
      p.style.transform = `rotate(${(deg + rnd(-8, 8)).toFixed(1)}deg)`;
      p.style.animationDuration = rnd(3.5, 5.5) + "s";
      p.addEventListener("animationend", () => p.remove());
      a.appendChild(p);
    });
  }
  ambientLater(rnd(2.5, 6) * 60000, pawTrail);
}

// cyberpunk: simulated GPU glitch, one or two per ~20 minutes
// (disable with [ui] glitches = false in the config)
function glitchBurst(tears) {
  const a = $("ambient");
  document.documentElement.classList.add("glitching");
  for (let i = 0; i < tears; i++) {
    const t = document.createElement("div");
    t.className = "glitch-tear";
    t.style.top = rnd(5, 88) + "vh";
    t.style.height = rnd(8, 30) + "px";
    t.style.animationDelay = i * 60 + "ms";
    t.addEventListener("animationend", () => t.remove());
    a.appendChild(t);
  }
  ambientLater(rnd(380, 650), () =>
    document.documentElement.classList.remove("glitching"));
}

function gpuGlitch() {
  if (THEME.name !== "cyberpunk" || !sysinfo.glitches) return;
  glitchBurst(2 + ((Math.random() * 2) | 0));
  if (Math.random() < 0.35) {
    ambientLater(rnd(900, 1600), () => {
      if (THEME.name === "cyberpunk" && sysinfo.glitches) glitchBurst(1);
    });
  }
  ambientLater(rnd(10, 20) * 60000, gpuGlitch);
}

function ambientStart() {
  ambientStop();
  if (THEME.name === "catppuccin") {
    ambientLater(rnd(3, 15) * 1000, sakuraBurst);
    ambientLater(rnd(20, 60) * 1000, pawTrail);
  } else if (THEME.name === "cyberpunk" && sysinfo.glitches) {
    ambientLater(rnd(3, 12) * 60000, gpuGlitch);
  }
}

window.__static = (info) => {
  $("hostname").textContent = info.hostname;
  sysinfo.distro = info.distro;
  sysinfo.kernel = info.kernel;
  sysinfo.mediaLauncher = info.mediaLauncher;
  sysinfo.stations = info.stations || [];
  sysinfo.viz = info.viz || { bars: 48, mode: "bars" };
  sysinfo.glitches = info.glitches !== false;
  if (info.hideCursor) document.body.classList.add("no-cursor");
  if (info.theme) window.__applyTheme(info.theme);
  buildLaunchers();
  buildApps(info.apps || []);
};

function buildApps(apps) {
  const page = $("page-apps");
  page.innerHTML = "";
  apps.forEach((app, i) => {
    const tile = document.createElement("button");
    tile.className = "app-tile";
    const img = document.createElement("img");
    img.src = "icons/" + app.icon;
    img.alt = "";
    img.addEventListener("error", () => {
      const fb = document.createElement("span");
      fb.className = "fallback-ico";
      fb.textContent = (app.label || "?").slice(0, 1).toUpperCase();
      img.replaceWith(fb);
    });
    const lbl = document.createElement("span");
    lbl.className = "app-lbl";
    lbl.textContent = app.label;
    tile.append(img, lbl);
    tile.addEventListener("click", () => send({ cmd: "app-launch", idx: i }));
    page.appendChild(tile);
  });
}

window.__update = (s) => {
  lastState = s;
  push(hist.cpu, s.sys ? s.sys.cpu : null);
  if (s.gpu) push(hist.gpu, s.gpu.busy);
  if (s.net) {
    push(hist.rx, s.net.ifaces.reduce((a, i) => a + i.rx, 0));
    push(hist.tx, s.net.ifaces.reduce((a, i) => a + i.tx, 0));
  }
  renderSystem(s.sys);
  renderGpu(s.gpu);
  renderAudio(s.audio);
  renderMedia(s.media);
  renderNet(s.net);
  renderActions(s.actions);
  renderNotifs(s.notifs);
  renderCal(s.cal);
  renderWorld(s.world);
  renderTasks(s.tasks);
  if (window.__vizMedia) window.__vizMedia(s.media);
};

function push(arr, v) {
  arr.push(v);
  if (arr.length > HIST) arr.shift();
}

// ── formatting helpers ─────────────────────────────────────────────

const sysinfo = { distro: "", kernel: "" };

function fmtBytes(b) {
  if (b == null) return "--";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b >= 100 || i === 0 ? 0 : 1) + " " + u[i];
}

function fmtRate(bps) {
  if (bps == null) return "--";
  const u = ["B/s", "KB/s", "MB/s", "GB/s"];
  let i = 0;
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
  return bps.toFixed(bps >= 100 || i === 0 ? 0 : 1) + " " + u[i];
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = String(Math.floor((sec % 86400) / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  return (d > 0 ? d + "d " : "") + h + ":" + m;
}

function fmtTime(us) {
  if (us == null || us < 0 || us > 86400e6) return "-:--";
  const s = Math.floor(us / 1e6);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function levelClass(pct, warn = 60, crit = 85) {
  return pct >= crit ? "crit" : pct >= warn ? "warn" : "";
}

function setLevel(el, base, pct, warn, crit) {
  el.className = base + " " + levelClass(pct, warn, crit);
}

// ── clock ──────────────────────────────────────────────────────────

function tickClock() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  $("clock").textContent = `${p(n.getHours())}:${p(n.getMinutes())}`;
  $("date").textContent = n.toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "2-digit",
  });
  tickWorldClocks(n);
}
setInterval(tickClock, 250);
tickClock();

// ── sparkline drawing ──────────────────────────────────────────────

function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawArea(cv, data, max, color) {
  const p = prepCanvas(cv);
  if (!p) return;
  const { ctx, w, h } = p;
  if (data.length < 2) return;
  const step = w / (HIST - 1);
  const x0 = w - (data.length - 1) * step;

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - (Math.min(v ?? 0, max) / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = color;
  ctx.shadowBlur = THEME.glow ? 7 : 0;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(x0 + (data.length - 1) * step, h);
  ctx.lineTo(x0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color.replace(")", ",0.30)").replace("rgb", "rgba"));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fill();
}

function drawDualArea(cv, a, b, colorA, colorB) {
  const p = prepCanvas(cv);
  if (!p) return;
  const { ctx, w, h } = p;
  const max = Math.max(1e4, ...a, ...b) * 1.15;
  const step = w / (HIST - 1);
  for (const [data, color] of [[a, colorA], [b, colorB]]) {
    if (data.length < 2) continue;
    const x0 = w - (data.length - 1) * step;
    ctx.beginPath();
    data.forEach((v, i) => {
      const y = h - (Math.min(v, max) / max) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x0, y) : ctx.lineTo(x0 + i * step, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = THEME.glow ? 6 : 0;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawPingBars(cv, history) {
  const p = prepCanvas(cv);
  if (!p) return;
  const { ctx, w, h } = p;
  const valid = history.filter((v) => v != null);
  const max = Math.max(50, ...valid) * 1.1;
  const n = HIST;
  const bw = w / n;
  history.forEach((v, i) => {
    const x = w - (history.length - i) * bw;
    if (v == null) {
      ctx.fillStyle = `rgba(${THEME.accent2T},0.85)`;
      ctx.fillRect(x, 0, Math.max(bw - 1.5, 1), h);
    } else {
      const bh = Math.max((v / max) * h, 2);
      ctx.fillStyle = v < 20 ? `rgba(${THEME.goodT},0.8)` : v < 60 ? `rgba(${THEME.accentT},0.8)` : `rgba(${THEME.warnT},0.85)`;
      ctx.fillRect(x, h - bh, Math.max(bw - 1.5, 1), bh);
    }
  });
}

// ── renderers ──────────────────────────────────────────────────────

function renderSystem(sys) {
  if (!sys) return;
  const cpu = Math.round(sys.cpu);
  $("cpu-pct").innerHTML = cpu + "<small>%</small>";
  setLevel($("cpu-pct"), "bigval", cpu);
  drawArea($("cpu-spark"), hist.cpu, 100, THEME.accent);

  const coresEl = $("cores");
  if (coresEl.children.length !== sys.cores.length) {
    coresEl.innerHTML = sys.cores.map(() => '<div class="core"><i></i></div>').join("");
  }
  sys.cores.forEach((c, i) => {
    const bar = coresEl.children[i].firstChild;
    bar.style.height = Math.max(c, 3) + "%";
    bar.className = levelClass(c, 65, 90);
  });

  $("cpu-temp").textContent = sys.cpuTemp != null ? Math.round(sys.cpuTemp) + "°C" : "--";
  $("cpu-freq").textContent = sys.freqMHz != null ? (sys.freqMHz / 1000).toFixed(1) + "GHz" : "--";
  $("cpu-load").textContent = sys.load[0].toFixed(2);
  if (sys.fans && sys.fans.length) {
    $("fan-kv").hidden = false;
    $("fan-rpm").textContent = sys.fans[0].rpm;
  }

  $("mem-bar").style.width = sys.mem.pct + "%";
  setLevel($("mem-bar"), "bar-fill", sys.mem.pct, 70, 88);
  $("mem-val").textContent = fmtBytes(sys.mem.used) + " / " + fmtBytes(sys.mem.total);

  const hasSwap = sys.swap.total > 0;
  $("swap-row").style.display = hasSwap ? "" : "none";
  if (hasSwap) {
    $("swap-bar").style.width = sys.swap.pct + "%";
    $("swap-val").textContent = fmtBytes(sys.swap.used) + " / " + fmtBytes(sys.swap.total);
  }

  const disksEl = $("disks");
  if (disksEl.children.length !== sys.disks.length) {
    disksEl.innerHTML = sys.disks.map(() => `
      <div class="bar-row thin">
        <span class="bar-lbl"></span>
        <div class="bar"><div class="bar-fill"></div></div>
        <span class="bar-val"></span>
      </div>`).join("");
  }
  sys.disks.forEach((d, i) => {
    const row = disksEl.children[i];
    row.querySelector(".bar-lbl").textContent = d.mount;
    const fill = row.querySelector(".bar-fill");
    fill.style.width = d.pct + "%";
    setLevel(fill, "bar-fill", d.pct, 80, 92);
    row.querySelector(".bar-val").textContent = fmtBytes(d.used) + " / " + fmtBytes(d.total);
  });

  $("sysline").textContent =
    `${sysinfo.distro} · ${sysinfo.kernel} · UP ${fmtUptime(sys.uptime)}`;
}

function renderGpu(gpu) {
  if (!gpu) {
    $("panel-gpu").style.opacity = 0.4;
    return;
  }
  const busy = gpu.busy ?? 0;
  $("gpu-pct").innerHTML = busy + "<small>%</small>";
  setLevel($("gpu-pct"), "bigval", busy);
  drawArea($("gpu-spark"), hist.gpu, 100, THEME.accent2);
  $("gpu-temp").textContent = gpu.temp != null ? Math.round(gpu.temp) + "°C" : "--";
  $("gpu-pwr").textContent = gpu.powerW != null ? gpu.powerW.toFixed(1) + "W" : "--";
  $("gpu-freq").textContent = gpu.freqMHz != null ? gpu.freqMHz + "MHz" : "--";
  if (gpu.vramTotal) {
    const pct = (gpu.vramUsed / gpu.vramTotal) * 100;
    $("vram-bar").style.width = pct + "%";
    setLevel($("vram-bar"), "bar-fill", pct, 70, 90);
    $("vram-val").textContent = fmtBytes(gpu.vramUsed) + " / " + fmtBytes(gpu.vramTotal);
  }
  $("nvme-temp").textContent =
    lastState.sys && lastState.sys.nvmeTemp != null ? Math.round(lastState.sys.nvmeTemp) + "°C" : "--";
}

// ── audio ──────────────────────────────────────────────────────────

const KIND_TAGS = { bluetooth: "BT", usb: "USB", hdmi: "HDMI", internal: "INT" };

function renderDevList(el, devices, kind) {
  const key = JSON.stringify(devices.map((d) => [d.name, d.default]));
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = "";
  for (const d of devices) {
    const row = document.createElement("button");
    row.className = "dev" + (d.default ? " on" : "");
    row.innerHTML = `
      <span class="dev-kind">${KIND_TAGS[d.kind] || "DEV"}</span>
      <span class="dev-name"></span>
      <span class="dev-check">◈</span>`;
    row.querySelector(".dev-name").textContent = d.desc;
    row.addEventListener("click", () => {
      if (!d.default) send({ cmd: "default", kind, name: d.name });
      el.dataset.key = ""; // force refresh on next state
    });
    el.appendChild(row);
  }
}

function renderAudio(audio) {
  if (!audio) return;
  renderDevList($("sinks"), audio.sinks, "sink");
  const extraSources = audio.sources.length > 1 ? audio.sources : [];
  renderDevList($("sources"), extraSources, "source");

  const def = audio.sinks.find((s) => s.default);
  if (def) {
    if (Date.now() > volGrabbedUntil) setVolUI(def.vol);
    $("vol-slider").classList.toggle("muted", def.mute);
    const mb = $("sink-mute");
    mb.classList.toggle("muted", def.mute);
    mb.innerHTML = def.mute ? ICON.volMuted : ICON.vol;
  }

  const mic = audio.sources.find((s) => s.default) || audio.sources[0];
  if (mic) {
    $("mic-name").textContent = mic.desc;
    $("mic-mute").classList.toggle("muted", mic.mute);
    const st = $("mic-state");
    st.textContent = mic.mute ? "MUTED" : "LIVE";
    st.className = "mic-state" + (mic.mute ? " muted" : "");
    $("mic-mute").dataset.name = mic.name;
  } else {
    $("mic-name").textContent = "no input device";
  }
}

function setVolUI(v) {
  const pct = Math.round(v * 100);
  $("vol-slider").querySelector(".slider-fill").style.width = pct + "%";
  $("vol-slider").querySelector(".slider-thumb").style.left = pct + "%";
  $("vol-pct").textContent = pct + "%";
}

// touch/drag volume slider
(() => {
  const slider = $("vol-slider");
  let dragging = false, lastSend = 0;

  const valueAt = (clientX) => {
    const r = slider.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const apply = (v, force) => {
    setVolUI(v);
    volGrabbedUntil = Date.now() + 1200;
    const now = Date.now();
    if (force || now - lastSend > 90) {
      lastSend = now;
      const def = lastState && lastState.audio && lastState.audio.sinks.find((s) => s.default);
      if (def) send({ cmd: "volume", kind: "sink", name: def.name, value: v });
    }
  };

  slider.addEventListener("pointerdown", (e) => {
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    apply(valueAt(e.clientX), true);
  });
  slider.addEventListener("pointermove", (e) => {
    if (dragging) apply(valueAt(e.clientX), false);
  });
  const end = (e) => {
    if (dragging) apply(valueAt(e.clientX), true);
    dragging = false;
  };
  slider.addEventListener("pointerup", end);
  slider.addEventListener("pointercancel", () => (dragging = false));
})();

$("sink-mute").addEventListener("click", () => {
  const def = lastState && lastState.audio && lastState.audio.sinks.find((s) => s.default);
  if (def) send({ cmd: "mute", kind: "sink", name: def.name });
});
$("mic-mute").addEventListener("click", (e) => {
  const name = e.currentTarget.dataset.name;
  if (name) send({ cmd: "mute", kind: "source", name });
});

// ── media ──────────────────────────────────────────────────────────

// ── live radio (played by the webview itself) ──────────────────────

let radio = null; // {label, el: HTMLAudioElement}

function startRadio(station) {
  stopRadio();
  const el = new Audio(station.url);
  el.play().catch((e) => {
    console.log("radio failed: " + e);
    if (radio && radio.el === el) stopRadio();
  });
  el.addEventListener("error", () => {
    console.log("radio stream error");
    if (radio && radio.el === el) stopRadio();
  });
  radio = { label: station.label, el };
  renderMedia(lastState && lastState.media);
}

function stopRadio() {
  if (!radio) return;
  radio.el.pause();
  radio.el.removeAttribute("src");
  radio = null;
  renderMedia(lastState && lastState.media);
}

function buildLaunchers() {
  const holder = $("m-launchers");
  holder.innerHTML = "";
  if (sysinfo.mediaLauncher) {
    const b = document.createElement("button");
    b.className = "launch-btn";
    b.innerHTML = ICON.play + " OPEN " + sysinfo.mediaLauncher;
    b.addEventListener("click", () => send({ cmd: "media-launch" }));
    holder.appendChild(b);
  }
  for (const st of sysinfo.stations) {
    const b = document.createElement("button");
    b.className = "launch-btn radio";
    b.innerHTML = ICON.radio + " ";
    b.appendChild(document.createTextNode(st.label + " · LIVE"));
    b.addEventListener("click", () => startRadio(st));
    holder.appendChild(b);
  }
}

// Spotify like button (shared between the dash media panel and the
// visualizer page — viz.js calls these too).
function updateHeart(btn, m) {
  const sp = m && m.spotify;
  const show = !!(sp && sp.status !== "off" && m.trackId);
  btn.hidden = !show;
  if (!show) return;
  if (sp.status === "unlinked") {
    if (btn.dataset.state !== "link") {
      btn.dataset.state = "link";
      btn.className = "mbtn heart link";
      btn.innerHTML = ICON.heartO + '<span class="hlbl">LINK</span>';
    }
    return;
  }
  if (Date.now() < heartHoldUntil) return; // optimistic tap in flight
  const state = sp.liked === true ? "liked" : "un";
  if (btn.dataset.state !== state) {
    btn.dataset.state = state;
    btn.className = "mbtn heart" + (state === "liked" ? " liked" : "");
    btn.innerHTML = state === "liked" ? ICON.heart : ICON.heartO;
  }
}

function heartTap(btn) {
  const m = lastState && lastState.media;
  if (!m || !m.spotify) return;
  if (m.spotify.status === "unlinked") {
    send({ cmd: "spotify-auth" });
    return;
  }
  if (!m.trackId) return;
  const liked = btn.dataset.state !== "liked";
  heartHoldUntil = Date.now() + 2500;
  for (const b of document.querySelectorAll(".mbtn.heart")) {
    b.dataset.state = liked ? "liked" : "un";
    b.className = "mbtn heart" + (liked ? " liked" : "");
    b.innerHTML = liked ? ICON.heart : ICON.heartO;
  }
  send({ cmd: "spotify-like", trackId: m.trackId, liked });
}

function renderMedia(m) {
  const art = $("art"), idle = $("art-idle");
  updateHeart($("m-like"), radio ? null : m);

  if (radio) {
    // radio mode wins until stopped
    $("m-launchers").hidden = true;
    $("radio-controls").hidden = false;
    $("media-controls").style.display = "none";
    $("media-progress").style.display = "none";
    art.style.display = "none";
    idle.style.display = "flex";
    idle.innerHTML = "ON<br>AIR";
    idle.classList.add("onair");
    $("track-title").textContent = radio.label;
    $("track-artist").textContent = "LIVE RADIO";
    $("track-album").textContent = "";
    $("track-player").textContent =
      "STREAMING · " + (radio.el.paused ? "PAUSED" : "ON AIR");
    $("r-pause").innerHTML = radio.el.paused ? ICON.play : ICON.pause;
    return;
  }
  $("radio-controls").hidden = true;
  idle.classList.remove("onair");
  idle.innerHTML = "NO<br>SIGNAL";

  const launcher = !m &&
    (!!sysinfo.mediaLauncher || (sysinfo.stations && sysinfo.stations.length));
  $("m-launchers").hidden = !launcher;
  $("media-controls").style.display = launcher ? "none" : "";
  $("media-progress").style.display = launcher ? "none" : "";
  if (!m) {
    art.style.display = "none";
    idle.style.display = "flex";
    $("track-title").textContent = "—";
    $("track-artist").textContent = "";
    $("track-album").textContent = "";
    $("track-player").textContent = "OFFLINE";
    $("prog-bar").style.width = "0%";
    $("pos").textContent = "-:--";
    $("len").textContent = "-:--";
    $("m-play").innerHTML = ICON.play;
    return;
  }
  $("track-title").textContent = m.title || "(untitled)";
  $("track-artist").textContent = m.artist;
  $("track-album").textContent = m.album;
  $("track-player").textContent = m.identity + " · " + m.status;
  $("m-play").innerHTML = m.status === "Playing" ? ICON.pause : ICON.play;
  $("m-prev").disabled = !m.canPrev;
  $("m-next").disabled = !m.canNext;

  if (m.art && art.dataset.src !== m.art) {
    art.dataset.src = m.art;
    art.src = m.art;
  }
  const showArt = !!m.art;
  art.style.display = showArt ? "block" : "none";
  idle.style.display = showArt ? "none" : "flex";

  if (m.length && m.position != null) {
    $("prog-bar").style.width = Math.min(100, (m.position / m.length) * 100) + "%";
    $("pos").textContent = fmtTime(m.position);
    $("len").textContent = fmtTime(m.length);
  } else {
    $("prog-bar").style.width = "0%";
    $("pos").textContent = fmtTime(m.position);
    $("len").textContent = fmtTime(m.length);
  }
}

$("art").addEventListener("error", () => {
  $("art").style.display = "none";
  $("art-idle").style.display = "flex";
});
$("r-stop").addEventListener("click", stopRadio);
$("r-pause").addEventListener("click", () => {
  if (!radio) return;
  radio.el.paused ? radio.el.play() : radio.el.pause();
  renderMedia(lastState && lastState.media);
});
$("m-play").addEventListener("click", () => send({ cmd: "media", action: "playpause" }));
$("m-prev").addEventListener("click", () => send({ cmd: "media", action: "previous" }));
$("m-next").addEventListener("click", () => send({ cmd: "media", action: "next" }));
$("m-like").addEventListener("click", (e) => heartTap(e.currentTarget));

// ── network ────────────────────────────────────────────────────────

function renderNet(net) {
  if (!net) return;
  const el = $("ifaces");
  const key = JSON.stringify(net.ifaces.map((i) => [i.name, i.ipv4, i.ipv6]));
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = net.ifaces.map(() => `
      <div class="iface">
        <span class="iface-name"></span>
        <span class="iface-ip"></span>
        <span class="iface-rates"><span class="rx"></span><br><span class="tx"></span></span>
      </div>`).join("");
  }
  net.ifaces.forEach((iface, i) => {
    const row = el.children[i];
    if (!row) return;
    row.querySelector(".iface-name").textContent = iface.name;
    row.querySelector(".iface-ip").textContent =
      [...iface.ipv4, ...iface.ipv6].join("  ") || "no address";
    row.querySelector(".rx").textContent = "▼ " + fmtRate(iface.rx);
    row.querySelector(".tx").textContent = "▲ " + fmtRate(iface.tx);
  });

  drawDualArea($("net-spark"), hist.rx, hist.tx, THEME.accent, THEME.accent2);

  const pingsEl = $("pings");
  if (pingsEl.children.length !== net.ping.length) {
    pingsEl.innerHTML = net.ping.map(() => `
      <div class="ping">
        <span class="ping-label"></span>
        <span class="ping-val"></span>
        <canvas></canvas>
        <span class="ping-sub"></span>
      </div>`).join("");
  }
  net.ping.forEach((t, i) => {
    const row = pingsEl.children[i];
    row.querySelector(".ping-label").textContent = t.label;
    const val = row.querySelector(".ping-val");
    if (t.ms == null) {
      val.textContent = "TIMEOUT";
      val.className = "ping-val bad";
    } else {
      val.textContent = t.ms.toFixed(1) + " ms";
      val.className = "ping-val " + (t.ms < 20 ? "good" : t.ms < 60 ? "ok" : t.ms < 150 ? "warn" : "bad");
    }
    const sub = row.querySelector(".ping-sub");
    sub.innerHTML =
      `AVG ${t.avg != null ? t.avg.toFixed(1) : "--"} ms · ` +
      `LOSS <span class="${t.loss > 0 ? "loss-bad" : ""}">${t.loss}%</span>`;
    drawPingBars(row.querySelector("canvas"), t.history);
  });
}

// ── quick actions ──────────────────────────────────────────────────

let customBuilt = "";

function renderActions(a) {
  if (!a) return;
  $("act-dnd").classList.toggle("on", a.dnd === true);
  $("act-dnd").style.display = a.dnd === null ? "none" : "";
  $("act-awake").classList.toggle("on", !!a.awake);

  const key = JSON.stringify(a.custom);
  if (key !== customBuilt) {
    customBuilt = key;
    const holder = $("actions-custom");
    holder.innerHTML = "";
    for (const c of a.custom) {
      const b = document.createElement("button");
      b.className = "act";
      b.innerHTML = `<span class="act-ico"></span><span class="act-lbl"></span>`;
      b.querySelector(".act-ico").textContent = c.icon || "◈";
      b.querySelector(".act-lbl").textContent = c.label;
      b.addEventListener("click", () => send({ cmd: "action", id: c.id }));
      holder.appendChild(b);
    }
  }
}

for (const id of ["act-lock", "act-dnd", "act-awake", "act-logout"]) {
  $(id).addEventListener("click", (e) =>
    send({ cmd: "action", id: e.currentTarget.dataset.action })
  );
}

$("act-theme").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(THEME.name) + 1) % THEMES.length];
  window.__applyTheme(next); // instant, optimistic
  send({ cmd: "theme", name: next }); // Python persists it
});

// ── pages: nav rail + swipe ────────────────────────────────────────

const N_PAGES = 6;
let curPage = 0;

function goPage(n) {
  curPage = Math.max(0, Math.min(N_PAGES - 1, n));
  $("pages").dataset.page = curPage;
  document.querySelectorAll(".rail-btn").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.page) === curPage)
  );
  if (window.__vizPage) window.__vizPage(curPage);
}
document.querySelectorAll(".rail-btn").forEach((b) =>
  b.addEventListener("click", () => goPage(Number(b.dataset.page)))
);

(() => {
  const pages = $("pages");
  let sx = 0, sy = 0, tracking = false;
  pages.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, .slider, .devlist, .nlist, .tlist")) return;
    tracking = true;
    sx = e.clientX;
    sy = e.clientY;
  });
  pages.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy)) {
      goPage(curPage + (dx < 0 ? 1 : -1));
    }
  });
  pages.addEventListener("pointercancel", () => (tracking = false));
})();

// ── notifications page ─────────────────────────────────────────────

function fmtAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "NOW";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function buildNotifColumns(sources) {
  const page = $("notif-cols");
  page.innerHTML = "";
  for (const s of sources) {
    const col = document.createElement("section");
    col.className = "ncol";
    col.dataset.src = s.id;
    col.innerHTML = `
      <div class="ncol-head">
        <span class="ncol-label"></span>
        <span class="ncol-count zero">0</span>
        <span class="ncol-badge" hidden></span>
        <span class="spacer"></span>
        <button class="ncol-clear">CLEAR</button>
      </div>
      <div class="nlist"></div>
      <div class="nempty">NO PENDING<br>TRANSMISSIONS</div>`;
    col.querySelector(".ncol-label").textContent = s.label;
    col.querySelector(".ncol-clear").addEventListener("click", () =>
      send({ cmd: "notif-clear", source: s.id })
    );
    page.appendChild(col);
  }
}

function renderNotifs(n) {
  if (!n || !n.sources) return;
  const page = $("page-notif");
  const srcKey = JSON.stringify(n.sources.map((s) => s.id));
  if (page.dataset.srcs !== srcKey) {
    page.dataset.srcs = srcKey;
    buildNotifColumns(n.sources);
  }

  let total = 0, appTotal = 0;
  for (const s of n.sources) {
    total += s.items.length;
    appTotal += s.badge || 0;
    const col = page.querySelector(`.ncol[data-src="${s.id}"]`);
    if (!col) continue;

    const count = col.querySelector(".ncol-count");
    count.textContent = s.items.length;
    count.classList.toggle("zero", !s.items.length);

    const badge = col.querySelector(".ncol-badge");
    badge.hidden = s.badge == null;
    if (s.badge != null) badge.textContent = "APP " + s.badge;

    const list = col.querySelector(".nlist");
    const key = JSON.stringify(s.items.map((i) => i.id));
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.innerHTML = "";
      for (const it of s.items) {
        const card = document.createElement("div");
        card.className = "ncard";
        card.innerHTML = `
          <div class="ncard-top">
            <span class="ncard-sender"></span>
            <span class="ncard-time"></span>
            <button class="ncard-x">&#10005;</button>
          </div>
          <div class="ncard-body"></div>`;
        card.querySelector(".ncard-sender").textContent = it.sender;
        card.querySelector(".ncard-time").textContent = fmtAgo(it.ts);
        const body = card.querySelector(".ncard-body");
        body.textContent = it.body;
        body.style.display = it.body ? "" : "none";
        card.querySelector(".ncard-x").addEventListener("click", () =>
          send({ cmd: "notif-dismiss", source: s.id, id: it.id })
        );
        list.appendChild(card);
      }
    } else {
      const times = list.querySelectorAll(".ncard-time");
      s.items.forEach((it, i) => {
        if (times[i]) times[i].textContent = fmtAgo(it.ts);
      });
    }
    col.querySelector(".nempty").style.display = s.items.length ? "none" : "";
    list.style.display = s.items.length ? "" : "none";
  }

  const railBadge = $("rail-badge");
  const shown = Math.max(total, appTotal);
  railBadge.hidden = shown === 0;
  railBadge.textContent = shown > 99 ? "99+" : shown;
}

// ── calendar / agenda ──────────────────────────────────────────────

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function dayLabel(d, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((that - today) / 86400000);
  if (diff === 0) return "TODAY";
  if (diff === 1) return "TMRW";
  return DAY_NAMES[d.getDay()] + " " + String(d.getDate()).padStart(2, "0");
}

function clock24(d) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function fmtIn(sec) {
  if (sec < 60) return "in <1m";
  if (sec < 3600) return "in " + Math.floor(sec / 60) + "m";
  return "in " + Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
}

function eventFlags(ev, nowSec) {
  if (!ev.allDay && ev.start <= nowSec && nowSec < ev.end) return { cls: "now", flag: "NOW" };
  const until = ev.start - nowSec;
  if (!ev.allDay && until > 0 && until <= 900) return { cls: "soon", flag: fmtIn(until) };
  return { cls: "", flag: "" };
}

function renderCal(cal) {
  const col = $("agenda");
  const chip = $("next-meeting");
  if (!cal) {
    col.hidden = true;
    chip.hidden = true;
    $("page-notif").classList.add("no-agenda");
    return;
  }
  col.hidden = false;
  $("page-notif").classList.remove("no-agenda");

  const status = $("ag-status");
  if (cal.error) {
    status.textContent = "OFFLINE";
    status.className = "ag-status err";
  } else if (cal.updated) {
    const u = new Date(cal.updated * 1000);
    status.textContent = "SYNC " + clock24(u);
    status.className = "ag-status";
  }

  const now = new Date();
  const nowSec = now.getTime() / 1000;
  // never show anything already over, even if the pushed state is stale
  const events = (cal.events || []).filter((e) => e.end > nowSec);

  const count = $("ag-count");
  count.textContent = events.length;
  count.classList.toggle("zero", !events.length);
  $("ag-empty").style.display = events.length ? "none" : "";
  const list = $("ag-list");
  list.style.display = events.length ? "" : "none";

  const key = JSON.stringify(events.map((e) => [e.start, e.title]));
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = "";
    for (const ev of events) {
      const s = new Date(ev.start * 1000), e = new Date(ev.end * 1000);
      const card = document.createElement("div");
      card.innerHTML = `
        <div class="ecard-when"><span class="ecard-day"></span><span class="ecard-time"></span></div>
        <div class="ecard-main"><div class="ecard-title"></div><div class="ecard-meta"></div></div>
        <span class="ecard-flag"></span>`;
      card.querySelector(".ecard-day").textContent = dayLabel(s, now);
      card.querySelector(".ecard-time").textContent = ev.allDay ? "—" : clock24(s);
      card.querySelector(".ecard-title").textContent = ev.title;
      const range = ev.allDay ? "ALL DAY" : clock24(s) + "–" + clock24(e);
      card.querySelector(".ecard-meta").textContent =
        range + (ev.location ? " · " + ev.location : "");
      card.className = "ecard" + (dayLabel(s, now) === "TODAY" ? " today" : "");
      list.appendChild(card);
    }
  }
  // live flags (NOW / countdown) every tick
  events.forEach((ev, i) => {
    const card = list.children[i];
    if (!card) return;
    const { cls, flag } = eventFlags(ev, nowSec);
    const s = new Date(ev.start * 1000);
    card.className = "ecard" +
      (dayLabel(s, now) === "TODAY" ? " today" : "") + (cls ? " " + cls : "");
    card.querySelector(".ecard-flag").textContent = flag;
  });

  // header chip: ongoing meeting, else next timed event within 12h
  const cand = events.find((e) => !e.allDay && e.start <= nowSec && nowSec < e.end) ||
    events.find((e) => !e.allDay && e.start > nowSec && e.start - nowSec < 43200);
  if (cand) {
    chip.hidden = false;
    const ongoing = cand.start <= nowSec;
    chip.classList.toggle("now", ongoing);
    chip.querySelector(".nm-label").textContent = ongoing ? "MEETING NOW" : "NEXT MEETING";
    chip.querySelector(".nm-title").textContent = cand.title;
    chip.querySelector(".nm-when").textContent = ongoing
      ? "until " + clock24(new Date(cand.end * 1000))
      : clock24(new Date(cand.start * 1000)) + " · " + fmtIn(cand.start - nowSec);
  } else {
    chip.hidden = true;
  }
}

// ── world clocks page ──────────────────────────────────────────────

const WGLYPH = {
  "01d": "☀", "01n": "☾", "02d": "⛅", "02n": "☁",
  "03d": "☁", "03n": "☁", "04d": "☁", "04n": "☁",
  "09d": "☂", "09n": "☂", "10d": "☂", "10n": "☂",
  "11d": "⚡", "11n": "⚡", "13d": "❄", "13n": "❄",
  "50d": "≋", "50n": "≋",
};

const _wfmt = {}; // per-timezone Intl formatter cache

function wFormats(tz) {
  if (!_wfmt[tz]) {
    try {
      _wfmt[tz] = {
        time: new Intl.DateTimeFormat("en-GB", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
        }),
        date: new Intl.DateTimeFormat("en-GB", {
          timeZone: tz, weekday: "short", day: "2-digit", month: "short",
          timeZoneName: "shortOffset",
        }),
        hour: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hour12: false }),
      };
    } catch (e) {
      _wfmt[tz] = null;
    }
  }
  return _wfmt[tz];
}

function tickWorldClocks(now) {
  document.querySelectorAll(".w-clock[data-tz]").forEach((el) => {
    const f = wFormats(el.dataset.tz);
    if (!f) return;
    el.textContent = f.time.format(now);
    const h = Number(f.hour.format(now));
    el.classList.toggle("night", h < 7 || h >= 19);
  });
  document.querySelectorAll(".w-date[data-tz]").forEach((el) => {
    const f = wFormats(el.dataset.tz);
    if (f) el.textContent = f.date.format(now).replace(",", " ·");
  });
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function renderWorld(w) {
  const page = $("page-world");
  if (!w || !w.cities || !w.cities.length) {
    page.dataset.key = "";
    return;
  }
  const key = JSON.stringify(w);
  if (page.dataset.key === key) return;
  page.dataset.key = key;
  page.innerHTML = "";

  for (const c of w.cities) {
    const card = document.createElement("section");
    card.className = "panel wcity";

    const h2 = document.createElement("h2");
    h2.textContent = `${c.name} · ${c.country}`;
    if (c.home) {
      const chip = document.createElement("span");
      chip.className = "home-chip";
      chip.textContent = "HOME";
      h2.appendChild(chip);
    }
    card.appendChild(h2);

    if (c.holidayToday) {
      const hol = document.createElement("div");
      hol.className = "w-holiday";
      hol.textContent = "PUBLIC HOLIDAY — " + c.holidayToday;
      card.appendChild(hol);
    }

    const clockBlock = document.createElement("div");
    clockBlock.className = "w-clockblock";
    clockBlock.innerHTML = `<div class="w-clock"></div><div class="w-date"></div>`;
    clockBlock.querySelector(".w-clock").dataset.tz = c.tz;
    clockBlock.querySelector(".w-date").dataset.tz = c.tz;
    card.appendChild(clockBlock);

    const wx = document.createElement("div");
    wx.className = "w-weather" + (c.weather ? "" : " na");
    if (c.weather) {
      const wd = c.weather;
      const wind = wd.windMs != null ? Math.round(wd.windMs * 3.6) + " km/h" : "--";
      wx.innerHTML = `
        <span class="w-glyph">${WGLYPH[wd.icon] || "☀"}</span>
        <span class="w-temp">${Math.round(wd.temp)}°</span>
        <div class="w-wmeta">
          <div class="w-desc"></div>
          <div class="w-sub">FEELS ${Math.round(wd.feels)}° · RH ${wd.humidity}% · ${wind}</div>
        </div>`;
      wx.querySelector(".w-desc").textContent = wd.desc;
    } else {
      wx.innerHTML = `
        <span class="w-glyph">—</span>
        <span class="w-temp">--°</span>
        <div class="w-wmeta"><div class="w-desc">AWAITING WEATHER DATA</div>
        <div class="w-sub">check openweather api key</div></div>`;
    }
    card.appendChild(wx);

    if (c.weather && c.weather.forecast && c.weather.forecast.length) {
      const fc = document.createElement("div");
      fc.className = "w-fc";
      for (const d of c.weather.forecast) {
        const day = new Date(d.date + "T12:00:00");
        const tile = document.createElement("div");
        tile.className = "w-fc-day";
        tile.innerHTML = `
          <span class="w-fc-name">${DAY_NAMES[day.getDay()]}</span>
          <span class="w-fc-glyph">${WGLYPH[d.icon] || "☀"}</span>
          <span class="w-fc-max">${Math.round(d.max)}°</span>
          <span class="w-fc-min">${Math.round(d.min)}°</span>`;
        fc.appendChild(tile);
      }
      card.appendChild(fc);
    }

    const nxt = document.createElement("div");
    nxt.className = "w-next";
    if (c.nextHoliday) {
      const d = new Date(c.nextHoliday.date + "T00:00:00");
      nxt.innerHTML = `NEXT HOLIDAY: <b></b> · ${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} · in ${c.nextHoliday.days}d`;
      nxt.querySelector("b").textContent = c.nextHoliday.name;
    } else {
      nxt.textContent = "NEXT HOLIDAY: —";
    }
    card.appendChild(nxt);

    page.appendChild(card);
  }
  tickWorldClocks(new Date());
}

// ── taskwarrior page ───────────────────────────────────────────────

let taskFilter = "ALL";
const pendingDone = new Map(); // uuid -> timeout id (UNDO window running)
const sentDone = new Set(); // sent to python, hidden until the feed catches up

function fmtDue(due, nowSec) {
  const d = new Date(due * 1000);
  if (due < nowSec) {
    const od = Math.floor((nowSec - due) / 86400);
    return od < 1 ? "OVERDUE" : `OVERDUE ${od}d`;
  }
  const days = Math.floor((due - nowSec) / 86400);
  if (days < 1) return "DUE " + clock24(d);
  if (days < 7) return "DUE " + DAY_NAMES[d.getDay()];
  return "DUE " + String(d.getDate()).padStart(2, "0") + " " + MONTHS[d.getMonth()];
}

function setPendingUI(row, pending) {
  row.classList.toggle("pending", pending);
  row.querySelector(".tdone").textContent = pending ? "UNDO" : "✓";
}

function taskDoneTap(row, uuid) {
  const tid = pendingDone.get(uuid);
  if (tid !== undefined) { // UNDO — nothing was sent yet
    clearTimeout(tid);
    pendingDone.delete(uuid);
    setPendingUI(row, false);
    return;
  }
  setPendingUI(row, true);
  pendingDone.set(uuid, setTimeout(() => {
    pendingDone.delete(uuid);
    sentDone.add(uuid);
    send({ cmd: "task-done", uuid });
    row.classList.add("gone");
    setTimeout(() => renderTasks(lastState && lastState.tasks), 320);
  }, 5000));
}

function renderTasks(t) {
  if (!t) return;
  const status = $("task-status");
  if (t.error) {
    status.textContent = t.error.toUpperCase().slice(0, 44);
    status.className = "ag-status err";
  } else if (t.updated) {
    status.textContent = "SYNC " + clock24(new Date(t.updated * 1000));
    status.className = "ag-status";
  }

  // prune sentDone once the feed no longer reports the uuid
  if (sentDone.size) {
    const raw = new Set((t.items || []).map((it) => it.uuid));
    for (const u of [...sentDone]) if (!raw.has(u)) sentDone.delete(u);
  }
  const items = (t.items || []).filter((it) => !sentDone.has(it.uuid));

  // filter chips: ALL + tags (+x) + projects (#x), derived from the items
  const tags = new Set(), projects = new Set();
  for (const it of items) {
    for (const x of it.tags) tags.add(x);
    if (it.project) projects.add(it.project);
  }
  const chips = ["ALL",
    ...[...tags].sort().map((x) => "+" + x),
    ...[...projects].sort().map((x) => "#" + x)];
  if (!chips.includes(taskFilter)) taskFilter = "ALL";
  const chipsEl = $("task-chips");
  const chipKey = JSON.stringify(chips) + "|" + taskFilter;
  if (chipsEl.dataset.key !== chipKey) {
    chipsEl.dataset.key = chipKey;
    chipsEl.innerHTML = "";
    for (const c of chips) {
      const b = document.createElement("button");
      b.className = "tchip" + (c === taskFilter ? " on" : "");
      b.textContent = c;
      b.addEventListener("click", () => {
        taskFilter = c;
        renderTasks(lastState && lastState.tasks);
      });
      chipsEl.appendChild(b);
    }
  }

  const visible = items.filter((it) =>
    taskFilter === "ALL" ||
    (taskFilter[0] === "+" && it.tags.includes(taskFilter.slice(1))) ||
    (taskFilter[0] === "#" && it.project === taskFilter.slice(1)));

  $("task-empty").hidden = visible.length > 0 || !!t.error;
  const list = $("task-list");
  list.style.display = visible.length ? "" : "none";

  const key = JSON.stringify(visible.map((it) =>
    [it.uuid, it.description, it.project, it.tags, it.due]));
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = "";
    for (const it of visible) {
      const row = document.createElement("div");
      row.className = "trow";
      row.dataset.uuid = it.uuid;
      row.innerHTML = `
        <button class="tdone">✓</button>
        <div class="tmain">
          <div class="tdesc"></div>
          <div class="tmeta"><span class="tmeta-base"></span><span class="tdue"></span></div>
        </div>
        <div class="turg"></div>
        <div class="tundo-bar"></div>`;
      row.querySelector(".tdesc").textContent = it.description;
      const meta = [];
      if (it.project) meta.push("#" + it.project);
      for (const x of it.tags) meta.push("+" + x);
      row.querySelector(".tmeta-base").textContent = meta.join("  ");
      row.querySelector(".turg").textContent = (it.urgency || 0).toFixed(1);
      row.querySelector(".tdone").addEventListener("click", () => taskDoneTap(row, it.uuid));
      if (pendingDone.has(it.uuid)) setPendingUI(row, true);
      list.appendChild(row);
    }
  }

  // live due flags every tick (rows can turn overdue while displayed)
  const nowSec = Date.now() / 1000;
  visible.forEach((it, i) => {
    const row = list.children[i];
    if (!row) return;
    const dueEl = row.querySelector(".tdue");
    const txt = it.due ? fmtDue(it.due, nowSec) : "";
    const withSep = txt && row.querySelector(".tmeta-base").textContent ? "  ·  " + txt : txt;
    if (dueEl.textContent !== withSep) dueEl.textContent = withSep;
    row.classList.toggle("overdue", !!it.due && it.due < nowSec);
    row.classList.toggle("soon", !!it.due && it.due >= nowSec && it.due - nowSec < 86400);
  });
}

// disable long-press context menu (touchscreen)
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ── go ─────────────────────────────────────────────────────────────

send({ cmd: "ready" });
