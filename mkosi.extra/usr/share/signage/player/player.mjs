// The signage player. Polls /content.json, keeps one runner per program
// layer and shows the status screen when nothing is eligible to play.
// See docs/player.md for the behaviour and the content.json contract.
import { isEligible, problems } from "./eligibility.mjs";
import { esc, getJson, dashboardState, startUpdateBar } from "./status.mjs";
import { setupDisplay, spanOutputs, wantedLayout } from "./display.mjs";
import { startPerf, markVisible, markHidden } from "./perf.mjs";

const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";
const NO_STATUS = params.get("status") === "0";
const POLL_MS = 2000;
const TICK_MS = 1000;
const FAIL_SKIP_MS = 60000;
const T_STOP = 5000, T_DISPOSE = 3000, T_LOAD = 15000, T_PLAY = 10000;

const DEMO_CONTENT = {
    rev: "demo", program: { id: "demo", name: "Demo" },
    layers: [{ name: "Demo", layer: 0, items: [{
        package: "magfest-demo-lower-third", version: "baked", url: "/packages/demo-lower-third/",
        manifest: "demo-lower-third.ograf.json", main: "graphic.mjs", duration: 0, data: {},
    }] }],
};

const log = (...a) => console.log("[player]", ...a);
const warn = (...a) => console.warn("[player]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(t)),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); }),
    ]);
}

// An OGraf action may report failure in its return value instead of throwing.
function checkResult(res, what) {
    if (res && typeof res === "object" && Number(res.statusCode) >= 300) {
        throw new Error(`${what}: ${res.statusCode} ${res.statusMessage || ""}`.trim());
    }
    return res;
}

const sameData = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const samePkg = (a, b) => a && b && a.package === b.package && a.version === b.version && a.url === b.url;
const sameItem = (a, b) => samePkg(a, b) && sameData(a.data, b.data);
const itemKey = (it) => `${it.package}@${it.version}|${JSON.stringify(it.data ?? {})}`;
const itemName = (it) => `${it.label || it.package} (${it.package} ${it.version})`;
const joinUrl = (base, rel) => new URL(rel, new URL(base.endsWith("/") ? base : base + "/", location.href)).href;

// ---------------------------------------------------------------- graphics

// One custom element name per package@version, defined once: the element
// registry can't redefine a name, and new code always comes with a new
// version (and URL).
const definedTags = new Map(); // tag -> module URL

