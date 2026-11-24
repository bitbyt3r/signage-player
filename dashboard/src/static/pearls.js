// Pearls page: Epiphan Pearls reached through gateways (src/pearls.py,
// agent/pearl-gateway). Everything a Pearl's REST API can do, per Pearl and
// across the fleet.

let h, api, toast, setView, every, ago;

export function initPearls(deps) {
  ({ h, api, toast, setView, every, ago } = deps);
}

const API = "/api/v2.0";

// ------------------------------------------------------------ ops

// Queue a Pearl API call and wait for the gateway to run it.
export async function runOp(pid, op, { quiet = false, timeout = 60000 } = {}) {
  let rec = await api("POST", `/api/pearls/${pid}/ops`, op);
  const t0 = Date.now();
  while (rec.state === "pending" || rec.state === "sent") {
    if (Date.now() - t0 > timeout) throw new Error("the gateway didn't answer in time");
    await new Promise((r) => setTimeout(r, 600));
    rec = await api("GET", `/api/pearls/${pid}/ops/${rec.id}`);
  }
  if (rec.state !== "done") {
    const msg = rec.error || (typeof rec.result === "object" && rec.result?.message) || `HTTP ${rec.status}`;
    if (!quiet) toast(`${op.label || op.path || "Pearl"}: ${msg}`);
    throw new Error(msg);
  }
  return rec;
}

async function waitOps(ops) {
  // Bulk: poll each until it settles.
  const out = [];
  for (const o of ops) {
    let rec = o;
    const t0 = Date.now();
    while ((rec.state === "pending" || rec.state === "sent") && Date.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 800));
      rec = await api("GET", `/api/pearls/${o.pearl}/ops/${o.id}`).catch(() => rec);
    }
    out.push(rec);
  }
  return out;
}

async function preview(pid, target, resolution = "960") {
  const rec = await runOp(pid, { kind: "preview", target, resolution, label: `Preview ${target}` });
  return rec.url;
}

function modal(...kids) {
  const m = h("div", { class: "modal", onclick: (e) => e.target === m && m.remove() },
    h("div", { class: "panel modal-box" }, h("div", { class: "row spread" }, h("span"), h("button", { class: "ghost small", onclick: () => m.remove() }, "Close")), ...kids));
  document.body.append(m);
  return m;
}

function showPreview(pid, target, title) {
  const img = h("img", { alt: title, class: "pearl-preview" });
  const note = h("p", { class: "muted small" }, "Asking the Pearl for a frame…");
  const box = modal(h("h2", {}, title), note, img,
    h("div", { class: "row" }, h("button", { onclick: load }, "Refresh")));
  async function load() {
    note.textContent = "Asking the Pearl for a frame…";
    try { img.src = await preview(pid, target, "1280"); note.textContent = new Date().toLocaleTimeString(); }
    catch (e) { note.textContent = e.message; }
  }
  load();
  return box;
}

// JSON editor for a settings object; onSave gets the parsed value.
function jsonEditor(title, value, onSave, extra) {
  const ta = h("textarea", { class: "json", spellcheck: "false" }, JSON.stringify(value ?? {}, null, 2));
  const err = h("div", { class: "bad small" });
  const m = modal(h("h2", {}, title), extra || "", ta, err,
    h("div", { class: "row" }, h("button", { class: "primary", onclick: async (e) => {
      let v;
      try { v = JSON.parse(ta.value); } catch (x) { err.textContent = `Not valid JSON: ${x.message}`; return; }
      e.target.disabled = true;
      try { await onSave(v); m.remove(); } catch (x) { err.textContent = x.message; } finally { e.target.disabled = false; }
    } }, "Save to the Pearl")));
  ta.style.minHeight = "360px";
  return { m, ta };
}

// ------------------------------------------------------------ small bits

