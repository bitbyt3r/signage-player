// Minimal OGraf host: see index.html for the parameters.
const params = new URLSearchParams(location.search);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const statusEl = document.getElementById("status");
let hostError = "";

function log(...args) { console.log("[host]", ...args); }

// ------------------------------------------------------------ status overlay

async function getJson(path) {
    try {
        const r = await fetch(path, { cache: "no-store" });
        if (r.ok) return await r.json();
    } catch { /* not written yet */ }
    return null;
}

const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// The dashboard agent's /run/signage/agent.json, as one coloured line.
function dashboardLine(a) {
    let cls = "dim", text = "not configured";
    if (a && a.state === "connected") {
        cls = "ok"; text = `connected · checked in ${ago(a.last_ok || a.last_attempt)} ago`;
    } else if (a && a.state !== "unconfigured") {
        cls = "warn";
        text = a.last_ok ? `offline since ${hhmm(a.last_ok)}` : "connecting";
        if (a.error) text += ` — ${a.error}`;
    } else if (!a) {
        text = "agent not running";
    }
    return `<span class="k">Dashboard</span> <span class="${cls}">${esc(text)}</span>`;
}

// ------------------------------------------------------------ update bar

// The agent writes /run/signage/update.json while sysupdate runs. Show a
// full-width bar until it's done; a failure stays up for a minute.
const updateEl = document.getElementById("update");
async function refreshUpdate() {
    const u = await getJson("/status/update.json");
    let show = u && u.state && u.state !== "done";
    if (show && u.state === "failed") show = Date.now() - (u.updated || 0) < 60000;
    updateEl.hidden = !show;
    if (!show) return;
    const pct = Math.max(0, Math.min(100, Number(u.percent) || 0));
    const v = u.version ? ` to v${u.version}` : "";
    const label = u.state === "failed" ? `Update${v} failed: ${u.message || "unknown error"}`
        : u.state === "rebooting" ? `Updated${v}, rebooting…`
        : `Updating${v}… ${pct}%`;
    updateEl.className = u.state === "failed" ? "failed" : "";
    updateEl.querySelector(".fill").style.width = `${u.state === "failed" ? 100 : pct}%`;
    updateEl.querySelector(".label").textContent = label;
}
refreshUpdate();
setInterval(refreshUpdate, 2000);

async function refreshStatus() {
    let s = {};
    try {
        const r = await fetch("/status/status.json", { cache: "no-store" });
        if (r.ok) s = await r.json();
    } catch { /* not written yet */ }
    statusEl.innerHTML = `<b>${esc(s.hostname || "signage")}</b><br>
        <span class="k">Version</span> ${esc(s.version || "?")}<br>
        <span class="k">IP</span> ${esc(s.addresses || "none")}<br>
        <span class="k">Clock</span> ${esc(s.clock || new Date().toLocaleString())} ${s.ntp ? `(${esc(s.ntp)})` : ""}<br>
        <span class="k">Config</span> ${esc(s.config || "?")}<br>
        ${dashboardLine(await getJson("/status/agent.json"))}
        ${hostError ? `<br><span class="err">${esc(hostError)}</span>` : ""}`;
}

// ------------------------------------------------------------ OGraf loading

let defined = 0;

async function mountGraphic(manifestUrl, layer, data) {
    const url = new URL(manifestUrl, location.href);
    const manifest = await (await fetch(url, { cache: "no-store" })).json();
    if (!manifest.supportsRealTime) throw new Error(`${manifest.id} does not support real-time rendering`);
    const mod = await import(new URL(manifest.main, url).href);
    const cls = mod.default;
    // The spec leaves registration to the renderer; give each load its own tag.
    const tag = `ograf-graphic-${++defined}`;
    customElements.define(tag, class extends cls {});
    const el = document.createElement(tag);
    // Graphics may hold timers and caches: let the old one clean up.
    for (const old of layer.children) {
        try { await old.dispose?.({}); } catch (e) { console.warn("dispose failed", e); }
    }
    layer.replaceChildren(el);

    // Defaults from the manifest's data schema, then the caller's data.
    const defaults = {};
    for (const [k, v] of Object.entries(manifest.schema?.properties || {})) {
        if ("default" in v) defaults[k] = v.default;
    }
    const res = await el.load({
        data: { ...defaults, ...data },
        renderType: "realtime",
        renderCharacteristics: { resolution: { width: innerWidth, height: innerHeight } },
    });
    if (res && res.statusCode >= 300) throw new Error(`load() failed: ${res.statusCode} ${res.statusMessage || ""}`);
    log("loaded", manifest.id, manifest.version || "");
    return { el, manifest };
}

async function run() {
    const graphic = params.get("graphic");
    if (!graphic) { hostError = "no ?graphic= given"; return; }
    const hold = Number(params.get("hold") || 6000);
    const gap = Number(params.get("gap") || 2000);
    let data = {};
    try { data = JSON.parse(params.get("data") || "{}"); } catch { hostError = "data= is not valid JSON"; }

    const { el } = await mountGraphic(graphic, document.getElementById("layer-main"), data);
    for (;;) {
        await el.playAction({});
        await sleep(hold);
        await el.stopAction({});
        await sleep(gap);
    }
}

if (params.get("status") === "0") statusEl.remove();
else { refreshStatus(); setInterval(refreshStatus, 5000); }

run().catch((e) => { hostError = `graphic failed: ${e.message}`; console.error(e); refreshStatus(); });
