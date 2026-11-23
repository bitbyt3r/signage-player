// Performance charts for one device: the last hour of 10-second samples as
// small multiples (one measure per chart, one y-axis each) sharing a time
// axis. Hovering any chart puts a crosshair on all of them and shows one
// readout with every value at that time and the graphics that were on screen.

let h, api;
export function initPerf(deps) { ({ h, api } = deps); }

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};

const CHARTS = [
  { title: "Frame time", unit: "ms", series: [["frame_p50", "median"], ["frame_p95", "95th percentile"]], min: 0, floorMax: 40 },
  { title: "Frame rate", unit: "fps", series: [["fps", "fps"]], min: 0, floorMax: 60 },
  { title: "CPU and GPU", unit: "%", series: [["cpu", "CPU"], ["cpu_max_core", "busiest core"], ["gpu_busy", "GPU"]], min: 0, max: 100 },
  { title: "Memory", unit: "MB", series: [["mem_used_mb", "used"], ["ff_rss_mb", "Firefox"]], min: 0, maxKey: "mem_total_mb" },
  { title: "Temperature", unit: "°C", series: [["temp_cpu", "CPU"], ["temp_gpu", "GPU"]], floorMax: 60 },
];
const GAP = 25;            // seconds without a sample that break a line
const W = 560, H = 150, PAD = { l: 40, r: 92, t: 10, b: 22 };

const fmt = (v, unit) => (v === undefined || v === null ? "–"
  : `${Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit === "%" || unit === "°C" ? "" : " "}${unit}`);
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) || v;
}

function activeAt(sample, t) {
  return (sample?.active || []).filter((a) => (a.from ?? -Infinity) <= t + 0.5 && (a.to == null || a.to >= t - 0.5));
}

