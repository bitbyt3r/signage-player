// Frame timing stats for the dashboard. A requestAnimationFrame loop for the
// page's lifetime records frame intervals; about every 5 s the frames since
// the last report are summarised, together with the graphics that were on
// screen meanwhile, and POSTed to signage-web's /perf. signage-web writes
// /run/signage/perf.json, which the dashboard agent reads. See
// docs/player.md ("Performance stats").
//
// Cheap on purpose: one preallocated ring of intervals, no allocation per
// frame, nothing measured while the page is hidden, and nothing here ever
// throws into the player.

const REPORT_MS = 5000;
const CAPACITY = 4096; // 5 s at up to ~800 Hz
const LONG_FRAME_MS = 50;
const MAX_ACTIVE = 32;
const MAX_BODY = 4000; // signage-web's limit is 4096 bytes

const enc = new TextEncoder();
const bytes = (str) => enc.encode(str).length;
const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const nowS = () => Date.now() / 1000;

/**
 * Summarise the first n frame intervals (ms) in `intervals`. `scratch` is a
 * Float64Array at least n long, used for sorting. Pure, for the unit tests.
 */
export function summarize(intervals, n, scratch) {
    if (n <= 0) return { window: 0, frames: 0 };
    let sum = 0, long = 0;
    for (let i = 0; i < n; i++) {
        const v = intervals[i];
        scratch[i] = v;
        sum += v;
        if (v > LONG_FRAME_MS) long++;
    }
    const sorted = scratch.subarray(0, n).sort();
    const pct = (p) => round1(sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]);
    return {
        window: round3(sum / 1000),
        frames: n,
        fps: round1(n / (sum / 1000)),
        frame_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: round1(sorted[n - 1]) },
        long_frames: long,
    };
}

/**
 * What was on screen between windowStart and now (unix s): every entry
 * that ended during the window plus the ones still showing, `from` clipped
 * to the window start. Front layer (highest `layer`) first, at most
 * MAX_ACTIVE.
 */
export function activeList(showing, ended, windowStart) {
    const out = [];
    const add = (e, to) => {
        const a = { layer: e.layer, layer_name: e.layer_name, package: e.package };
        if (e.version != null) a.version = e.version;
        if (e.label) a.label = e.label;
        a.from = round3(Math.max(e.from, windowStart));
        a.to = to == null ? null : round3(to);
        out.push(a);
    };
    for (const e of showing.values()) add(e, null);
    for (const e of ended) if (e.to >= windowStart) add(e, e.to);
    out.sort((x, y) => y.layer - x.layer || x.from - y.from);
    return out.slice(0, MAX_ACTIVE);
}

function rendererName() {
    const m = /Firefox\/([\d.]+)/.exec(navigator.userAgent);
    return m ? `firefox-esr ${m[1]}` : navigator.userAgent.slice(0, 64);
}

// ---------------------------------------------------------------- on screen

const showing = new Map(); // key -> {layer, layer_name, package, version, label, from}
let ended = [];            // entries that went away since the last report

/** A graphic (or the status screen) became visible under `key`. */
export function markVisible(key, info) {
    try {
        markHidden(key);
        showing.set(key, { ...info, from: nowS() });
    } catch { /* never break the player */ }
}

/** Whatever was visible under `key` is going away. */
export function markHidden(key) {
    try {
        const e = showing.get(key);
        if (!e) return;
        showing.delete(key);
        if (ended.length < MAX_ACTIVE * 2) ended.push({ ...e, to: nowS() });
    } catch { /* never break the player */ }
}

// ---------------------------------------------------------------- frames

export function startPerf({ url = "/perf", everyMs = REPORT_MS } = {}) {
    const intervals = new Float64Array(CAPACITY);
    const scratch = new Float64Array(CAPACITY);
    const renderer = rendererName();
    let n = 0;
    let last = -1;
    let windowStart = nowS();

    const frame = (ts) => {
        if (last >= 0 && n < CAPACITY) intervals[n++] = ts - last;
        last = ts;
        requestAnimationFrame(frame);
    };
    // rAF stops while hidden; don't count the gap when it comes back.
    document.addEventListener("visibilitychange", () => { last = -1; });

    const report = () => {
        try {
            const t = nowS();
            const active = activeList(showing, ended, windowStart);
            ended = [];
            windowStart = t;
            if (document.hidden) { n = 0; return; }
            const s = summarize(intervals, n, scratch);
            n = 0;
            const msg = { t: round3(t), ...s, renderer, layout: globalThis.signageDisplay?.layout || "screen", active };
            let body = JSON.stringify(msg);
            // signage-web takes at most 4 KB: drop back-layer entries to fit.
            while (bytes(body) > MAX_BODY && active.length) { active.pop(); body = JSON.stringify(msg); }
            fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
        } catch (e) {
            console.warn("[perf]", e);
        }
    };

    requestAnimationFrame(frame);
    return setInterval(report, everyMs);
}