const sig = (s) => s === true ? h("span", { class: "ok" }, "● video") : s === false ? h("span", { class: "muted" }, "○ no video") : h("span", { class: "muted" }, "?");
const recState = (s) => s === "started" || s === "recording" ? h("span", { class: "bad" }, "● recording") : h("span", { class: "muted" }, s || "–");
const fmtUptime = (s) => { s = +s || 0; const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`; };

function status(p) {
  if (!p.gateway_id) return h("span", { class: "warn" }, "no gateway");
  if (!p.gateway_online) return h("span", { class: "bad" }, "gateway offline");
  if (p.error) return h("span", { class: "bad", title: p.error }, "unreachable");
  if (!p.snapshot_at) return h("span", { class: "muted" }, "waiting");
  return p.online ? h("span", { class: "ok" }, "online") : h("span", { class: "warn" }, `stale (${ago(p.snapshot_at)})`);
}

function pearlForm(p, gateways, onSave) {
  const f = (name, label, attrs = {}) => h("label", { class: "field" }, h("span", {}, label), h("input", { name, value: p[name] ?? "", ...attrs }));
  const gw = h("select", { name: "gateway_id" }, h("option", { value: "" }, "None"),
    gateways.map((g) => h("option", { value: g.id, selected: g.id === p.gateway_id }, `${g.name}${g.online ? "" : " (offline)"}`)));
  const err = h("div");
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (!d.password) delete d.password;   // blank keeps the stored one
    try { await onSave(d); } catch (x) { err.replaceChildren(h("div", { class: "bad" }, x.message), ...(x.errors || []).map((s) => h("div", { class: "bad small" }, s))); }
  } },
  h("div", { class: "fields" },
    f("name", "Name", { required: true, placeholder: "Panels 1 Pearl" }),
    f("room", "Room (as on the schedule)", { placeholder: "Panels 1" }),
    f("host", "Address", { required: true, placeholder: "10.1.29.127 or gsaa798666.local" }),
    f("username", "Username", { placeholder: "admin" }),
    h("label", { class: "field" }, h("span", {}, p.has_password ? "Password (blank keeps it)" : "Password"),
      h("input", { name: "password", type: "password", autocomplete: "new-password" })),
    h("label", { class: "field" }, h("span", {}, "Gateway"), gw)),
  h("label", { class: "field" }, h("span", {}, "Notes"), h("input", { name: "notes", value: p.notes || "" })),
  err, h("button", { class: "primary" }, "Save"));
  return form;
}

// ------------------------------------------------------------ fleet list

export async function viewPearls() {
  const [d, g] = await Promise.all([api("GET", "/api/pearls"), api("GET", "/api/gateways")]);
  let pearls = d.pearls, gateways = g.gateways;
  const selected = new Set();
  const tbody = h("tbody");
  const count = h("span", { class: "muted" });
  const bulkBar = h("div", { class: "row bulk", hidden: true }, count,
    h("button", { onclick: () => copyDialog(pearls, [...selected]) }, "Copy settings from…"),
    h("button", { onclick: () => layoutDialog(pearls, [...selected]) }, "Switch layout…"),
    h("button", { onclick: () => urlDialog(pearls, [...selected]) }, "Set Graphics URL…"),
    h("button", { onclick: () => bulkSimple([...selected], "POST", "/recorders/control/start", "Start recording") }, "Start recording"),
    h("button", { onclick: () => bulkSimple([...selected], "POST", "/recorders/control/stop", "Stop recording") }, "Stop recording"),
    h("button", { onclick: () => bulkStreams(pearls, [...selected], "start") }, "Start streams"),
    h("button", { onclick: () => bulkStreams(pearls, [...selected], "stop") }, "Stop streams"),
    h("button", { onclick: () => apiDialog(pearls, [...selected]) }, "API call…"),
    h("button", { class: "danger", onclick: () => confirm(`Reboot ${selected.size} Pearl(s)? Anything they're recording or streaming stops.`) &&
      bulkSimple([...selected], "POST", "/system/control/reboot", "Reboot") }, "Reboot"));

  function render() {
    tbody.replaceChildren(...pearls.map((p) => {
      const s = p.summary || {};
      const cb = h("input", { type: "checkbox", checked: selected.has(p.id), onchange: (e) => {
        e.target.checked ? selected.add(p.id) : selected.delete(p.id);
        bulkBar.hidden = !selected.size; count.textContent = `${selected.size} selected`;
      } });
      const chName = Object.fromEntries((s.channels || []).map((c) => [c.id, c.name]));
      return h("tr", {},
        h("td", {}, cb),
        h("td", {}, h("span", { class: `dot ${p.online ? "on" : "off"}` }), h("a", { href: `#/pearls/${p.id}` }, p.name),
          h("div", { class: "muted small" }, p.room || "")),
        h("td", {}, status(p), h("div", { class: "muted small mono" }, p.host)),
        h("td", {}, (s.inputs || []).filter((i) => i.type !== "web-graphics" && i.type !== "usb").map((i) =>
          h("div", { class: "small" }, `${i.name} `, sig(i.signal), i.signal ? h("span", { class: "muted" }, ` ${i.resolution}`) : "")),
          Object.entries(s.web_graphics || {}).map(([id, u]) => h("div", { class: "small muted", title: u }, `${id}: ${u ? "set" : "no URL"}`))),
        h("td", {}, (s.channels || []).map((c) => h("div", { class: "small" }, `${c.name}: `, h("b", {}, c.layout || "?"),
          c.streaming ? h("span", { class: "bad" }, ` ● ${c.streaming}/${c.publishers} live`) : ""))),
        h("td", {}, (s.recorders || []).map((r) => h("div", { class: "small" }, `${r.name}: `, recState(r.state)))),
        h("td", {}, (s.outputs || []).map((o) => h("div", { class: "small" }, `${o.name} ← ${chName[o.source] || o.source || "?"}`,
          h("span", { class: "muted" }, ` (${o.state || "?"})`)))),
        h("td", { class: "small" }, s.firmware ? `${s.product} ${s.firmware}` : "", s.cputemp != null ? h("div", { class: s.cputemp >= 70 ? "bad" : "muted" }, `${s.cputemp}°C, CPU ${s.cpuload}%`) : ""));
    }));
    if (!pearls.length) tbody.replaceChildren(h("tr", {}, h("td", { colspan: 8, class: "empty" },
      gateways.length ? "No Pearls yet. Add one below." : "Start by adding a gateway below, then add your Pearls.")));
  }

  async function refresh() {
    const [d2, g2] = await Promise.all([api("GET", "/api/pearls"), api("GET", "/api/gateways")]);
    pearls = d2.pearls; gateways = g2.gateways;
    render(); renderGateways();
  }

  const addBox = h("div", { class: "panel", hidden: true });
  function showAdd() {
    addBox.hidden = false;
    addBox.replaceChildren(h("h2", {}, "Add a Pearl"), pearlForm({ username: "admin", gateway_id: gateways[0]?.id || "" }, gateways, async (body) => {
      const p = await api("POST", "/api/pearls", body);
      toast(`${p.name} added`);
      location.hash = `#/pearls/${p.id}`;
    }));
  }

  const gwBody = h("div");
  function renderGateways() {
    gwBody.replaceChildren(
      gateways.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Gateway", "Status", "Addresses", "Pearls", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, gateways.map((gw) => h("tr", {},
          h("td", {}, gw.name, h("div", { class: "muted small mono" }, gw.id)),
          h("td", {}, h("span", { class: `dot ${gw.online ? "on" : "off"}` }), gw.online ? "online" : `last seen ${ago(gw.last_seen)}`,
            gw.version ? h("div", { class: "muted small" }, `v${gw.version}`) : ""),
          h("td", { class: "mono small" }, (gw.local_ips || []).join(", "), gw.ip ? h("div", { class: "muted" }, `public ${gw.ip}`) : ""),
          h("td", {}, String(pearls.filter((p) => p.gateway_id === gw.id).length)),
          h("td", {}, h("button", { class: "small danger", onclick: async () => {
            if (!confirm(`Delete gateway ${gw.name}? It stops working at once.`)) return;
            try { await api("DELETE", `/api/gateways/${gw.id}`); await refresh(); } catch (e) { toast(e.message); }
          } }, "Delete"))))))
        : h("p", { class: "muted" }, "No gateways yet."));
  }

  const newGw = h("div");
  async function addGateway() {
    const name = prompt("Name the gateway (the machine it runs on, or the room):");
    if (!name) return;
    try {
      const gw = await api("POST", "/api/gateways", { name });
      const cmd = `PEARL_GATEWAY_TOKEN=${gw.token} \\\n  python3 pearl-gateway --dashboard ${location.origin} --id ${gw.id}`;
      const env = `PEARL_GATEWAY_DASHBOARD=${location.origin}\nPEARL_GATEWAY_ID=${gw.id}\nPEARL_GATEWAY_TOKEN=${gw.token}`;
      newGw.replaceChildren(h("div", { class: "panel inset" },
        h("p", {}, h("b", {}, "Copy this now: the token isn't shown again. "),
          "Run it on a machine on the same network as the Pearls (a signage player, a Pi, a laptop). ",
          h("a", { href: "/static/pearl-gateway", download: "pearl-gateway" }, "Download pearl-gateway"), " (Python 3, no dependencies)."),
        h("pre", { class: "mono", style: "white-space:pre-wrap;overflow-wrap:anywhere" }, cmd),
        h("button", { class: "small", onclick: () => navigator.clipboard.writeText(cmd).then(() => toast("Copied")) }, "Copy"),
        h("p", { class: "small" }, "To keep it running on a Linux machine, install ",
          h("a", { href: "/static/pearl-gateway.service", download: "pearl-gateway.service" }, "pearl-gateway.service"),
          " (instructions inside) with this as /etc/pearl-gateway.env:"),
        h("pre", { class: "mono", style: "white-space:pre-wrap;overflow-wrap:anywhere" }, env)));
      await refresh();
    } catch (e) { toast(e.message); }
  }

  render(); renderGateways();
  setView(
    h("div", { class: "row spread" }, h("h1", {}, "Pearls"),
      h("div", { class: "row" }, h("span", { class: "muted small" }, `${pearls.filter((p) => p.online).length} of ${pearls.length} online`),
        h("a", { class: "button", href: "#/pearls/multiview" }, "Multiviewer"),
        h("button", { class: "primary", onclick: showAdd }, "Add Pearl"))),
    addBox,
    h("div", { class: "panel" }, bulkBar,
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["", "Pearl", "Status", "Inputs", "Layout in use", "Recording", "Output", "System"].map((x) => h("th", {}, x)))), tbody))),
    h("div", { class: "panel" }, h("div", { class: "row spread" }, h("h2", {}, "Gateways"), h("button", { onclick: addGateway }, "Add gateway")),
      h("p", { class: "muted small" }, "The dashboard can't reach Pearls on a venue network. A gateway is a small program on a machine on the Pearls' network that does it for the dashboard: it reports each Pearl's state and carries out your changes."),
      newGw, gwBody));
  every(5000, refresh);
}