export function perfPanel(deviceId) {
  const box = h("div", { class: "perf" });
  const tip = h("div", { class: "perf-tip", hidden: true, role: "status" });
  const note = h("p", { class: "muted small" }, "Loading…");
  let samples = [], t0 = 0, t1 = 0, charts = [];

  const xOf = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const tOf = (x) => t0 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);

  function nearest(t) {
    let best = null;
    for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) <= GAP ? best : null;
  }

  function showAt(t, ev) {
    const s = nearest(t);
    for (const c of charts) {
      c.cross.setAttribute("x1", s ? xOf(s.t) : -10);
      c.cross.setAttribute("x2", s ? xOf(s.t) : -10);
      c.cross.style.display = s ? "" : "none";
    }
    if (!s) { tip.hidden = true; return; }
    const rows = [h("div", { class: "perf-tip-time" }, new Date(s.t * 1000).toLocaleTimeString())];
    CHARTS.forEach((cfg) => {
      const vals = cfg.series.filter(([k]) => s[k] != null);
      if (!vals.length) return;
      rows.push(h("div", { class: "perf-tip-row" }, h("span", { class: "muted" }, cfg.title),
        h("span", {}, ...vals.map(([k, label], i) => h("span", { class: "perf-tip-val" },
          h("i", { class: `key s${i + 1}` }), h("strong", {}, fmt(s[k], cfg.unit)), cfg.series.length > 1 ? ` ${label}` : "")))));
    });
    if (s.long_frames) rows.push(h("div", { class: "perf-tip-row" }, h("span", { class: "muted" }, "Long frames"), h("strong", {}, `${s.long_frames} over 50 ms`)));
    const act = activeAt(s, s.t);
    const all = act.length ? act : s.active || [];
    rows.push(h("div", { class: "perf-tip-head" }, "On screen"));
    if (!all.length) rows.push(h("div", { class: "muted small" }, s.fps == null ? "no data from the player" : "nothing reported"));
    for (const a of all) {
      const name = a.package === "status-screen" ? "Status screen" : (a.label || a.package);
      rows.push(h("div", { class: "perf-tip-act" },
        h("span", { class: "muted" }, a.layer_name || (a.layer >= 0 ? `Layer ${a.layer}` : "")), " ",
        h("strong", {}, name), a.package !== "status-screen" ? h("span", { class: "muted" }, ` ${a.label ? `${a.package} ` : ""}${a.version || ""}`) : ""));
    }
    tip.replaceChildren(...rows);
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const tw = tip.offsetWidth;
    tip.style.left = `${x + 16 + tw > r.width ? Math.max(0, x - 16 - tw) : x + 16}px`;
    tip.style.top = `${Math.max(0, y - 20)}px`;
  }

  function chart(cfg) {
    const present = cfg.series.filter(([k]) => samples.some((s) => s[k] != null));
    const vals = samples.flatMap((s) => present.map(([k]) => s[k])).filter((v) => v != null);
    let max = cfg.max ?? (cfg.maxKey ? Math.max(0, ...samples.map((s) => s[cfg.maxKey] || 0)) : 0);
    if (!cfg.max && !(cfg.maxKey && max)) max = niceMax(Math.max(max, cfg.floorMax || 0, ...vals) * 1.1);
    const min = cfg.min ?? Math.max(0, Math.floor((Math.min(...vals, max) - 5) / 10) * 10);
    const yOf = (v) => PAD.t + (1 - (v - min) / (max - min || 1)) * (H - PAD.t - PAD.b);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "perf-svg", role: "img", "aria-label": `${cfg.title}, last hour` });
    // grid + y labels
    for (let i = 0; i <= 2; i++) {
      const v = min + ((max - min) * i) / 2, y = yOf(v);
      g.append(svg("line", { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, class: "grid" }),
        svg("text", { x: PAD.l - 6, y: y + 4, class: "axis", "text-anchor": "end" }, Math.round(v)));
    }
    // x labels every 15 minutes
    for (let t = Math.ceil(t0 / 900) * 900; t <= t1; t += 900) {
      g.append(svg("text", { x: xOf(t), y: H - 6, class: "axis", "text-anchor": "middle" }, clock(t)));
    }
    if (cfg.maxKey && max) g.append(svg("text", { x: W - PAD.r + 6, y: yOf(max) + 4, class: "axis" }, "total"));
    // lines, broken at gaps; end labels name each series (identity is never color alone)
    const ends = [];
    cfg.series.forEach(([k, label], i) => {
      if (!present.some(([pk]) => pk === k)) return;
      let d = "", prev = null, last = null;
      for (const s of samples) {
        if (s[k] == null) { prev = null; continue; }
        const x = xOf(s.t).toFixed(1), y = yOf(Math.min(max, Math.max(min, s[k]))).toFixed(1);
        d += `${prev && s.t - prev.t <= GAP ? "L" : "M"}${x},${y}`;
        prev = s;
        last = s;
      }
      g.append(svg("path", { d, class: `ln s${i + 1}` }));
      if (last && cfg.series.length > 1) ends.push({ y: yOf(last[k]), label, i, x: xOf(last.t) });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let j = 1; j < ends.length; j++) ends[j].y = Math.max(ends[j].y, ends[j - 1].y + 12);
    for (const e of ends) g.append(svg("text", { x: W - PAD.r + 6, y: e.y + 4, class: `end s${e.i + 1}t` }, e.label));
    const cross = svg("line", { x1: -10, x2: -10, y1: PAD.t, y2: H - PAD.b, class: "cross" });
    g.append(cross);
    const hit = svg("rect", { x: PAD.l, y: 0, width: W - PAD.l - PAD.r, height: H, fill: "transparent" });
    g.append(hit);
    const move = (ev) => {
      const r = g.getBoundingClientRect();
      showAt(tOf(((ev.clientX - r.left) / r.width) * W), ev);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { tip.hidden = true; charts.forEach((c) => (c.cross.style.display = "none")); });
    const last = [...samples].reverse().find((s) => present.some(([k]) => s[k] != null));
    const legend = cfg.series.length > 1 ? h("span", {}, present.map(([k, label]) => {
      const i = cfg.series.findIndex(([kk]) => kk === k);
      return h("span", {}, h("i", { class: `key s${i + 1}` }), label);
    })) : "";
    const el = h("figure", { class: "perf-chart" },
      h("figcaption", {}, h("strong", {}, cfg.title), " ",
        h("span", { class: "muted small" }, last ? present.map(([k]) => fmt(last[k], cfg.unit)).join(" · ") : "no data")),
      h("div", { class: "perf-legend" }, legend || "\u00a0"),
      g);
    if (!present.length) {
      el.classList.add("empty");
      g.replaceChildren(svg("text", { x: W / 2, y: H / 2, class: "axis", "text-anchor": "middle" },
        cfg.title === "Frame time" || cfg.title === "Frame rate" ? "No frame timings from the player yet" : "Not reported by this device"));
    }
    charts.push({ cross });
    return el;
  }

  async function load() {
    const r = await api("GET", `/api/devices/${deviceId}/perf?minutes=60`);
    samples = r.samples;
    t1 = r.now;
    t0 = t1 - 3600;
    charts = [];
    if (!samples.length) {
      note.textContent = "No performance samples in the last hour. Devices running an older agent don't send them.";
      box.replaceChildren(note);
      return;
    }
    const grid = h("div", { class: "perf-grid" }, CHARTS.map(chart));
    box.replaceChildren(grid, tip,
      h("details", { class: "small" }, h("summary", {}, "Table of the last 10 minutes"), table()));
  }

  function table() {
    const recent = samples.filter((s) => s.t >= t1 - 600).reverse();
    const cols = [["t", "Time"], ["fps", "fps"], ["frame_p95", "p95 ms"], ["cpu", "CPU %"], ["gpu_busy", "GPU %"],
      ["mem_used_mb", "Mem MB"], ["temp_cpu", "CPU °C"], ["temp_gpu", "GPU °C"]];
    return h("div", { class: "table-wrap" }, h("table", { class: "small" },
      h("thead", {}, h("tr", {}, cols.map(([, l]) => h("th", {}, l)), h("th", {}, "On screen"))),
      h("tbody", {}, recent.map((s) => h("tr", {},
        cols.map(([k]) => h("td", { class: "mono" }, k === "t" ? new Date(s.t * 1000).toLocaleTimeString() : s[k] ?? "–")),
        h("td", {}, (s.active || []).map((a) => a.label || a.package).join(", ")))))));
  }

  box.append(note);
  box.load = () => load().catch((e) => { note.textContent = e.message; box.replaceChildren(note); });
  box.load();
  return box;
}