function tagFor(item, moduleUrl) {
    const base = `ograf-${item.package}-${item.version}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    let tag = base, n = 1;
    while (definedTags.has(tag) && definedTags.get(tag) !== moduleUrl) tag = `${base}-${++n}`;
    return tag;
}

async function createGraphic(item) {
    const manifestUrl = joinUrl(item.url, item.manifest || "");
    const r = await fetch(manifestUrl, { cache: "no-store" });
    if (!r.ok) throw new Error(`manifest ${manifestUrl}: HTTP ${r.status}`);
    const manifest = await r.json();
    const main = item.main || manifest.main;
    if (!main) throw new Error(`${manifestUrl} names no main module`);
    const moduleUrl = joinUrl(item.url, main);
    const tag = tagFor(item, moduleUrl);
    if (!customElements.get(tag)) {
        const mod = await import(moduleUrl);
        if (typeof mod.default !== "function") throw new Error(`${moduleUrl} has no default export class`);
        customElements.define(tag, class extends mod.default {});
        definedTags.set(tag, moduleUrl);
    }
    const defaults = {};
    for (const [k, v] of Object.entries(manifest.schema?.properties || {})) {
        if (v && "default" in v) defaults[k] = v.default;
    }
    // One element per canvas root (display.mjs): one on a screen, a copy
    // per view on a sliced layout.
    return { els: ROOTS.map(() => document.createElement(tag)), manifest, defaults };
}

// Run an action on every copy of a graphic at once (called in the same
// task, so animations they start share a start time) and wait for all.
const all = (els, fn) => Promise.all(els.map((el) => fn(el)));

// ---------------------------------------------------------------- layers

class LayerRunner {
    constructor(def) {
        // One container per canvas root; the graphic's copies go in them.
        this.containers = ROOTS.map(() => {
            const c = document.createElement("div");
            c.className = "layer";
            return c;
        });
        this.current = null;   // {item, els, defaults, started}
        this.index = -1;       // position of the current item in this.items
        this.busy = false;     // a transition is running
        this.failed = new Map(); // itemKey -> skip until (ms)
        this.closed = false;
        this.apply(def);
    }

    apply(def) {
        this.def = def;
        this.name = def.name || `layer ${def.layer}`;
        this.perfKey ??= `layer:${Math.random()}`; // perf.mjs's on-screen list
        this.items = Array.isArray(def.items) ? def.items : [];
        for (const c of this.containers) {
            c.style.zIndex = String(Number(def.layer) || 0);
            c.dataset.layer = this.name;
        }
        for (const it of this.items) {
            for (const p of problems(it)) warn(`${this.name}: ${itemName(it)}: ${p}`);
        }
        if (this.current) this.adoptCurrent();
    }

    // After a content change: keep the running graphic if the new list still
    // has it (same package, version and data), or if it is the only eligible
    // item and only its data changed (then updateAction).
    adoptCurrent() {
        const cur = this.current;
        const i = this.items.findIndex((it) => sameItem(it, cur.item));
        if (i >= 0) {
            cur.item = this.items[i];
            this.index = i;
            return;
        }
        const now = new Date();
        const eligible = this.items.filter((it) => this.playable(it, now));
        if (eligible.length === 1 && samePkg(eligible[0], cur.item)) {
            const next = eligible[0];
            this.index = this.items.indexOf(next);
            const prev = cur.item;
            cur.item = next;
            if (!sameData(prev.data, next.data)) this.update(cur, next);
            return;
        }
        cur.stale = true; // tick() transitions away from it
    }

    async update(cur, item) {
        if (typeof cur.els[0].updateAction !== "function") return;
        try {
            const data = { ...cur.defaults, ...(item.data || {}) };
            const res = await withTimeout(all(cur.els, (el) => el.updateAction({ data: structuredClone(data) })), T_PLAY, "updateAction");
            for (const r of res) checkResult(r, "updateAction");
            log(`${this.name}: updated ${itemName(item)}`);
        } catch (e) {
            this.fail(item, e);
            cur.stale = true;
        }
    }

    playable(it, now) {
        const until = this.failed.get(itemKey(it));
        if (until && until > Date.now()) return false;
        return isEligible(it, now);
    }

    hasEligible(now = new Date()) {
        return this.items.some((it) => this.playable(it, now)) || !!(this.current && !this.current.stale && isEligible(this.current.item, now));
    }

    // The next eligible item after position `from`, wrapping; null if none.
    nextEligible(from, now) {
        const n = this.items.length;
        for (let k = 1; k <= n; k++) {
            const i = (from + k + n) % n;
            if (this.playable(this.items[i], now)) return i;
        }
        return -1;
    }

    tick() {
        if (this.busy || this.closed) return;
        const now = new Date();
        // Content changed while this graphic was still loading.
        if (this.current && !this.items.includes(this.current.item)) this.adoptCurrent();
        const cur = this.current;
        if (cur) {
            const gone = cur.stale || !isEligible(cur.item, now);
            const dur = Number(cur.item.duration) || 0;
            const expired = dur > 0 && Date.now() - cur.started >= dur * 1000;
            if (!gone && !expired) return;
            const i = this.nextEligible(this.index, now);
            if (!gone && i === this.index) {
                cur.started = Date.now(); // the only eligible item: keep it running
                return;
            }
            this.transition(i);
        } else {
            const i = this.nextEligible(this.index, now);
            if (i >= 0) this.transition(i);
        }
    }

    async transition(i) {
        this.busy = true;
        try {
            await this.takeDown();
            if (this.closed || i < 0) return;
            const item = this.items[i];
            this.index = i;
            await this.mount(item);
        } finally {
            this.busy = false;
        }
    }

    async takeDown() {
        const cur = this.current;
        if (!cur) return;
        this.current = null;
        markHidden(this.perfKey);
        try {
            const res = await withTimeout(all(cur.els, (el) => el.stopAction?.({})), T_STOP, "stopAction");
            for (const r of res) checkResult(r, "stopAction");
        } catch (e) { warn(`${this.name}: ${itemName(cur.item)}: ${e.message}`); }
        await this.dispose(cur);
    }

    async dispose(cur) {
        try { await withTimeout(all(cur.els, (el) => el.dispose?.({})), T_DISPOSE, "dispose"); } catch (e) { warn(`${this.name}: ${itemName(cur.item)}: ${e.message}`); }
        for (const el of cur.els) el.remove();
    }

    async mount(item) {
        let g;
        try {
            g = await createGraphic(item);
            g.els.forEach((el, i) => this.containers[i].append(el));
            const data = { ...g.defaults, ...(item.data || {}) };
            const loaded = await withTimeout(all(g.els, (el) => el.load({
                data: structuredClone(data),
                renderType: "realtime",
                renderCharacteristics: { resolution: { width: DISPLAY.width, height: DISPLAY.height } },
            })), T_LOAD, "load");
            for (const r of loaded) checkResult(r, "load");
            const cur = { item, els: g.els, defaults: g.defaults, started: Date.now() };
            this.current = cur;
            const played = await withTimeout(all(g.els, (el) => el.playAction({})), T_PLAY, "playAction");
            for (const r of played) checkResult(r, "playAction");
            cur.started = Date.now();
            markVisible(this.perfKey, { layer: Number(this.def.layer) || 0, layer_name: this.name,
                package: item.package, version: item.version, label: item.label });
            log(`${this.name}: playing ${itemName(item)}`);
        } catch (e) {
            this.fail(item, e);
            if (g) await this.dispose({ item, els: g.els });
            this.current = null;
        }
    }

    fail(item, e) {
        console.error(`[player] ${this.name}: ${itemName(item)} failed, skipping it for 60 s:`, e);
        this.failed.set(itemKey(item), Date.now() + FAIL_SKIP_MS);
    }

    async close() {
        this.closed = true;
        while (this.busy) await sleep(100);
        await this.takeDown();
        markHidden(this.perfKey);
        for (const c of this.containers) c.remove();
    }
}

// ---------------------------------------------------------------- content

const layersEl = document.getElementById("layers");
// The display layout (display.mjs): an ordinary screen, or the arch's one
// logical canvas sliced to the LED controller. Fixed for the page's life;
// a change in display.json reloads the page.
// On a sliced layout every graphic runs once per canvas root (ROOTS).
const LAYOUT = (await wantedLayout()) || "screen";
const { display: DISPLAY, roots: ROOTS } = setupDisplay(LAYOUT, layersEl, document.getElementById("frame"),
    LAYOUT === "screen" ? await spanOutputs() : null);
log(`layout ${DISPLAY.layout}${DISPLAY.outputs ? ` across ${DISPLAY.outputs.map((o) => o.name).join(" + ")}` : ""}, canvas ${DISPLAY.width}x${DISPLAY.height}, ${ROOTS.length} cop${ROOTS.length === 1 ? "y" : "ies"}`);
const runners = new Map(); // layer key -> LayerRunner
let content = null, rev = null, contentError = "";

const layerKey = (l) => `${Number(l.layer) || 0}|${l.name || ""}`;

function reconcile(next) {
    content = next;
    const wanted = new Map((next?.layers || []).map((l) => [layerKey(l), l]));
    for (const [k, r] of runners) {
        if (!wanted.has(k)) { runners.delete(k); r.close(); log(`layer removed: ${r.name}`); }
    }
    for (const [k, l] of wanted) {
        const r = runners.get(k);
        if (r) r.apply(l);
        else {
            const nr = new LayerRunner(l);
            runners.set(k, nr);
            nr.containers.forEach((c, i) => ROOTS[i].append(c));
            log(`layer added: ${nr.name}`);
        }
    }
    tick();
}

async function poll() {
    const layout = await wantedLayout();
    if (layout && layout !== DISPLAY.layout) {
        log(`layout changed to ${layout}; reloading`);
        location.reload();
        return;
    }
    let next = null;
    try {
        const r = await fetch("/content.json", { cache: "no-store" });
        if (r.ok) { next = await r.json(); contentError = ""; }
        else if (r.status !== 404) contentError = `content.json: HTTP ${r.status}`;
    } catch (e) {
        contentError = `content.json: ${e.message}`;
    }
    const noProgram = !next || !next.program;
    if (noProgram && DEMO) next = DEMO_CONTENT;
    const nextRev = next ? String(next.rev ?? next.generation ?? JSON.stringify(next)) : null;
    if (nextRev !== rev) {
        rev = nextRev;
        log(`content rev ${rev ?? "(none)"}${next?.program ? `: program ${next.program.name || next.program.id}` : ""}`);
        for (const w of next?.warnings || []) warn(`content warning: ${typeof w === "string" ? w : JSON.stringify(w)}`);
        reconcile(next && next.program ? next : null);
    }
}

// ---------------------------------------------------------------- status screen

const statusEl = document.getElementById("status");
let statusShown = null, statusTimer = null;

function setStatusShown(show) {
    if (NO_STATUS) show = false;
    if (show === statusShown) return;
    statusShown = show;
    statusEl.hidden = !show;
    if (show) markVisible("status", { layer: -1, layer_name: "status", package: "status-screen" });
    else markHidden("status");
    clearInterval(statusTimer);
    if (show) { renderStatus(); statusTimer = setInterval(renderStatus, 5000); }
}

async function renderStatus() {
    const [s, a] = await Promise.all([getJson("/status/status.json"), getJson("/status/agent.json")]);
    const st = s || {};
    const d = dashboardState(a);
    const why = !content ? (contentError || "No program assigned to this player.")
        : `${esc(content.program?.name || "The program")}: nothing scheduled to show right now.`;
    statusEl.innerHTML = `<div><h1>${esc(st.hostname || "signage")}</h1><dl>
        <dt>Version</dt><dd>${esc(st.version || "?")}</dd>
        <dt>Addresses</dt><dd>${esc(st.addresses || "none")}</dd>
        <dt>Clock</dt><dd>${esc(st.clock || new Date().toLocaleString())}${st.ntp ? ` (${esc(st.ntp)})` : ""}</dd>
        <dt>Config</dt><dd><code>${esc(st.config || "?")}</code></dd>
        <dt>Display</dt><dd><code>${esc(st.display || "")}</code></dd>
        <dt>Dashboard</dt><dd class="${d.cls}">${esc(d.text)}</dd>
        </dl><div class="note">${esc(why)}</div></div>`;
}

// ---------------------------------------------------------------- main loop

function tick() {
    for (const r of runners.values()) r.tick();
    const now = new Date();
    const playing = [...runners.values()].some((r) => r.current || r.busy || r.hasEligible(now));
    setStatusShown(!content || !playing);
}

startUpdateBar(document.getElementById("update"));
startPerf();
setStatusShown(true);
await poll();
setInterval(poll, POLL_MS);
setInterval(tick, TICK_MS);