// ------------------------------------------------------------ fleet operations

async function bulkSend(ops, label) {
  if (!ops.length) { toast("Nothing to do"); return []; }
  try {
    const r = await api("POST", "/api/pearls/ops", { ops });
    toast(`${label}: sent to ${new Set(ops.map((o) => o.pearl)).size} Pearl(s)…`);
    const done = await waitOps(r.ops);
    const bad = done.filter((o) => o.state !== "done");
    toast(bad.length ? `${label}: ${bad.length} of ${done.length} failed (${bad[0].error || bad[0].state})` : `${label}: done`);
    return done;
  } catch (e) { toast(e.message); return []; }
}

function bulkSimple(ids, method, path, label) {
  return bulkSend(ids.map((pearl) => ({ pearl, method, path: API + path, label })), label);
}

async function bulkStreams(pearls, ids, action) {
  const ops = [];
  for (const p of pearls.filter((x) => ids.includes(x.id))) {
    const snap = (await api("GET", `/api/pearls/${p.id}`)).snapshot || {};
    for (const ch of snap.channels || []) {
      if ((snap.publishers?.[ch.id] || []).length) ops.push({ pearl: p.id, method: "POST", path: `${API}/channels/${ch.id}/publishers/control/${action}`, label: `${action} streams` });
    }
  }
  return bulkSend(ops, action === "start" ? "Start streams" : "Stop streams");
}

function layoutDialog(pearls, ids) {
  const chosen = pearls.filter((p) => ids.includes(p.id));
  const chans = new Map();
  for (const p of chosen) for (const c of p.summary?.channels || []) chans.set(c.id, c.name);
  const ch = h("select", {}, [...chans].map(([id, n]) => h("option", { value: id }, `Channel ${id} (${n})`)));
  const name = h("input", { placeholder: "Layout name, e.g. Default" });
  const m = modal(h("h2", {}, `Switch layout on ${chosen.length} Pearl(s)`),
    h("p", { class: "muted small" }, "Each Pearl switches the channel to its layout with this name."),
    h("div", { class: "fields" }, h("label", { class: "field" }, h("span", {}, "Channel"), ch), h("label", { class: "field" }, h("span", {}, "Layout name"), name)),
    h("button", { class: "primary", onclick: async () => {
      const ops = [], missing = [];
      for (const p of chosen) {
        const snap = (await api("GET", `/api/pearls/${p.id}`)).snapshot || {};
        const l = (snap.layouts?.[ch.value] || []).find((x) => x.name.toLowerCase() === name.value.trim().toLowerCase());
        if (l) ops.push({ pearl: p.id, method: "PUT", path: `${API}/channels/${ch.value}/layouts/active`, query: { id: l.id }, label: `Layout ${l.name}` });
        else missing.push(p.name);
      }
      if (missing.length) toast(`No layout called "${name.value}" on: ${missing.join(", ")}`);
      m.remove();
      await bulkSend(ops, "Switch layout");
    } }, "Switch"));
}

function urlDialog(pearls, ids) {
  const chosen = pearls.filter((p) => ids.includes(p.id));
  const input = h("input", { value: "WEBG1" });
  const tpl = h("input", { style: "width:100%", value: Object.values(chosen[0]?.summary?.web_graphics || {})[0]?.replace(/room=[^&]*/, "room={room}") || "https://example.com/pearl/?room={room}" });
  const list = h("ul", { class: "small" });
  const fill = (p) => tpl.value.replaceAll("{room}", encodeURIComponent(p.room || "")).replaceAll("{name}", encodeURIComponent(p.name)).replaceAll("{id}", p.id);
  const show = () => list.replaceChildren(...chosen.map((p) => h("li", {}, h("b", {}, p.name), " → ", h("span", { class: "mono" }, fill(p)))));
  tpl.addEventListener("input", show); show();
  const m = modal(h("h2", {}, `Set the Graphics URL on ${chosen.length} Pearl(s)`),
    h("p", { class: "muted small" }, "{room} becomes each Pearl's room (URL-encoded), {name} its name, {id} its ID."),
    h("label", { class: "field" }, h("span", {}, "Web Graphics input"), input),
    h("label", { class: "field" }, h("span", {}, "URL template"), tpl), list,
    h("button", { class: "primary", onclick: async () => {
      m.remove();
      await bulkSend(chosen.map((p) => ({ pearl: p.id, method: "PATCH", path: `${API}/inputs/${input.value.trim()}/settings`,
        body: { web_graphics: { url: fill(p) } }, label: "Graphics URL" })), "Set Graphics URL");
    } }, "Set URLs"));
}

function apiDialog(pearls, ids) {
  const method = h("select", {}, ["GET", "PUT", "PATCH", "POST", "DELETE"].map((x) => h("option", {}, x)));
  const path = h("input", { style: "width:100%", value: `${API}/system/status` });
  const body = h("textarea", { placeholder: "JSON body (optional)" });
  const out = h("div");
  modal(h("h2", {}, `API call on ${ids.length} Pearl(s)`), h("div", { class: "row" }, method, path), body,
    h("button", { class: "primary", onclick: async () => {
      let b;
      try { b = body.value.trim() ? JSON.parse(body.value) : undefined; } catch (e) { toast(`Body: ${e.message}`); return; }
      const done = await bulkSend(ids.map((pearl) => ({ pearl, method: method.value, path: path.value, body: b, label: "API call" })), "API call");
      out.replaceChildren(...done.map((o) => h("div", { class: "item" }, h("b", {}, pearls.find((p) => p.id === o.pearl)?.name || o.pearl),
        ` ${o.status ?? ""} ${o.state}`, h("pre", { class: "mono small result" }, typeof o.result === "string" ? o.result : JSON.stringify(o.result, null, 2)))));
    } }, "Run"), out);
}

// Copy settings from one Pearl to others, section by section. Only what
// exists on both sides is copied (same input, channel/layout, output and
// stream IDs): the Pearl API can change layouts and streams but not create them.
const SECTIONS = [
  ["inputs", "Input settings (no-signal images, HDMI options; not Graphics URLs)"],
  ["graphics", "Graphics URLs (exactly as on the source)"],
  ["layouts", "Layouts (what's in each layout, by channel and layout number)"],
  ["active", "Which layout is in use on each channel"],
  ["names", "Channel names"],
  ["outputs", "HDMI output settings (which channel it shows)"],
  ["streams", "Stream settings (by channel and stream number; each target keeps its own destination and key)"],
];

// Where a stream goes and how it logs in. Copying these would send every
// target to the source's stream, so each target keeps its own.
const STREAM_DEST = new Set(["url", "stream", "key", "stream_key", "streamkey", "username", "user", "password",
  "passphrase", "secret", "token", "stream_id", "streamid", "host", "port", "path", "app", "location"]);

export function keepStreamDest(src, cur) {
  if (Array.isArray(src)) return src.map((v, n) => keepStreamDest(v, Array.isArray(cur) ? cur[n] : undefined));
  if (!src || typeof src !== "object") return src;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (STREAM_DEST.has(k.toLowerCase())) { if (cur && typeof cur === "object" && k in cur) out[k] = cur[k]; }
    else out[k] = keepStreamDest(v, cur && typeof cur === "object" ? cur[k] : undefined);
  }
  return out;
}

export function planCopy(src, dst, sections, dstId) {
  const ops = [], skipped = [];
  const want = new Set(sections);
  const op = (method, path, body, label, query) => ops.push({ pearl: dstId, method, path: API + path, body, query, label });
  if (want.has("inputs") || want.has("graphics")) {
    for (const i of src.inputs || []) {
      const s = src.input_settings?.[i.id];
      if (!s) continue;
      if (!(dst.inputs || []).some((x) => x.id === i.id)) { skipped.push(`input ${i.id}`); continue; }
      if (i.type === "web-graphics") {
        const cur = dst.input_settings?.[i.id] || {};
        const next = structuredClone(s);
        if (!want.has("graphics")) next.web_graphics = { ...(next.web_graphics || {}), url: cur.web_graphics?.url ?? "" };
        if (!want.has("inputs")) { next.video = cur.video; delete next.audio; }
        if (JSON.stringify(next) !== JSON.stringify(cur)) op("PUT", `/inputs/${i.id}/settings`, next, `Input ${i.id}`);
      } else if (want.has("inputs") && JSON.stringify(s) !== JSON.stringify(dst.input_settings?.[i.id])) {
        op("PUT", `/inputs/${i.id}/settings`, s, `Input ${i.id}`);
      }
    }
  }
  for (const ch of src.channels || []) {
    const cid = String(ch.id);
    const dch = (dst.channels || []).find((x) => String(x.id) === cid);
    if (!dch) { if (["layouts", "active", "names", "streams"].some((k) => want.has(k))) skipped.push(`channel ${cid}`); continue; }
    if (want.has("names") && ch.name !== dch.name) op("PUT", `/channels/${cid}/name`, undefined, `Channel ${cid} name`, { name: ch.name });
    if (want.has("layouts")) {
      for (const [lid, s] of Object.entries(src.layout_settings?.[cid] || {})) {
        if (!s) continue;
        if (!(dst.layouts?.[cid] || []).some((l) => String(l.id) === lid)) { skipped.push(`channel ${cid} layout ${lid}`); continue; }
        if (JSON.stringify(s) !== JSON.stringify(dst.layout_settings?.[cid]?.[lid])) op("PUT", `/channels/${cid}/layouts/${lid}/settings`, s, `Channel ${cid} layout ${lid}`);
      }
    }
    if (want.has("active")) {
      const a = (src.layouts?.[cid] || []).find((l) => l.active);
      const da = (dst.layouts?.[cid] || []).find((l) => l.active);
      if (a && (dst.layouts?.[cid] || []).some((l) => String(l.id) === String(a.id)) && String(da?.id) !== String(a.id)) {
        op("PUT", `/channels/${cid}/layouts/active`, undefined, `Channel ${cid} layout in use`, { id: a.id });
      }
    }
    if (want.has("streams")) {
      for (const [pid, s] of Object.entries(src.publisher_settings?.[cid] || {})) {
        if (!s) continue;
        if (!(dst.publishers?.[cid] || []).some((x) => String(x.id) === pid)) { skipped.push(`channel ${cid} stream ${pid}`); continue; }
        const cur = dst.publisher_settings?.[cid]?.[pid];
        const next = keepStreamDest(s, cur);
        if (JSON.stringify(next) !== JSON.stringify(cur)) op("PUT", `/channels/${cid}/publishers/${pid}/settings`, next, `Channel ${cid} stream ${pid}`);
      }
    }
  }
  if (want.has("outputs")) {
    for (const o of src.outputs || []) {
      const s = src.output_settings?.[o.id];
      if (!s) continue;
      if (!(dst.outputs || []).some((x) => x.id === o.id)) { skipped.push(`output ${o.id}`); continue; }
      if (JSON.stringify(s) !== JSON.stringify(dst.output_settings?.[o.id])) op("PUT", `/outputs/${o.id}/settings`, s, `Output ${o.id}`);
    }
  }
  return { ops, skipped };
}

function copyDialog(pearls, ids) {
  const targets = pearls.filter((p) => ids.includes(p.id));
  const src = h("select", {}, pearls.filter((p) => p.snapshot_at).map((p) => h("option", { value: p.id, selected: !ids.includes(p.id) }, `${p.name}${p.room ? ` (${p.room})` : ""}`)));
  const boxes = SECTIONS.map(([k, label]) => h("label", { class: "check", style: "display:flex" },
    h("input", { type: "checkbox", value: k, checked: !["graphics", "names", "streams"].includes(k) }), label));
  const plan = h("div", { class: "small" });
  let plans = [];
  async function makePlan() {
    plan.textContent = "Working out what would change…";
    const secs = boxes.map((b) => b.firstChild).filter((x) => x.checked).map((x) => x.value);
    const s = (await api("GET", `/api/pearls/${src.value}`)).snapshot || {};
    plans = [];
    for (const t of targets.filter((x) => x.id !== src.value)) {
      const d = (await api("GET", `/api/pearls/${t.id}`)).snapshot || {};
      if (!d.inputs) { plans.push({ t, ops: [], skipped: ["everything: the gateway hasn't been able to read this Pearl yet"] }); continue; }
      plans.push({ t, ...planCopy(s, d, secs, t.id) });
    }
    plan.replaceChildren(...plans.map((p) => h("div", { class: "item" }, h("b", {}, p.t.name), `: ${p.ops.length} change(s)`,
      p.ops.length ? h("div", { class: "muted" }, p.ops.map((o) => o.label).join(", ")) : "",
      p.skipped.length ? h("div", { class: "warn" }, `Not on this Pearl, skipped: ${p.skipped.join(", ")}`) : "")));
    if (!plans.length) plan.textContent = "Pick target Pearls other than the source.";
  }
  src.addEventListener("change", makePlan);
  boxes.forEach((b) => b.firstChild.addEventListener("change", makePlan));
  const m = modal(h("h2", {}, `Copy settings to ${targets.length} Pearl(s)`),
    h("label", { class: "field" }, h("span", {}, "From"), src), h("div", {}, boxes),
    h("h3", {}, "What changes"), plan,
    h("button", { class: "primary", onclick: async () => {
      const ops = plans.flatMap((p) => p.ops);
      if (!ops.length) { toast("Nothing to change"); return; }
      if (!confirm(`Make ${ops.length} change(s) on ${plans.filter((p) => p.ops.length).length} Pearl(s)?`)) return;
      m.remove();
      await bulkSend(ops, "Copy settings");
    } }, "Copy"));
  makePlan().catch((e) => { plan.textContent = e.message; });
  return m;
}

// ------------------------------------------------------------ one Pearl

export async function viewPearl(id) {
  let [p, g] = await Promise.all([api("GET", `/api/pearls/${id}`), api("GET", "/api/gateways")]);
  const body = h("div");
  const head = h("div");
  const busy = new Set();   // sections being edited: don't re-render under the user

  async function act(op, msg) {
    try { const r = await runOp(id, op); if (msg) toast(msg); refresh(); return r; } catch (e) { return null; }
  }
  const put = (path, b, label, query) => act({ method: "PUT", path: API + path, body: b, query, label }, `${label}: done`);

  function renderHead() {
    const s = p.summary || {};
    head.replaceChildren(
      h("div", { class: "row spread" },
        h("div", {}, h("a", { href: "#/pearls", class: "small" }, "← Pearls"), h("h1", {}, p.name),
          h("div", { class: "muted" }, [p.room, p.host, s.product && `${s.product} ${s.firmware}`, s.ident].filter(Boolean).join(" · "))),
        h("div", { class: "row" }, status(p),
          h("a", { class: "button", href: `http://${p.host}/admin/`, target: "_blank", rel: "noopener", title: "Only works from a computer on the Pearl's network" }, "Pearl admin page ↗"),
          h("button", { class: "danger", onclick: () => confirm(`Reboot ${p.name}?`) && act({ method: "POST", path: `${API}/system/control/reboot`, label: "Reboot" }, "Rebooting") }, "Reboot"))),
      p.error ? h("div", { class: "panel bad" }, p.error) : "");
  }

  function sectionInputs(snap) {
    const rows = (snap.inputs || []).map((i) => {
      const st = snap.input_status?.[i.id] || {};
      const v = st.video || {}, a = st.audio || {};
      const set = snap.input_settings?.[i.id];
      const wg = set?.web_graphics;
      let wgRow = "";
      if (wg) {
        const url = h("input", { value: wg.url || "", style: "width:100%", onfocus: () => busy.add("inputs"), onblur: () => busy.delete("inputs") });
        wgRow = h("div", { class: "row", style: "margin-top:6px;flex-wrap:nowrap" }, url,
          h("button", { class: "small", onclick: () => act({ method: "PATCH", path: `${API}/inputs/${i.id}/settings`, body: { web_graphics: { url: url.value.trim() } }, label: "Graphics URL" }, "Graphics URL set") }, "Set URL"));
      }
      const sigText = i.video ? (v.state === "error" ? h("span", { class: "bad", title: v.error }, `error: ${v.error || ""}`)
        : v.resolution && v.resolution !== "0x0" ? h("span", { class: "ok" }, `● ${v.resolution}${v.actual_fps ? ` @ ${Math.round(v.actual_fps)}` : ""}`)
        : h("span", { class: "muted" }, v.state === "active" ? "○ no signal" : v.state || "–")) : "";
      const lv = a.levels?.peak ? h("span", { class: "muted small" }, ` peak ${a.levels.peak.map((x) => Math.round(x)).join("/")} dB`) : "";
      return h("tr", {},
        h("td", {}, h("b", {}, i.name), h("div", { class: "muted small mono" }, `${i.id} · ${i.type}`)),
        h("td", {}, sigText, i.audio ? h("div", { class: "small" }, a.state === "active" ? "audio" : h("span", { class: "muted" }, `audio ${a.state || "–"}`), lv) : "", wgRow),
        h("td", { class: "row" },
          i.video ? h("button", { class: "small", onclick: () => showPreview(id, `inputs/${i.id}`, `${p.name}: ${i.name}`) }, "Preview") : "",
          set ? h("button", { class: "small", onclick: () => jsonEditor(`${i.name} settings`, set, (v2) => put(`/inputs/${i.id}/settings`, v2, `${i.name} settings`),
            h("p", { class: "muted small" }, "video.nosignal.image is a file already on the Pearl (upload it in the Pearl's admin page); timeout is seconds without signal before it shows.")) }, "Settings") : ""));
    });
    return h("div", { class: "panel" }, h("h2", {}, "Inputs"), h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, rows))));
  }

  const LAYOUT_TEMPLATES = (snap) => {
    const video = (snap.inputs || []).filter((i) => i.video);
    const full = { top: 0, bottom: 0, left: 0, right: 0, keep_aspect_ratio: true };
    const src = (i) => i.type === "embedded" ? `D2P0.${i.id}` : i.id;
    const hdmi = video.find((i) => i.id === "hdmi-a") || video[0];
    const gfx = video.find((i) => i.type === "web-graphics");
    const t = {};
    for (const i of video) t[`${i.name} full screen`] = { video: [{ type: "source", position: full, settings: { source: src(i) } }], audio: [], background: "#000000" };
    if (hdmi && gfx) t[`${hdmi.name} with ${gfx.name} on top (panel room page)`] = {
      video: [{ type: "source", position: full, settings: { source: src(hdmi) } }, { type: "source", position: full, settings: { source: src(gfx) } }],
      audio: snap.inputs.some((i) => i.id === `${hdmi.id}-audio`) ? [{ type: "source", settings: { source: `D2P0.${hdmi.id}-audio` } }] : [],
      background: "#000000" };
    return t;
  };

  function layoutEditor(snap, cid, l) {
    const cur = snap.layout_settings?.[cid]?.[l.id] || {};
    const tpls = LAYOUT_TEMPLATES(snap);
    const pick = h("select", {}, h("option", { value: "" }, "Start from a template…"), Object.keys(tpls).map((k) => h("option", {}, k)));
    const ed = jsonEditor(`Channel ${cid}, layout ${l.name}`, cur, (v) => put(`/channels/${cid}/layouts/${l.id}/settings`, v, `Layout ${l.name}`),
      h("div", {}, h("p", { class: "muted small" }, "Sources are listed bottom to top. Positions are percentages from each edge (0 everywhere is full frame). HDMI and SDI sources are named D2P0.<input>; Graphics and USB by their input ID."), pick));
    pick.addEventListener("change", () => { if (pick.value) ed.ta.value = JSON.stringify(tpls[pick.value], null, 2); });
  }

  function sectionChannels(snap) {
    return h("div", { class: "panel" }, h("h2", {}, "Channels"), (snap.channels || []).map((ch) => {
      const cid = String(ch.id);
      const st = snap.channel_status?.[cid] || {};
      const layouts = snap.layouts?.[cid] || [];
      const pubs = snap.publishers?.[cid] || [];
      const pst = Object.fromEntries((snap.publisher_status?.[cid] || []).map((x) => [String(x.id), x.status || {}]));
      const rec = (snap.recorders || []).find((r) => String(r.id) === cid);
      const rst = snap.recorder_status?.[cid] || {};
      return h("div", { class: "layer" },
        h("div", { class: "row spread" },
          h("div", {}, h("b", {}, ch.name), h("span", { class: "muted small" }, ` channel ${cid} · ${st.state || "?"}${st.bitrate ? ` · ${st.bitrate} kb/s` : ""}`)),
          h("div", { class: "row" },
            h("button", { class: "small", onclick: () => showPreview(id, `channels/${cid}`, `${p.name}: ${ch.name}`) }, "Preview"),
            h("button", { class: "small ghost", onclick: () => { const n = prompt("Channel name", ch.name); if (n) put(`/channels/${cid}/name`, undefined, "Rename channel", { name: n }); } }, "Rename"))),
        h("h3", { class: "small-h" }, "Layouts"),
        h("div", {}, layouts.map((l) => h("div", { class: "row" },
          h("label", { class: "check" }, h("input", { type: "radio", name: `active-${cid}`, checked: !!l.active,
            onchange: () => put(`/channels/${cid}/layouts/active`, undefined, `Layout ${l.name}`, { id: l.id }) }), l.name),
          h("span", { class: "muted small" }, describeLayout(snap.layout_settings?.[cid]?.[l.id], snap)),
          h("button", { class: "small ghost", onclick: () => showPreview(id, `channels/${cid}/layouts/${l.id}`, `${ch.name}: ${l.name}`) }, "Preview"),
          h("button", { class: "small ghost", onclick: () => layoutEditor(snap, cid, l) }, "Edit")))),
        h("p", { class: "muted small" }, "New layouts are added in the Pearl's admin page; the API can change and switch them but not create them."),
        h("h3", { class: "small-h" }, "Recording"),
        rec ? h("div", { class: "row" }, recState(rst.state), rst.duration ? h("span", { class: "muted small" }, fmtUptime(rst.duration)) : "",
          h("button", { class: "small", onclick: () => act({ method: "POST", path: `${API}/recorders/${cid}/control/start`, label: "Start recording" }, "Recording") }, "Start"),
          h("button", { class: "small", onclick: () => act({ method: "POST", path: `${API}/recorders/${cid}/control/stop`, label: "Stop recording" }, "Stopped") }, "Stop"),
          h("button", { class: "small ghost", onclick: () => filesDialog(cid, ch.name) }, "Files")) : h("span", { class: "muted small" }, "No recorder"),
        h("h3", { class: "small-h" }, "Streams"),
        pubs.length ? pubs.map((pb) => {
          const s = pst[String(pb.id)] || {};
          const set = snap.publisher_settings?.[cid]?.[pb.id];
          return h("div", { class: "row" }, h("b", {}, pb.name || pb.id), h("span", { class: "muted small" }, pb.type || ""),
            s.started ? h("span", { class: "bad" }, `● ${s.state || "live"}`) : h("span", { class: "muted" }, s.state || "stopped"),
            h("button", { class: "small", onclick: () => act({ method: "POST", path: `${API}/channels/${cid}/publishers/${pb.id}/control/start`, label: "Start stream" }, "Started") }, "Start"),
            h("button", { class: "small", onclick: () => act({ method: "POST", path: `${API}/channels/${cid}/publishers/${pb.id}/control/stop`, label: "Stop stream" }, "Stopped") }, "Stop"),
            set ? h("button", { class: "small ghost", onclick: () => jsonEditor(`${ch.name}: ${pb.name || pb.id}`, set, (v) => put(`/channels/${cid}/publishers/${pb.id}/settings`, v, "Stream settings")) }, "Settings") : "",
            h("button", { class: "small ghost danger", onclick: () => confirm(`Delete stream ${pb.name || pb.id}?`) && act({ method: "DELETE", path: `${API}/channels/${cid}/publishers/${pb.id}`, label: "Delete stream" }, "Deleted") }, "Delete"));
        }) : h("span", { class: "muted small" }, "None "),
        h("button", { class: "small ghost", onclick: () => jsonEditor(`New stream on ${ch.name}`, { type: "rtmp", settings: { url: "rtmp://example.com/live", stream: "key" } },
          (v) => act({ method: "POST", path: `${API}/channels/${cid}/publishers`, body: v, label: "Add stream" }, "Stream added")) }, "Add stream"));
    }));
  }

  function describeLayout(s, snap) {
    if (!s) return "";
    const names = Object.fromEntries((snap.inputs || []).map((i) => [i.type === "embedded" ? `D2P0.${i.id}` : i.id, i.name]));
    return (s.video || []).map((v) => names[v.settings?.source] || v.settings?.source || v.type).join(" + ") || "empty";
  }

  async function filesDialog(cid, name) {
    const list = h("div", { class: "small" }, "Loading…");
    modal(h("h2", {}, `Recordings: ${name}`), list);
    try {
      const r = await runOp(id, { method: "GET", path: `${API}/recorders/${cid}/archive/files`, label: "List recordings" });
      const files = r.result?.result || [];
      list.replaceChildren(files.length ? h("table", {}, h("tbody", {}, files.map((f) => h("tr", {}, h("td", { class: "mono" }, f.name || f.id),
        h("td", {}, f.size ? `${(f.size / 1e6).toFixed(1)} MB` : ""), h("td", { class: "muted" }, f.created || f.date || "")))))
        : h("p", { class: "muted" }, "No recordings."), h("p", { class: "muted small" }, "Download them from the Pearl's admin page or set up automatic upload there."));
    } catch (e) { list.textContent = e.message; }
  }

  function sectionOutputs(snap) {
    return h("div", { class: "panel" }, h("h2", {}, "Outputs"), (snap.outputs || []).map((o) => {
      const s = snap.output_settings?.[o.id] || {};
      const st = snap.output_status?.[o.id] || {};
      const sel = h("select", { onchange: () => put(`/outputs/${o.id}/settings`, { ...s, source: sel.value }, `${o.name} source`) },
        (snap.channels || []).map((c) => h("option", { value: String(c.id), selected: String(c.id) === String(s.source) }, c.name)));
      return h("div", { class: "row" }, h("b", {}, o.name), h("span", { class: "muted small" }, st.state || ""), "shows", sel,
        h("button", { class: "small", onclick: () => showPreview(id, `outputs/${o.id}`, `${p.name}: ${o.name}`) }, "Preview"),
        h("button", { class: "small ghost", onclick: () => jsonEditor(`${o.name} settings`, s, (v) => put(`/outputs/${o.id}/settings`, v, `${o.name} settings`)) }, "Settings"));
    }));
  }

  function sectionSystem(snap) {
    const ss = snap.system_status || {};
    const conn = snap.connectivity || {};
    return h("div", { class: "panel" }, h("h2", {}, "System"),
      h("dl", { class: "kv" },
        h("dt", {}, "Firmware"), h("dd", {}, `${snap.firmware?.product_name || ""} ${snap.firmware?.version || ""} (${snap.firmware?.revision || ""})`),
        h("dt", {}, "Name"), h("dd", {}, `${snap.ident?.name || ""} ${snap.ident?.location ? `· ${snap.ident.location}` : ""}`),
        h("dt", {}, "CPU"), h("dd", { class: ss.cputemp >= (ss.cputemp_threshold || 70) ? "bad" : "" }, `${ss.cpuload ?? "?"}% · ${ss.cputemp ?? "?"}°C`),
        h("dt", {}, "Up"), h("dd", {}, fmtUptime(ss.uptime)),
        h("dt", {}, "Clock"), h("dd", {}, ss.date || ""),
        h("dt", {}, "Network"), h("dd", {}, Object.entries(conn).filter(([k]) => k !== "external_ip").map(([k, v]) => `${k} ${v}`).join(" · "),
          conn.external_ip ? h("div", { class: "muted small" }, `public ${conn.external_ip}`) : ""),
        h("dt", {}, "Storage"), h("dd", {}, Object.entries(snap.storages || {}).map(([k, v]) => h("div", {}, `${k}: `,
          v ? `${v.state || ""} ${v.free != null ? `${(v.free / 1e9).toFixed(1)} GB free` : ""}` : h("span", { class: "muted" }, "–"))))),
      (snap.presets || []).length ? h("div", {}, h("h3", { class: "small-h" }, "Presets"), snap.presets.map((pr) => h("div", { class: "row" }, pr.name || pr.id,
        h("button", { class: "small", onclick: () => confirm(`Apply preset ${pr.name || pr.id} to ${p.name}? It replaces its configuration.`) &&
          act({ method: "POST", path: `${API}/system/presets/${pr.id}/control/apply`, label: "Apply preset" }, "Preset applied") }, "Apply")))) : "",
      h("div", { class: "row", style: "margin-top:12px" },
        h("button", { class: "danger", onclick: () => confirm(`Shut ${p.name} down? Someone has to power it on again by hand.`) && act({ method: "POST", path: `${API}/system/control/shutdown`, label: "Shut down" }, "Shutting down") }, "Shut down")));
  }

  function sectionConsole() {
    const method = h("select", {}, ["GET", "PUT", "PATCH", "POST", "DELETE"].map((x) => h("option", {}, x)));
    const path = h("input", { style: "flex:1", value: `${API}/inputs/status` });
    const bodyIn = h("textarea", { placeholder: "JSON body (optional). Query strings go in the path: /api/v2.0/channels/1/layouts/active?id=1" });
    const out = h("pre", { class: "mono small result" });
    return h("div", { class: "panel" }, h("h2", {}, "API console"),
      h("p", { class: "muted small" }, "Anything the Pearl's API can do, through the gateway: the REST API (",
        h("a", { href: `http://${p.host}/swagger/`, target: "_blank", rel: "noopener" }, "its reference on the Pearl"), ") and the older /admin/get_params.cgi and set_params.cgi."),
      h("div", { class: "row", style: "flex-wrap:nowrap" }, method, path, h("button", { class: "primary", onclick: async () => {
        let b;
        try { b = bodyIn.value.trim() ? JSON.parse(bodyIn.value) : undefined; } catch (e) { out.textContent = `Body: ${e.message}`; return; }
        const [pth, qs] = path.value.trim().split("?");
        const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined;
        out.textContent = "…";
        try {
          const r = await runOp(id, { method: method.value, path: pth, query, body: b, label: "API console" }, { quiet: true });
          out.textContent = `${r.status}\n${typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2)}`;
        } catch (e) { out.textContent = e.message; }
        refresh();
      } }, "Run")), bodyIn, out);
  }

  const settingsBox = h("div", { class: "panel", hidden: true });
  let consoleBox = null;
  function render() {
    renderHead();
    const snap = p.snapshot || {};
    if (busy.size) return;
    body.replaceChildren(...[
      snap.inputs ? [sectionInputs(snap), sectionChannels(snap), h("div", { class: "grid2" }, sectionOutputs(snap), sectionSystem(snap))]
        : h("div", { class: "panel muted" }, p.gateway_id ? "Waiting for the gateway to read this Pearl…" : "Pick a gateway in Settings below so the dashboard can reach this Pearl."),
      consoleBox].flat());
  }

  async function refresh() {
    p = await api("GET", `/api/pearls/${id}`);
    // Don't redraw while a text field in the body has focus.
    if (!body.contains(document.activeElement) || document.activeElement === document.body) render();
    else renderHead();
  }

  consoleBox = sectionConsole();
  render();
  settingsBox.append(h("div", { class: "row spread" }, h("h2", {}, "Settings"),
    h("button", { class: "danger small", onclick: async () => {
      if (!confirm(`Remove ${p.name} from the dashboard? The Pearl itself isn't changed.`)) return;
      await api("DELETE", `/api/pearls/${id}`); location.hash = "#/pearls";
    } }, "Remove")),
  pearlForm(p, g.gateways, async (b) => { p = { ...p, ...(await api("PATCH", `/api/pearls/${id}`, b)) }; toast("Saved"); refresh(); }));
  setView(head, body, h("button", { class: "ghost", onclick: () => { settingsBox.hidden = !settingsBox.hidden; } }, "Settings (address, password, gateway)"), settingsBox);
  every(3000, refresh);
}

// ------------------------------------------------------------ multiviewer

// Live thumbnails from every Pearl. While this page is open the dashboard
// asks each gateway to push a preview frame per input/output every few
// seconds; it stops on its own shortly after the page closes.
const MV_PREFS = "pearl-multiview";

export async function viewMultiview() {
  let prefs = { show: "both", every: 5, width: 480 };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(MV_PREFS) || "{}") }; } catch { /* defaults */ }
  const grid = h("div", { class: "mv-grid" });
  const note = h("span", { class: "muted small" });
  const tiles = new Map();   // pid|target -> {el, img, meta, at}
  // One ID per open page: the server merges what every open multiviewer asks for.
  const viewer = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

  const select = (key, options, label) => h("label", { class: "row small" }, label,
    h("select", { onchange: (e) => { prefs[key] = isNaN(+e.target.value) ? e.target.value : +e.target.value; save(); poll(); schedule(); } },
      options.map(([v, t]) => h("option", { value: v, selected: String(prefs[key]) === String(v) }, t))));
  function save() { try { localStorage.setItem(MV_PREFS, JSON.stringify(prefs)); } catch { /* fine */ } }

  function tile(p, t) {
    const key = `${p.id}|${t.target}`;
    let rec = tiles.get(key);
    if (!rec) {
      const img = h("img", { alt: "" });
      const meta = h("div", { class: "mv-meta small" });
      const el = h("figure", { class: "mv-tile", title: "Click for a full-size frame",
        onclick: () => showPreview(p.id, t.target, `${p.name}: ${t.label}`) }, img, meta);
      rec = { el, img, meta, at: 0 };
      tiles.set(key, rec);
    }
    if (t.at && t.at !== rec.at && t.url) {
      const next = new Image();   // swap when loaded so tiles don't flash
      next.onload = () => { rec.img.src = next.src; rec.el.classList.remove("waiting"); };
      next.src = t.url;
      rec.at = t.at;
    }
    rec.el.classList.toggle("waiting", !rec.at);
    rec.el.style.width = `${prefs.width}px`;
    const age = rec.at ? Math.max(0, Math.round(Date.now() / 1000 - rec.at)) : null;
    rec.el.classList.toggle("stale", age != null && age > prefs.every * 3 + 10);
    rec.meta.replaceChildren(
      h("b", {}, t.label), " ",
      t.kind === "input" ? sig(t.signal) : h("span", { class: "muted" }, t.kind),
      h("span", { class: "muted" }, age == null ? " waiting for a frame…" : ` ${age}s ago`));
    return rec.el;
  }

  async function poll() {
    const d = await api("POST", "/api/pearls/multiview", { show: prefs.show, every: prefs.every, width: prefs.width, viewer });
    const seen = new Set();
    grid.replaceChildren(...d.pearls.map((p) => {
      p.tiles.forEach((t) => seen.add(`${p.id}|${t.target}`));
      const why = !p.gateway_online ? "gateway offline" : !p.online ? (p.error || "offline") : !p.tiles.length ? "nothing to show yet" : "";
      return h("section", { class: "panel mv-pearl" },
        h("div", { class: "row spread" },
          h("div", {}, h("span", { class: `dot ${p.online ? "on" : "off"}` }), h("a", { href: `#/pearls/${p.id}` }, h("b", {}, p.name)),
            h("span", { class: "muted small" }, ` ${p.room || ""} · ${p.host}`)),
          why ? h("span", { class: "bad small" }, why) : ""),
        h("div", { class: "mv-tiles" }, p.tiles.map((t) => tile(p, t))));
    }));
    for (const k of [...tiles.keys()]) if (!seen.has(k)) tiles.delete(k);
    if (!d.pearls.length) grid.replaceChildren(h("div", { class: "panel empty" }, "No Pearls yet. Add them on the Pearls page."));
    note.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
  const schedule = () => every(prefs.every * 1000, poll);

  setView(
    h("div", { class: "row spread" }, h("h1", {}, "Pearl multiviewer"), h("a", { href: "#/pearls" }, "← Pearls")),
    h("div", { class: "panel row" },
      select("show", [["inputs", "Inputs"], ["outputs", "Outputs"], ["both", "Inputs and outputs"]], "Show"),
      select("every", [[2, "2 s"], [5, "5 s"], [10, "10 s"], [30, "30 s"]], "Refresh every"),
      select("width", [[320, "Small"], [480, "Medium"], [640, "Large"], [960, "Huge"]], "Tiles"),
      note),
    grid);
  await poll();
  schedule();
}
