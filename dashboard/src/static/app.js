// Signage dashboard: a small hash-routed single page app, no build step.
import { gzImageStream, imageStream, saveStream } from "./image.js";
import { initParams, overrideForm, schemaForm, withOrder } from "./params.js";
import { initPerf, perfPanel } from "./perf.js";
import { initPreview, previewPanel } from "./preview.js";
import { bundledZips, listZip, readEntry } from "./zip.js";

const $main = document.getElementById("main");
// (h and api are function declarations below, so they're hoisted.)
initParams({ h, api });
initPerf({ h, api });
initPreview({ h, api });
let info = null;
let timer = null;
let cleanup = null;

// ------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 3500);
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("token") || ""}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") {
    localStorage.removeItem("token");
    location.hash = "#/login";
    throw new Error("log in again");
  }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.errors = data.errors;
    throw err;
  }
  return data;
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function duration(s) {
  s = Math.round(s || 0);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`;
}

function errorList(e) {
  return e.errors?.length ? h("ul", { class: "errors" }, e.errors.map((x) => h("li", {}, x))) : "";
}

function clockText(d) {
  const ntp = d.summary?.ntp || {};
  const off = d.clock_offset || 0;
  const cls = Math.abs(off) > 2 ? "bad" : Math.abs(off) > 0.5 ? "warn" : "ok";
  return h("span", { class: cls, title: "Device clock minus dashboard clock, measured at check-in" },
    `${off >= 0 ? "+" : ""}${(off * 1000).toFixed(0)} ms`,
    ntp.synced === false ? h("span", { class: "warn" }, " (NTP not synced)") : "");
}

const UPDATE_ACTIVE = ["checking", "downloading", "installing", "rebooting"];

// The OS update shown for a device: in progress, or finished within the hour.
function updateInfo(dev) {
  const u = dev.summary?.update;
  if (!u || !u.state) return null;
  if (!UPDATE_ACTIVE.includes(u.state) && Date.now() - (u.updated || 0) > 3600e3) return null;
  return u;
}

function updateBar(u) {
  const label = { checking: "Checking", downloading: "Downloading", installing: "Installing", rebooting: "Rebooting",
    done: "Updated", failed: "Update failed" }[u.state] || u.state;
  return h("div", {},
    h("div", { class: "row spread small" },
      h("span", { class: u.state === "failed" ? "bad" : u.state === "done" ? "ok" : "" },
        `${label}${u.version ? ` ${u.version}` : ""}`),
      UPDATE_ACTIVE.includes(u.state) ? h("span", { class: "muted" }, `${u.percent ?? 0}%`) : ""),
    UPDATE_ACTIVE.includes(u.state) ? h("div", { class: "progress", style: "margin:4px 0" },
      h("div", { style: `width:${u.percent ?? 0}%` })) : "",
    u.message ? h("div", { class: "muted small mono", style: "overflow-wrap:anywhere" }, u.message) : "");
}

const TIMEZONES = (Intl.supportedValuesOf && Intl.supportedValuesOf("timeZone")) || ["America/New_York", "UTC"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function setView(...nodes) {
  if (cleanup) cleanup();
  cleanup = null;
  clearInterval(timer);
  timer = null;
  $main.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

function every(ms, fn) {
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === "visible" && fn().catch(() => {}), ms);
}

// ------------------------------------------------------------ login

function viewLogin() {
  const pw = h("input", { type: "password", autocomplete: "current-password", autofocus: true });
  const err = h("div", { class: "bad small" });
  const form = h("form", {
    class: "panel login",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api("POST", "/api/login", { password: pw.value });
        localStorage.setItem("token", r.token);
        location.hash = "#/devices";
      } catch (x) {
        err.textContent = x.message;
      }
    },
  }, h("h1", {}, "Signage dashboard"), h("p", { class: "muted" }, "Enter the admin password set at deploy time."),
  h("label", { class: "field" }, h("span", {}, "Password"), pw), err,
  h("button", { class: "primary", type: "submit" }, "Log in"));
  setView(form);
}

// ------------------------------------------------------------ devices list

async function viewDevices() {
  const [d, p] = await Promise.all([api("GET", "/api/devices"), api("GET", "/api/programs")]);
  const programs = Object.fromEntries(p.programs.map((x) => [x.id, x]));
  const selected = new Set();
  const tbody = h("tbody");
  const bulkProgram = h("select", {}, h("option", { value: "" }, "No program"),
    p.programs.map((x) => h("option", { value: x.id }, x.name)));
  const bulkBar = h("div", { class: "row", hidden: true },
    h("span", { class: "muted" }, ""), bulkProgram,
    h("button", { onclick: () => bulk({ program_id: bulkProgram.value }, "Program assigned") }, "Assign program"),
    h("button", { onclick: () => bulk({ command: "screenshot" }, "Screenshots requested") }, "Screenshot"),
    h("button", { onclick: () => bulk({ command: "restart-player" }, "Player restart queued") }, "Restart player"),
    h("button", { class: "danger", onclick: () => confirm(`Reboot ${selected.size} device(s)?`) && bulk({ command: "reboot" }, "Reboot queued") }, "Reboot"));

  async function bulk(body, msg) {
    try {
      await api("POST", "/api/devices/bulk", { ids: [...selected], ...body });
      toast(msg);
      await refresh();
    } catch (e) { toast(e.message); }
  }

  function render(devices) {
    tbody.replaceChildren(...devices.map((dev) => {
      const cb = h("input", { type: "checkbox", checked: selected.has(dev.id), onchange: (e) => {
        e.target.checked ? selected.add(dev.id) : selected.delete(dev.id);
        bulkBar.hidden = !selected.size;
        bulkBar.firstChild.textContent = `${selected.size} selected`;
      } });
      const net = dev.summary.network || {};
      return h("tr", {},
        h("td", {}, cb),
        h("td", {}, h("span", { class: `dot ${dev.online ? "on" : "off"}` }), h("a", { href: `#/devices/${dev.id}` }, dev.name),
          dev.summary.errors?.length ? h("span", { class: "bad small", title: dev.summary.errors.join("\n") }, " ⚠") : ""),
        h("td", {}, programs[dev.program_id]?.name || h("span", { class: "muted" }, "none")),
        h("td", { class: "mono", title: dev.ip ? `public address ${dev.ip}` : "" }, (dev.summary.addresses?.[0] || "").replace(/^\S+ /, "").replace(/\/\d+$/, "") || dev.ip || "", net.type ? h("div", { class: "muted small" }, net.type === "wifi" ? `WiFi ${net.ssid || ""} ${net.signal ? net.signal + "%" : ""}` : net.type) : ""),
        h("td", { class: "mono" }, dev.os_version || "?", (() => {
          const u = updateInfo(dev);
          if (!u) return "";
          const cls = u.state === "failed" ? "bad small" : u.state === "done" ? "ok small" : "small";
          return h("div", { class: cls }, UPDATE_ACTIVE.includes(u.state) ? `updating ${u.percent ?? 0}%` : u.state === "done" ? "updated" : "update failed");
        })()),
        h("td", {}, clockText(dev)),
        h("td", { title: new Date(dev.last_seen * 1000).toLocaleString() }, ago(dev.last_seen)));
    }));
    if (!devices.length) {
      tbody.replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "empty" },
        "No devices yet. Make an install stick on the Install images page; players enroll on first boot.")));
    }
  }

  async function refresh() {
    const r = await api("GET", "/api/devices");
    render(r.devices);
  }

  render(d.devices);
  setView(
    h("div", { class: "row spread" }, h("h1", {}, "Devices"), h("span", { class: "muted small" }, `${d.devices.filter((x) => x.online).length} of ${d.devices.length} online`)),
    h("div", { class: "panel" }, bulkBar,
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Name"), h("th", {}, "Program"), h("th", {}, "Address"),
          h("th", {}, "OS"), h("th", {}, "Clock"), h("th", {}, "Last check-in"))), tbody))));
  every(10000, refresh);
}

// ------------------------------------------------------------ device detail

function settingsForm(dev, onSave) {
  const s = structuredClone(dev.settings || {});
  const base = dev.status?.config?.base || {};
  const ph = (sec, key, fallback = "") => {
    const v = base[sec]?.[key];
    return v === undefined || v === "" ? fallback : `stick: ${v}`;
  };
  const name = h("input", { value: s.device?.name || "", placeholder: ph("device", "name", dev.hostname) });
  const tz = h("select", {}, h("option", { value: "" }, `(stick: ${base.device?.timezone || "America/New_York"})`),
    TIMEZONES.map((z) => h("option", { value: z }, z)));
  tz.value = s.device?.timezone || "";
  const outputs = dev.summary?.display?.outputs || [];
  const modes = [...new Set(outputs.flatMap((o) => (o.modes || []).map((m) => m.mode)))];
  const mode = h("input", { value: s.display?.mode ?? "", placeholder: ph("display", "mode", "monitor default"), list: `modes-${dev.id}` });
  const modeList = h("datalist", { id: `modes-${dev.id}` }, modes.map((m) => h("option", { value: m })));
  const custom = h("select", {}, h("option", { value: "" }, "(stick)"), h("option", { value: "false" }, "No"), h("option", { value: "true" }, "Yes, force it"));
  custom.value = s.display?.custom === undefined ? "" : String(s.display.custom);
  const layout = h("select", {}, h("option", { value: "" }, `(stick: ${base.display?.layout === "arch" ? "LED arch" : "Screen"})`),
    h("option", { value: "screen" }, "Screen"), h("option", { value: "arch" }, "LED arch"));
  layout.value = s.display?.layout || "";
  const archHint = h("small", { class: "muted" });
  const syncArch = () => {
    const arch = (layout.value || base.display?.layout) === "arch";
    archHint.textContent = arch ? "The arch draws one 2760×2565 canvas and slices it onto the LED controller's 3840×2160 map, so set Resolution to 3840x2160." : "";
    archHint.hidden = !arch;
    if (arch && !mode.value.trim()) mode.placeholder = "3840x2160 for the arch";
  };
  layout.addEventListener("change", syncArch);
  syncArch();
  const rot = h("select", {}, h("option", { value: "" }, `(stick: ${base.display?.rotation ?? 0}°)`),
    [0, 90, 180, 270].map((r) => h("option", { value: r }, `${r}°`)));
  rot.value = s.display?.rotation === undefined ? "" : String(s.display.rotation);
  const output = h("select", {}, h("option", { value: "" }, "(stick / all outputs)"),
    outputs.map((o) => h("option", { value: o.name }, o.name)));
  if (s.display?.output && !outputs.some((o) => o.name === s.display.output)) output.append(h("option", { value: s.display.output }, s.display.output));
  output.value = s.display?.output || "";
  const scale = h("input", { type: "number", step: "0.05", min: "0.25", max: "4", value: s.display?.scale ?? "", placeholder: ph("display", "scale", "1.0") });

  const ntpOn = h("input", { type: "checkbox", checked: s.ntp?.servers !== undefined });
  const ntp = h("input", { value: (s.ntp?.servers || []).join(", "), placeholder: "ntp1.venue.lan, 10.0.0.1" });

  const wifiOn = h("input", { type: "checkbox", checked: s.network?.wifi !== undefined });
  const wifiRows = h("div");
  const addWifi = (w = {}) => {
    const row = h("div", { class: "fields wifi" },
      h("label", { class: "field" }, h("span", {}, "SSID"), h("input", { name: "ssid", value: w.ssid || "" })),
      h("label", { class: "field" }, h("span", {}, "Password (blank = open)"), h("input", { name: "psk", type: "password", value: w.psk || "" })),
      h("label", { class: "field" }, h("span", {}, "Priority"), h("input", { name: "priority", type: "number", value: w.priority ?? 0 })),
      h("label", { class: "check" }, h("input", { name: "hidden", type: "checkbox", checked: w.hidden }), "Hidden"),
      h("button", { class: "small ghost danger", type: "button", onclick: () => row.remove() }, "Remove"));
    wifiRows.append(row);
  };
  (s.network?.wifi || []).forEach(addWifi);
  const addSaved = (n) => {
    const row = h("div", { class: "fields wifi", "data-saved": n.id },
      h("label", { class: "field" }, h("span", {}, "SSID"), h("input", { value: n.ssid, disabled: true })),
      h("label", { class: "field" }, h("span", {}, "Password"), h("input", { value: n.has_psk ? "saved on the dashboard" : "open", disabled: true })),
      h("label", { class: "field" }, h("span", {}, "Priority"), h("input", { value: n.priority, disabled: true })),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: n.hidden, disabled: true }), "Hidden"),
      h("button", { class: "small ghost danger", type: "button", onclick: () => row.remove() }, "Remove"));
    wifiRows.append(row);
  };
  const savedPick = h("select", { hidden: true, onchange: () => {
    const n = savedPick._nets.find((x) => x.id === savedPick.value);
    savedPick.value = "";
    if (n) { wifiOn.checked = true; addSaved(n); }
  } });
  api("GET", "/api/wifi").then((r) => {
    savedPick._nets = r.networks;
    if (!r.networks.length) return;
    savedPick.replaceChildren(h("option", { value: "" }, "Add a saved network…"), ...r.networks.map((n) => h("option", { value: n.id }, n.ssid)));
    savedPick.hidden = false;
  }).catch(() => {});
  const err = h("div");

  const collect = () => {
    const out = {};
    const dv = {};
    if (name.value.trim()) dv.name = name.value.trim();
    if (tz.value) dv.timezone = tz.value;
    if (Object.keys(dv).length) out.device = dv;
    const disp = {};
    if (mode.value.trim()) disp.mode = mode.value.trim();
    if (custom.value) disp.custom = custom.value === "true";
    if (layout.value) disp.layout = layout.value;
    if (rot.value !== "") disp.rotation = Number(rot.value);
    if (output.value) disp.output = output.value;
    if (scale.value !== "") disp.scale = Number(scale.value);
    if (Object.keys(disp).length) out.display = disp;
    if (ntpOn.checked) out.ntp = { servers: ntp.value.split(/[\s,]+/).filter(Boolean) };
    if (wifiOn.checked) {
      out.network = { wifi: [...wifiRows.querySelectorAll(".wifi")].map((r) => r.dataset.saved ? { saved: r.dataset.saved } : ({
        ssid: r.querySelector("[name=ssid]").value,
        psk: r.querySelector("[name=psk]").value,
        priority: Number(r.querySelector("[name=priority]").value || 0),
        hidden: r.querySelector("[name=hidden]").checked,
      })) };
    }
    return out;
  };

  return h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      const next = collect();
      if (next.network && !next.network.wifi.length && !confirm("This removes every WiFi network. Devices without Ethernet will go offline (they roll back after 5 minutes). Continue?")) return;
      try { await onSave(next); } catch (x) { err.replaceChildren(h("div", { class: "bad" }, x.message), errorList(x)); }
    },
  },
  h("p", { class: "muted small" }, "Blank fields keep the value from the install stick's config.toml. Network changes that cut the device off are rolled back after 5 minutes."),
  h("div", { class: "fields" },
    h("label", { class: "field" }, h("span", {}, "Name (also the hostname)"), name),
    h("label", { class: "field" }, h("span", {}, "Time zone"), tz)),
  h("h3", {}, "Display"),
  h("div", { class: "fields" },
    h("label", { class: "field" }, h("span", {}, "Resolution"), mode, modeList),
    h("label", { class: "field" }, h("span", {}, "Force unadvertised mode"), custom),
    h("label", { class: "field" }, h("span", {}, "Layout"), layout, archHint),
    h("label", { class: "field" }, h("span", {}, "Rotation"), rot),
    h("label", { class: "field" }, h("span", {}, "Output"), output),
    h("label", { class: "field" }, h("span", {}, "Scale"), scale)),
  h("h3", {}, "Network"),
  h("label", { class: "check" }, wifiOn, "Replace the stick's WiFi networks with these"),
  wifiRows,
  h("div", { class: "row" },
    h("button", { type: "button", class: "small", onclick: () => { wifiOn.checked = true; addWifi(); } }, "Add WiFi network"),
    savedPick),
  h("p", {}, h("label", { class: "check" }, ntpOn, "Use these NTP servers"), " ", ntp),
  err,
  h("button", { class: "primary", type: "submit" }, "Save settings"));
}

function statusPanel(dev, command) {
  const st = dev.status || {};
  const sum = dev.summary;
  const net = sum.network || {};
  const ntp = sum.ntp || {};
  const content = sum.content || {};
  const disp = (sum.display?.outputs || []).map((o) =>
    `${o.name}: ${o.current || "off"}${o.transform && o.transform !== "normal" ? ` rot ${o.transform}` : ""}`).join(", ");
  return h("dl", { class: "kv" },
    h("dt", {}, "Status"), h("dd", {}, h("span", { class: `dot ${dev.online ? "on" : "off"}` }), dev.online ? "online" : "offline", ` · checked in ${ago(dev.last_seen)}`),
    h("dt", {}, "Hostname"), h("dd", { class: "mono" }, dev.hostname),
    h("dt", {}, "OS version"), h("dd", { class: "mono" }, dev.os_version || "?"),
    updateInfo(dev) ? [h("dt", {}, "OS update"), h("dd", {}, updateBar(updateInfo(dev)))] : null,
    h("dt", {}, "Uptime"), h("dd", {}, duration(sum.uptime)),
    h("dt", {}, "Network"), h("dd", {}, net.type === "wifi" ? `WiFi "${net.ssid || "?"}" ${net.signal ?? "?"}%` : net.type || "?", net.interface ? h("span", { class: "muted" }, ` (${net.interface})`) : ""),
    h("dt", {}, "Addresses"), h("dd", { class: "mono" }, (sum.addresses || []).join(", ") || "none", dev.ip ? h("div", { class: "muted" }, `public ${dev.ip}`) : ""),
    h("dt", {}, "MAC"), h("dd", { class: "mono" }, dev.mac),
    h("dt", {}, "Clock"), h("dd", {}, clockText(dev), ntp.source ? h("span", { class: "muted" }, ` · NTP ${ntp.source}, offset ${((ntp.offset || 0) * 1000).toFixed(1)} ms`) : ""),
    h("dt", {}, "Display"), h("dd", { class: "mono" }, disp || "unknown"),
    h("dt", {}, "Player"), h("dd", {}, sum.player || "?"),
    st.renderer ? [h("dt", {}, "Renderer"), h("dd", { class: "small" },
      /llvmpipe|softpipe|swrast|software/i.test(st.renderer) ? h("span", { class: "warn" }, "Software rendering: ") : "", st.renderer)] : null,
    st.profiles?.length ? [h("dt", {}, "GPU profiles"), h("dd", {}, st.profiles.map((f) => h("div", { class: "row small" },
      h("span", { class: "mono" }, f.name), h("span", { class: "muted" }, `${bytes(f.size)} · ${ago(f.mtime)}`),
      command ? h("button", { class: "small ghost", onclick: () => command("fetch-file", { name: f.name }) }, "Fetch") : "")))] : null,
    h("dt", {}, "Content"), h("dd", {}, content.rev ? h("span", { class: content.rev === dev.content_rev ? "" : "warn" }, `rev ${content.rev}`) : "none",
      content.error ? h("div", { class: "bad" }, content.error) : ""),
    h("dt", {}, "Disk"), h("dd", {}, st.disk ? `${bytes(st.disk.used)} of ${bytes(st.disk.total)} used` : "?"),
    h("dt", {}, "Config"), h("dd", { class: "mono small" }, st.config?.source || "?",
      dev.applied_settings_rev !== dev.settings_rev ? h("div", { class: "warn" }, "dashboard settings not applied yet") : "",
      st.config?.rolled_back ? h("div", { class: "bad" }, `rolled back: ${st.config.rolled_back}`) : ""),
    sum.errors?.length ? [h("dt", {}, "Problems"), h("dd", { class: "bad" }, sum.errors.map((e) => h("div", {}, e)))] : null);
}

async function viewDevice(id) {
  let dev = await api("GET", `/api/devices/${id}`);
  const programs = (await api("GET", "/api/programs")).programs;
  const statusBox = h("div");
  const cmdBox = h("tbody");
  const shotsBox = h("div");
  const termBox = h("div");
  let lastShotCmd = null;

  const title = h("h1");
  const renderHead = () => {
    title.replaceChildren(h("span", { class: `dot ${dev.online ? "on" : "off"}` }), dev.name);
    statusBox.replaceChildren(statusPanel(dev, command));
    cmdBox.replaceChildren(...dev.commands.map((cmd) => h("tr", {},
      h("td", {}, cmd.type, cmd.args?.version ? ` ${cmd.args.version}` : "", cmd.args?.seconds ? ` ${cmd.args.seconds}s` : "", cmd.file || cmd.args?.name ? h("div", { class: "muted small mono" }, cmd.file || cmd.args.name) : ""),
      h("td", { class: cmd.state === "failed" ? "bad" : cmd.state === "done" ? "ok" : "muted" }, cmd.state),
      h("td", { title: new Date(cmd.created * 1000).toLocaleString() }, ago(cmd.created)),
      h("td", {}, (cmd.type === "profile" || cmd.type === "fetch-file") && cmd.state === "done"
        ? h("button", { class: "small primary", onclick: () => downloadFile(cmd) }, "Download") : "",
        cmd.output ? h("details", {}, h("summary", { class: "small" }, "output"), h("pre", { class: "small" }, cmd.output)) : ""))));
    if (!dev.commands.length) cmdBox.replaceChildren(h("tr", {}, h("td", { colspan: 4, class: "muted" }, "No commands yet.")));
  };

  const loadShots = async () => {
    const r = await api("GET", `/api/devices/${id}/screenshots`);
    if (!r.screenshots.length) {
      shotsBox.replaceChildren(h("p", { class: "muted" }, "No screenshots yet."));
      return;
    }
    const zoom = (url) => {
      const m = h("div", { class: "modal", onclick: () => m.remove() }, h("img", { src: url }));
      document.body.append(m);
    };
    const [first, ...rest] = r.screenshots;
    shotsBox.replaceChildren(
      h("div", { class: "shot-main" }, h("img", { src: first.url, onclick: () => zoom(first.url) }),
        h("div", { class: "muted small" }, new Date(first.taken * 1000).toLocaleString())),
      rest.length ? h("div", { class: "shots", style: "margin-top:8px" }, rest.map((s) =>
        h("img", { src: s.url, title: new Date(s.taken * 1000).toLocaleString(), onclick: () => zoom(s.url) }))) : "");
  };

  const downloadFile = async (cmd) => {
    try {
      const r = await api("GET", `/api/devices/${id}/commands/${cmd.id}/file`);
      const a = h("a", { href: r.url, download: r.name });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) { toast(e.message); }
  };
  const command = async (type, args) => {
    try {
      const cmd = await api("POST", `/api/devices/${id}/commands`, { type, args });
      if (type === "screenshot") lastShotCmd = cmd.id;
      toast(dev.online ? `${type} sent; the device picks it up within a few seconds` : `${type} queued until the device checks in`);
      await refresh();
    } catch (e) { toast(e.message); }
  };

  const perf = perfPanel(id);
  let perfAt = Date.now();
  const refresh = async () => {
    dev = await api("GET", `/api/devices/${id}`);
    renderHead();
    // New samples arrive every 10-15 s; redraw twice a minute, but not under the pointer.
    if (Date.now() - perfAt > 30000 && perf.querySelector(".perf-tip")?.hidden !== false) {
      perfAt = Date.now();
      perf.load();
    }
    if (lastShotCmd) {
      const c = dev.commands.find((x) => x.id === lastShotCmd);
      if (c && c.state !== "pending" && c.state !== "sent") {
        lastShotCmd = null;
        if (c.state === "done") await loadShots();
        else toast(`Screenshot ${c.state}: ${c.output || ""}`);
      }
    }
  };

  const program = h("select", {
    onchange: async (e) => {
      try {
        dev = { ...dev, ...(await api("PATCH", `/api/devices/${id}`, { program_id: e.target.value })) };
        toast("Program assigned");
        drawParams();
      } catch (x) { toast(x.message); }
    },
  }, h("option", { value: "" }, "No program"), programs.map((p) => h("option", { value: p.id }, p.name)));
  program.value = dev.program_id;

  // Graphic parameters for this device (a room, say), per package in its program.
  const paramsBox = h("div");
  const drawParams = async () => {
    if (!dev.program_id) {
      paramsBox.replaceChildren(h("p", { class: "muted small" }, "Assign a program to set its graphics' parameters for this device."));
      return;
    }
    let prog, pkgs;
    try {
      [prog, pkgs] = await Promise.all([api("GET", `/api/programs/${dev.program_id}`), api("GET", "/api/packages")]);
    } catch (e) { paramsBox.replaceChildren(h("p", { class: "bad small" }, e.message)); return; }
    const byId = Object.fromEntries(pkgs.packages.map((x) => [x.id, x]));
    const used = [];
    for (const l of prog.layers) for (const it of l.items) {
      if (!it.package || used.some((u) => u.id === it.package)) continue;
      const pkg = byId[it.package];
      const ver = pkg?.versions.find((v) => v.version === (it.version || pkg.active_version));
      if (ver?.schema?.properties) used.push({ id: it.package, name: pkg.name || it.package, schema: withOrder(ver.schema, ver.schema_order, ver.schema_json), base: it.data || {} });
    }
    if (!used.length) {
      paramsBox.replaceChildren(h("p", { class: "muted small" }, "None of this program's graphics have parameters."));
      return;
    }
    const forms = used.map((u) => ({ ...u, form: overrideForm(u.schema, dev.params?.[u.id] || {}, u.base) }));
    const err = h("div");
    paramsBox.replaceChildren(
      h("p", { class: "muted small" }, "Values set here replace the program's for this device only, in every item of that graphic."),
      ...forms.map((f) => h("div", { class: "param-pkg" }, forms.length > 1 ? h("h3", {}, f.name) : "", f.form)),
      err,
      h("button", { class: "primary", type: "button", onclick: async () => {
        err.replaceChildren();
        const params = { ...(dev.params || {}) };
        try { for (const f of forms) params[f.id] = f.form.getValue(); }
        catch (e) { return err.replaceChildren(h("div", { class: "bad" }, e.message)); }
        for (const k of Object.keys(params)) if (!Object.keys(params[k]).length) delete params[k];
        try {
          dev = { ...dev, ...(await api("PATCH", `/api/devices/${id}`, { params })) };
          toast("Saved; the device picks it up at its next check-in");
        } catch (e) { err.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
      } }, "Save parameters"));
  };
  drawParams();

  const notes = h("textarea", { style: "min-height:60px", placeholder: "Location, owner, anything useful",
    onchange: async (e) => { await api("PATCH", `/api/devices/${id}`, { notes: e.target.value }); toast("Notes saved"); } });
  notes.value = dev.notes || "";

  renderHead();
  loadShots();
  setView(
    h("div", { class: "row spread" },
      h("div", {}, h("a", { href: "#/devices", class: "small" }, "← Devices"), title),
      h("div", { class: "row" },
        h("button", { onclick: () => command("screenshot") }, "Screenshot"),
        h("button", { onclick: () => openTerminal(id, termBox) }, "Terminal"),
        h("button", { onclick: () => command("restart-player") }, "Restart player"),
        h("button", { onclick: () => command("resync") }, "Re-sync content"),
        h("button", { title: "Record a Firefox Profiler trace (open it at profiler.firefox.com)", onclick: () => {
          const v = prompt("Record a GPU / Firefox profile for how many seconds (5 to 120)?", "20");
          if (v !== null) command("profile", { seconds: Number(v) || 20 });
        } }, "GPU profile"),
        h("button", { onclick: () => {
          const v = prompt("OS version to install (blank = newest release). The device reboots into it.", "");
          if (v !== null) command("os-update", v.trim() ? { version: v.trim() } : {});
        } }, "Update OS"),
        h("button", { class: "danger", onclick: () => confirm(`Reboot ${dev.name}?`) && command("reboot") }, "Reboot"))),
    termBox,
    h("div", { class: "panel" }, h("h2", {}, "Performance, last hour"), perf),
    h("div", { class: "grid2" },
      h("div", {},
        h("div", { class: "panel" }, h("h2", {}, "Screen"), shotsBox),
        h("div", { class: "panel" }, h("h2", {}, "Content"),
          h("label", { class: "field" }, h("span", {}, "Program"), program),
          h("p", { class: "muted small" }, "Programs set which OGraf graphics play on which layer and how they rotate. ", h("a", { href: "#/programs" }, "Edit programs"))),
        h("div", { class: "panel" }, h("h2", {}, "Graphic parameters"), paramsBox),
        h("div", { class: "panel" }, h("h2", {}, "Settings"), settingsForm(dev, async (settings) => {
          dev = { ...dev, ...(await api("PATCH", `/api/devices/${id}`, { settings })) };
          toast("Saved; the device applies it at its next check-in");
        }))),
      h("div", {},
        h("div", { class: "panel" }, h("h2", {}, "Status"), statusBox),
        h("div", { class: "panel" }, h("h2", {}, "Commands"), h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Command"), h("th", {}, "State"), h("th", {}, "When"), h("th", {}, ""))), cmdBox))),
        h("div", { class: "panel" }, h("h2", {}, "Notes"), notes),
        h("div", { class: "panel" }, h("h2", {}, "Remove"),
          h("p", { class: "muted small" }, "Removes the device from the dashboard. If it is still running it enrolls again at its next check-in, without its settings."),
          h("button", { class: "danger", onclick: async () => {
            if (!confirm(`Remove ${dev.name}?`)) return;
            await api("DELETE", `/api/devices/${id}`);
            location.hash = "#/devices";
          } }, "Remove device")))));
  every(4000, refresh);
}

// ------------------------------------------------------------ terminal

async function openTerminal(id, box) {
  if (box.firstChild) return;
  if (!window.Terminal) return toast("The terminal library didn't load (check your network)");
  const status = h("span", { class: "muted small" }, "Asking the device to connect…");
  const termEl = h("div", { class: "term-wrap" });
  let ws = null;
  const close = () => { ws?.close(); box.replaceChildren(); };
  box.replaceChildren(h("div", { class: "panel" },
    h("div", { class: "row spread" }, h("h2", { style: "margin:0" }, "Terminal"), status, h("button", { class: "small", onclick: close }, "Close")),
    h("div", { style: "margin-top:10px" }, termEl)));
  const term = new window.Terminal({ fontSize: 13, cursorBlink: true, convertEol: false, theme: { background: "#000000" } });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  fit.fit();
  let s;
  try { s = await api("POST", `/api/devices/${id}/terminal`); } catch (e) { status.textContent = e.message; return; }
  ws = new WebSocket(`${s.ws_url}?session=${s.session}&role=admin&token=${encodeURIComponent(s.token)}`);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const dec = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  // The relay runs one Lambda per frame, concurrently, so frames can arrive
  // out of order. Both ends number their frames and put them back in order;
  // a gap lasting over a second (a lost frame) is skipped.
  let outNext = 0, outPending = new Map(), gapTimer = null, inSeq = 0;
  const flushOut = () => {
    while (outPending.has(outNext)) { term.write(outPending.get(outNext)); outPending.delete(outNext); outNext++; }
    clearTimeout(gapTimer);
    if (outPending.size) gapTimer = setTimeout(() => { outNext = Math.min(...outPending.keys()); flushOut(); }, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "o" && typeof m.s === "number") { if (m.s >= outNext) { outPending.set(m.s, dec(m.d)); flushOut(); } }
    else if (m.t === "o") term.write(dec(m.d));
    else if (m.t === "ready") { if (!ready) { ready = true; inSeq = 0; } status.textContent = "Connected (root shell)"; send({ t: "r", cols: term.cols, rows: term.rows }); term.focus(); }
    else if (m.t === "closed") { ready = false; status.textContent = "Session ended"; term.write("\r\n[session ended]\r\n"); }
    else if (m.t === "waiting") status.textContent = "Still waiting for the device…";
  };
  ws.onopen = () => send({ t: "hello" });
  ws.onclose = () => { if (!status.textContent.startsWith("Session")) status.textContent = "Disconnected"; };
  let ready = false;
  term.onData((d) => ready && send({ t: "i", s: inSeq++, d }));
  term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));
  const onResize = () => fit.fit();
  window.addEventListener("resize", onResize);
  const ping = setInterval(() => send({ t: "ping" }), 60000);
  const prev = cleanup;
  cleanup = () => { prev?.(); ws?.close(); clearInterval(ping); window.removeEventListener("resize", onResize); };
}

// ------------------------------------------------------------ programs

async function viewPrograms() {
  const r = await api("GET", "/api/programs");
  const d = await api("GET", "/api/devices");
  const count = (pid) => d.devices.filter((x) => x.program_id === pid).length;
  setView(
    h("div", { class: "row spread" }, h("h1", {}, "Programs"),
      h("button", { class: "primary", onclick: () => (location.hash = "#/programs/new") }, "New program")),
    h("p", { class: "muted" }, "A program is a stack of layers. Each layer rotates through its graphics: the current one animates out, then the next animates in."),
    h("div", { class: "panel" }, r.programs.length ? h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Layers"), h("th", {}, "Graphics"), h("th", {}, "Devices"), h("th", {}, "Updated"))),
      h("tbody", {}, r.programs.map((p) => h("tr", {},
        h("td", {}, h("a", { href: `#/programs/${p.id}` }, p.name), p.description ? h("div", { class: "muted small" }, p.description) : ""),
        h("td", {}, p.layers.length),
        h("td", {}, p.layers.reduce((n, l) => n + l.items.length, 0)),
        h("td", {}, count(p.id)),
        h("td", {}, ago(p.updated))))))
      : h("p", { class: "empty" }, "No programs yet.")));
}

function schemaDefaults(schema) {
  const out = {};
  for (const [k, v] of Object.entries(schema?.properties || {})) {
    if (v.default !== undefined) out[k] = v.default;
    else if (v.type === "object") out[k] = schemaDefaults(v);
  }
  return out;
}

async function viewProgram(id) {
  const pk = (await api("GET", "/api/packages")).packages;
  let p = id === "new" ? { name: "", description: "", layers: [{ name: "Main", layer: 10, items: [] }] } : await api("GET", `/api/programs/${id}`);
  const pkgById = Object.fromEntries(pk.map((x) => [x.id, x]));
  const layersBox = h("div");
  const err = h("div");
  const name = h("input", { value: p.name, placeholder: "Main hall" });
  const desc = h("input", { value: p.description, placeholder: "Optional" });

  function itemEditor(it, layer) {
    const pkgSel = h("select", {}, h("option", { value: "" }, "Choose a package"), pk.map((x) => h("option", { value: x.id }, x.name ? `${x.name} (${x.id})` : x.id)));
    pkgSel.value = it.package || "";
    const verSel = h("select");
    const fillVersions = () => {
      const pkg = pkgById[pkgSel.value];
      verSel.replaceChildren(h("option", { value: "" }, pkg ? `Active version (${pkg.active_version})` : "Active version"),
        ...(pkg?.versions || []).map((v) => h("option", { value: v.version }, `Pin ${v.version}`)));
      verSel.value = it.version || "";
    };
    fillVersions();
    // Graphic data: a form from the version's schema, or JSON for anything the form can't show.
    const dataBox = h("div");
    const verSchema = () => {
      const pkg = pkgById[pkgSel.value];
      const v = pkg?.versions.find((x) => x.version === (verSel.value || pkg.active_version));
      return v?.schema ? withOrder(v.schema, v.schema_order, v.schema_json) : null;
    };
    let form = null;
    let asJson = false;
    const jsonToggle = h("button", { type: "button", class: "small ghost" });
    const drawData = () => {
      const schema = verSchema();
      const useJson = asJson || !schema?.properties;
      jsonToggle.textContent = useJson ? "Edit as a form" : "Edit as JSON";
      jsonToggle.hidden = !schema?.properties;
      if (useJson) {
        const ta = h("textarea", { class: "mono" });
        ta.value = JSON.stringify(it.data || {}, null, 2);
        ta.getValue = () => JSON.parse(ta.value || "{}");
        form = ta;
        dataBox.replaceChildren(h("label", { class: "field" }, h("span", {}, "Graphic data (JSON, passed to the OGraf graphic)"), ta));
      } else {
        form = schemaForm(schema, it.data || {});
        dataBox.replaceChildren(form);
      }
    };
    const readData = () => {
      try { it.data = form.getValue(); return true; } catch { return false; }
    };
    jsonToggle.addEventListener("click", () => {
      if (!readData()) return toast("That isn't valid JSON");
      asJson = !asJson;
      drawData();
    });
    const fillDefaults = () => {
      readData();
      it.data = { ...schemaDefaults(verSchema()), ...(it.data || {}) };
      drawData();
    };
    pkgSel.addEventListener("change", () => {
      readData();
      it.package = pkgSel.value;
      fillVersions();
      if (!Object.keys(it.data || {}).length) it.data = schemaDefaults(verSchema());
      drawData();
    });
    verSel.addEventListener("change", () => { readData(); it.version = verSel.value; drawData(); });
    drawData();
    const dur = h("input", { type: "number", min: 0, value: it.duration ?? 30, onchange: (e) => (it.duration = Number(e.target.value)) });
    const label = h("input", { value: it.label || "", placeholder: "Optional", onchange: (e) => (it.label = e.target.value) });
    const field = (k, type) => h("input", { type, value: it[k] || "", onchange: (e) => (it[k] = e.target.value) });
    const days = h("div", { class: "days" }, DAYS.map((dname, i) => h("label", { class: "check" },
      h("input", { type: "checkbox", checked: (it.days || []).includes(i), onchange: (e) => {
        const s = new Set(it.days || []);
        e.target.checked ? s.add(i) : s.delete(i);
        it.days = [...s].sort();
      } }), dname)));
    it._read = readData;
    // Collapsed: one line that says what plays, for how long and when.
    const sumText = h("span", { class: "item-sum" });
    const describe = () => {
      readData();
      const pkg = pkgById[pkgSel.value];
      const bits = [];
      if (it.version) bits.push(`pinned ${it.version}`);
      const d = Number(it.duration ?? 30);
      bits.push(d ? `${d}s` : "until replaced");
      const days = (it.days || []).length;
      if (days && days < 7) bits.push(it.days.map((i) => DAYS[i]).join(" "));
      if (it.start || it.end) bits.push(`${it.start || "00:00"}–${it.end || "24:00"}`);
      if (it.from || it.until) bits.push(`${(it.from || "").replace("T", " ") || "…"} to ${(it.until || "").replace("T", " ") || "…"}`);
      const schema = verSchema();
      for (const [k, ps] of Object.entries(schema?.properties || {})) {
        const v = it.data?.[k];
        if (ps["x-signage-options"] && Array.isArray(v) && v.length) bits.push(`${ps.title || k}: ${v.join(", ")}`);
        else if (ps["x-signage-options"] && typeof v === "string" && v) bits.push(`${ps.title || k}: ${v}`);
      }
      sumText.replaceChildren(
        h("strong", {}, it.label || pkg?.name || pkgSel.value || "Choose a graphic"),
        it.label && pkg ? h("span", { class: "muted" }, ` ${pkg.name}`) : "",
        h("span", { class: "muted small" }, ` · ${bits.join(" · ")}`));
    };
    const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); preview.changed(); };
    const el = h("details", { class: "item", open: !!it._open, ontoggle: () => { it._open = el.open; } },
      h("summary", {}, sumText,
        h("span", { class: "item-tools" },
          h("button", { type: "button", class: "small ghost", title: "Move up", onclick: stop(() => move(layer.items, it, -1)) }, "↑"),
          h("button", { type: "button", class: "small ghost", title: "Move down", onclick: stop(() => move(layer.items, it, 1)) }, "↓"),
          h("button", { type: "button", class: "small ghost danger", title: "Remove", onclick: stop(() => { layer.items.splice(layer.items.indexOf(it), 1); render(); }) }, "Remove"))),
      h("div", { class: "item-body" },
      h("div", { class: "fields" },
        h("label", { class: "field" }, h("span", {}, "Graphic package"), pkgSel),
        h("label", { class: "field" }, h("span", {}, "Version"), verSel),
        h("label", { class: "field" }, h("span", {}, "Seconds on screen (0 = until replaced)"), dur),
        h("label", { class: "field" }, h("span", {}, "Label"), label)),
      h("details", {}, h("summary", { class: "small" }, "Schedule (optional): days, hours, dates"),
        h("div", { class: "fields", style: "margin-top:8px" },
          h("label", { class: "field" }, h("span", {}, "Days (none = every day)"), days),
          h("label", { class: "field" }, h("span", {}, "From time of day"), field("start", "time")),
          h("label", { class: "field" }, h("span", {}, "Until time of day"), field("end", "time")),
          h("label", { class: "field" }, h("span", {}, "Starting on"), field("from", "datetime-local")),
          h("label", { class: "field" }, h("span", {}, "Ending on"), field("until", "datetime-local")))),
      h("h3", { class: "small-h" }, "Graphic parameters"),
      dataBox,
      h("div", { class: "row" },
        jsonToggle,
        h("button", { type: "button", class: "small", onclick: fillDefaults }, "Fill missing defaults"))));
    el.addEventListener("change", () => setTimeout(describe));
    el.addEventListener("input", (e) => { if (e.target === label || e.target === dur) setTimeout(describe); });
    label.addEventListener("input", (e) => (it.label = e.target.value));
    dur.addEventListener("input", (e) => (it.duration = Number(e.target.value)));
    describe();
    return el;
  }

  function move(list, x, dir) {
    const i = list.indexOf(x);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    render();
  }

  function render() {
    syncData();
    layersBox.replaceChildren(...p.layers.map((layer) => h("div", { class: "layer" },
      h("div", { class: "row" },
        h("label", { class: "field" }, h("span", {}, "Layer name"), h("input", { value: layer.name, onchange: (e) => (layer.name = e.target.value) })),
        h("label", { class: "field" }, h("span", {}, "Layer number (higher is in front)"), h("input", { type: "number", value: layer.layer, onchange: (e) => (layer.layer = Number(e.target.value)) })),
        h("button", { type: "button", class: "small danger", onclick: () => { p.layers.splice(p.layers.indexOf(layer), 1); render(); } }, "Remove layer")),
      layer.items.length ? null : h("p", { class: "muted small" }, "No graphics on this layer yet."),
      layer.items.map((it) => itemEditor(it, layer)),
      h("button", { type: "button", class: "small", style: "margin-top:10px", onclick: () => { layer.items.push({ package: "", version: "", duration: 30, data: {}, _open: true }); render(); } }, "Add graphic"))));
  }

  function syncData() {
    for (const layer of p.layers) for (const it of layer.items) {
      if (it._read && !it._read()) it._dataError = true;
    }
  }

  // The program as edited so far, or null while a JSON box can't be parsed.
  const draft = () => {
    syncData();
    const bad = p.layers.flatMap((l) => l.items).find((it) => it._dataError);
    p.layers.forEach((l) => l.items.forEach((it) => delete it._dataError));
    if (bad) return null;
    return { name: name.value, description: desc.value, layers: p.layers.map((l) => ({
      name: l.name, layer: l.layer, items: l.items.map(({ _read, _dataError, _open, ...rest }) => rest) })) };
  };

  const save = async () => {
    err.replaceChildren();
    const body = draft();
    if (!body) return err.replaceChildren(h("div", { class: "bad" }, "One of the graphic data boxes isn't valid JSON."));
    try {
      const saved = id === "new" ? await api("POST", "/api/programs", body) : await api("PUT", `/api/programs/${id}`, body);
      toast("Program saved; devices pick it up at their next check-in");
      if (id === "new") location.hash = `#/programs/${saved.id}`;
    } catch (e) { err.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
  };

  const preview = previewPanel(draft);
  const editor = h("div", { class: "prog-editor" });
  // Any edit (typing, picks, reorders, adds and removes) refreshes the preview.
  for (const ev of ["input", "change", "click"]) editor.addEventListener(ev, (e) => {
    if (ev === "click" && !e.target.closest("button")) return;
    preview.changed();
  });

  render();
  editor.append(...[
    pk.length ? null : h("div", { class: "panel warn" }, "Upload an OGraf package first, on the ", h("a", { href: "#/packages" }, "Packages"), " page."),
    h("div", { class: "panel" }, h("div", { class: "fields" },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Description"), desc))),
    layersBox,
    h("div", { class: "row" },
      h("button", { type: "button", class: "ghost", onclick: () => { syncData(); p.layers.forEach((l) => l.items.forEach((x) => (x._open = true))); render(); } }, "Expand all"),
      h("button", { type: "button", class: "ghost", onclick: () => { syncData(); p.layers.forEach((l) => l.items.forEach((x) => (x._open = false))); render(); } }, "Collapse all"),
      h("button", { type: "button", onclick: () => { p.layers.push({ name: `Layer ${p.layers.length + 1}`, layer: 10 * (p.layers.length + 1), items: [] }); render(); } }, "Add layer"),
      h("button", { class: "primary", onclick: save }, "Save program"),
      id !== "new" ? h("button", { class: "danger", onclick: async () => {
        if (!confirm(`Delete ${p.name}?`)) return;
        try { await api("DELETE", `/api/programs/${id}`); location.hash = "#/programs"; } catch (e) { toast(e.message); }
      } }, "Delete") : null),
    err].filter(Boolean));
  setView(
    h("div", {}, h("a", { href: "#/programs", class: "small" }, "← Programs"), h("h1", {}, id === "new" ? "New program" : p.name)),
    h("div", { class: "prog-wrap" }, editor, h("aside", { class: "prog-side" }, preview.el)));
  cleanup = () => preview.stop();
}

// ------------------------------------------------------------ packages

async function viewPackages() {
  const r = await api("GET", "/api/packages");
  const file = h("input", { type: "file", accept: ".zip,application/zip", multiple: true });
  const activate = h("input", { type: "checkbox", checked: true });
  const ver = h("input", { placeholder: "from manifest" });
  const msg = h("div", { class: "small" });
  const results = h("ul", { class: "upload-results small" });
  // One package zip: a presigned PUT straight to S3, then the import.
  const uploadOne = async (blob, version) => {
    const u = await api("POST", "/api/packages/upload");
    const put = await fetch(u.url, { method: "PUT", body: blob, headers: { "content-type": "application/zip" } });
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
    return api("POST", "/api/packages/import", { key: u.key, version, activate: activate.checked });
  };
  const upload = async (e) => {
    e.preventDefault();
    const files = [...file.files];
    if (!files.length) return;
    results.replaceChildren();
    msg.className = "small muted";
    // A bundle (a zip of package zips) is opened here and each package uploaded on its own.
    const jobs = [];
    try {
      for (const f of files) {
        const buf = await f.arrayBuffer();
        let inner = null;
        try { inner = bundledZips(listZip(buf)); } catch { /* not a zip: let the server say so */ }
        if (!inner) jobs.push({ label: f.name, blob: f });
        else for (const ent of inner) jobs.push({ label: `${f.name}: ${ent.name}`, load: () => readEntry(buf, ent) });
      }
    } catch (x) {
      msg.className = "small bad";
      msg.textContent = x.message;
      return;
    }
    // A version typed in the form only makes sense for a single package.
    const version = jobs.length === 1 ? ver.value.trim() || undefined : undefined;
    let ok = 0, same = 0, failed = 0;
    for (const [i, job] of jobs.entries()) {
      msg.textContent = `Uploading ${i + 1} of ${jobs.length}: ${job.label}…`;
      const li = h("li", {}, h("span", { class: "mono" }, job.label), " ");
      results.append(li);
      try {
        const blob = job.blob || new Blob([await job.load()], { type: "application/zip" });
        const res = await uploadOne(blob, version);
        li.append(h("span", { class: "ok" }, res.unchanged ? `${res.id} ${res.version} already uploaded`
          : `${res.id} ${res.version}${res.active_version === res.version ? ", active" : ""}`));
        res.unchanged ? same++ : ok++;
      } catch (x) {
        li.append(h("span", { class: "bad" }, x.message));
        failed++;
      }
    }
    if (jobs.length === 1 && !failed) {
      toast(results.textContent.includes("already") ? "That version was already uploaded" : "Uploaded");
      return viewPackages();
    }
    msg.className = failed ? "small bad" : "small muted";
    msg.textContent = `${jobs.length} packages: ${ok} uploaded${same ? `, ${same} already there` : ""}${failed ? `, ${failed} failed (below)` : ""}.`;
    const fresh = await api("GET", "/api/packages");
    list.replaceChildren(...(fresh.packages.length ? fresh.packages.map(pkgPanel) : [h("div", { class: "panel empty" }, "No packages uploaded yet.")]));
  };
  const list = h("div");
  const pkgPanel = (p) => h("div", { class: "panel" },
    h("div", { class: "row spread" },
      h("div", {}, h("h2", { style: "margin:0" }, p.name || p.id), h("div", { class: "muted small mono" }, p.id), p.description ? h("div", { class: "muted small" }, p.description) : ""),
      h("button", { class: "small danger", onclick: async () => {
        if (!confirm(`Delete ${p.id} and all its versions?`)) return;
        try { await api("DELETE", `/api/packages/${encodeURIComponent(p.id)}`); viewPackages(); } catch (e) { toast(e.message); }
      } }, "Delete package")),
    h("div", { class: "table-wrap" }, h("table", { style: "margin-top:10px" },
      h("thead", {}, h("tr", {}, h("th", {}, "Version"), h("th", {}, "Uploaded"), h("th", {}, "Size"), h("th", {}, "SHA-256"), h("th", {}, ""))),
      h("tbody", {}, p.versions.map((v) => h("tr", {},
        h("td", { class: "mono" }, v.version, v.version === p.active_version ? h("span", { class: "chip", style: "margin-left:6px" }, "active") : ""),
        h("td", {}, ago(v.uploaded)),
        h("td", {}, bytes(v.size)),
        h("td", { class: "mono small", title: v.sha256 }, v.sha256.slice(0, 12)),
        h("td", { class: "row" },
          v.version !== p.active_version ? h("button", { class: "small", onclick: async () => {
            await api("PATCH", `/api/packages/${encodeURIComponent(p.id)}`, { active_version: v.version });
            toast(`${p.id} ${v.version} is now active everywhere it isn't pinned`);
            viewPackages();
          } }, "Make active") : null,
          v.version !== p.active_version ? h("button", { class: "small danger", onclick: async () => {
            try { await api("DELETE", `/api/packages/${encodeURIComponent(p.id)}/versions/${encodeURIComponent(v.version)}`); viewPackages(); } catch (e) { toast(e.message); }
          } }, "Delete") : null)))))));
  list.replaceChildren(...(r.packages.length ? r.packages.map(pkgPanel) : [h("div", { class: "panel empty" }, "No packages uploaded yet.")]));
  setView(
    h("h1", {}, "OGraf packages"),
    h("p", { class: "muted" }, "Upload a zip with an OGraf graphic (its *.ograf.json manifest and files), several at once, or a bundle: a zip of package zips. Programs use the active version unless they pin one, so making a version active rolls it out to every device."),
    h("form", { class: "panel", onsubmit: upload },
      h("h2", {}, "Upload"),
      h("div", { class: "row" }, file,
        h("label", { class: "check", title: "Only for a single package" }, h("span", { class: "muted small" }, "Version"), ver),
        h("label", { class: "check" }, activate, "Make it the active version"),
        h("button", { class: "primary", type: "submit" }, "Upload")), msg, results),
    list,
    tokensPanel());
}

// Upload tokens: for scripts/signage-upload, which uploads and activates
// packages from a terminal (or a Claude session) without the password.
function tokensPanel() {
  const box = h("div");
  const name = h("input", { placeholder: "e.g. Claude graphic threads", maxlength: 60 });
  const shown = h("div");
  const load = async () => {
    const r = await api("GET", "/api/tokens");
    box.replaceChildren(r.tokens.length ? h("div", { class: "table-wrap" }, h("table", { class: "small" },
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Created"), h("th", {}, "Last used"), h("th", {}, ""))),
      h("tbody", {}, r.tokens.map((t) => h("tr", {},
        h("td", {}, t.name), h("td", {}, ago(t.created)), h("td", {}, t.used ? ago(t.used) : "never"),
        h("td", {}, h("button", { class: "small danger", onclick: async () => {
          if (!confirm(`Revoke the token "${t.name}"? Scripts using it stop working.`)) return;
          await api("DELETE", `/api/tokens/${t.id}`);
          load();
        } }, "Revoke"))))))) : h("p", { class: "muted small" }, "No upload tokens yet."));
  };
  const create = async (e) => {
    e.preventDefault();
    try {
      const t = await api("POST", "/api/tokens", { name: name.value });
      name.value = "";
      const cmd = `echo '${JSON.stringify({ url: location.origin, token: t.token })}' > .signage-upload\ndashboard/scripts/signage-upload path/to/package-folder`;
      shown.replaceChildren(h("div", { class: "panel warn small" },
        h("p", { style: "margin-top:0" }, h("strong", {}, "Copy this token now. "), "It isn't shown again; revoke it and make a new one if it's lost."),
        h("pre", { class: "mono", style: "white-space:pre-wrap;overflow-wrap:anywhere" }, t.token),
        h("p", {}, "In the signage-player checkout (the file is git-ignored):"),
        h("pre", { class: "mono", style: "white-space:pre-wrap;overflow-wrap:anywhere" }, cmd),
        h("button", { type: "button", class: "small", onclick: () => navigator.clipboard.writeText(t.token).then(() => toast("Token copied")) }, "Copy token")));
      load();
    } catch (x) { toast(x.message); }
  };
  load().catch((x) => box.replaceChildren(h("p", { class: "bad small" }, x.message)));
  return h("div", { class: "panel" },
    h("h2", {}, "Upload tokens"),
    h("p", { class: "muted small" }, "For uploading packages from a script, such as ", h("span", { class: "mono" }, "dashboard/scripts/signage-upload"),
      ". A token can list, upload and activate packages, and nothing else."),
    h("form", { class: "row", onsubmit: create }, name, h("button", { type: "submit" }, "Create token")),
    shown, box);
}

// ------------------------------------------------------------ install images

async function viewImages() {
  const box = h("div", {}, h("p", { class: "muted" }, "Loading releases…"));
  const enc = new TextEncoder();
  let defaults = {}, saved = [];
  try {
    const [d, w] = await Promise.all([api("GET", "/api/stick-defaults"), api("GET", "/api/wifi")]);
    defaults = d.defaults || {};
    saved = w.networks;
  } catch (e) { toast(e.message); }
  const name = h("input", { placeholder: "blank = signage-<MAC>" });
  const tz = h("select", {}, TIMEZONES.map((z) => h("option", { value: z }, z)));
  tz.value = defaults.device?.timezone || "America/New_York";
  const mode = h("input", { placeholder: "monitor default, e.g. 1920x1080@60", value: defaults.display?.mode || "" });
  const rot = h("select", {}, [0, 90, 180, 270].map((r) => h("option", { value: r }, `${r}°`)));
  rot.value = String(defaults.display?.rotation ?? 0);
  const ntp = h("input", { placeholder: "optional, comma separated", value: (defaults.ntp?.servers || []).join(", ") });
  const countdown = h("input", { type: "number", min: 0, max: 600, value: defaults.countdown ?? 15 });
  const mok = h("input", { value: defaults.mok_password || "signage", title: "Typed once into the blue MokManager screen on the first boot after install" });
  const dashUrl = h("input", { placeholder: info.dashboard_url, value: defaults.dashboard_url || "",
    title: "Blank = this dashboard's address. Set it if you use a custom domain." });

  // Saved WiFi networks: passwords stay on the server and are only written into the stick's config.toml.
  const chosen = new Set(defaults.wifi || []);
  const wifiBox = h("div");
  const wifiMsg = h("div");
  const netForm = (net) => {
    const ssid = h("input", { name: "ssid", value: net?.ssid || "" });
    const psk = h("input", { name: "psk", type: "password", autocomplete: "new-password",
      placeholder: net ? (net.has_psk ? "unchanged" : "open network") : "blank = open network" });
    const open = h("input", { type: "checkbox" });
    const prio = h("input", { name: "priority", type: "number", value: net?.priority ?? 0 });
    const hidden = h("input", { type: "checkbox", checked: net?.hidden });
    const msg = h("div");
    const form = h("div", { class: "panel inset" },
      h("div", { class: "fields" },
        h("label", { class: "field" }, h("span", {}, "SSID"), ssid),
        h("label", { class: "field" }, h("span", {}, net ? "New password (blank keeps it)" : "Password (blank = open)"), psk),
        h("label", { class: "field" }, h("span", {}, "Priority (higher is tried first)"), prio)),
      h("div", { class: "row" },
        h("label", { class: "check" }, hidden, "Hidden network"),
        net?.has_psk ? h("label", { class: "check" }, open, "Remove the password (open network)") : "",
        h("button", { type: "button", class: "small primary", onclick: async () => {
          const body = { ssid: ssid.value, priority: Number(prio.value || 0), hidden: hidden.checked };
          if (psk.value) body.psk = psk.value;
          else if (!net || open.checked) body.psk = "";
          try {
            const r = net ? await api("PUT", `/api/wifi/${net.id}`, body) : await api("POST", "/api/wifi", body);
            saved = saved.filter((x) => x.id !== r.id).concat(r).sort((x, y) => y.priority - x.priority || x.ssid.localeCompare(y.ssid));
            chosen.add(r.id);
            drawWifi();
          } catch (e) { msg.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
        } }, net ? "Save changes" : "Save network"),
        h("button", { type: "button", class: "small ghost", onclick: drawWifi }, "Cancel")), msg);
    return form;
  };
  const drawWifi = () => {
    wifiMsg.replaceChildren();
    wifiBox.replaceChildren(
      saved.length ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, saved.map((n) => {
        const cb = h("input", { type: "checkbox", checked: chosen.has(n.id), onchange: () => cb.checked ? chosen.add(n.id) : chosen.delete(n.id) });
        const row = h("tr", {},
          h("td", {}, h("label", { class: "check" }, cb, h("span", { class: "mono" }, n.ssid))),
          h("td", { class: "muted small" }, n.has_psk ? "password saved" : "open", n.hidden ? " · hidden" : "", ` · priority ${n.priority}`),
          h("td", { style: "text-align:right; white-space:nowrap" },
            h("button", { type: "button", class: "small ghost", onclick: () => row.replaceWith(h("tr", {}, h("td", { colspan: 3 }, netForm(n)))) }, "Edit"),
            h("button", { type: "button", class: "small ghost danger", onclick: async () => {
              if (!confirm(`Delete the saved network "${n.ssid}"? Players already set up with it keep it.`)) return;
              try {
                await api("DELETE", `/api/wifi/${n.id}`);
                saved = saved.filter((x) => x.id !== n.id);
                chosen.delete(n.id);
                drawWifi();
              } catch (e) { toast(e.message); }
            } }, "Delete")));
        return row;
      })))) : h("p", { class: "muted small" }, "No saved networks. Players use Ethernet only."),
      h("button", { type: "button", class: "small", onclick: (e) => e.target.replaceWith(netForm(null)) }, "Add WiFi network"));
  };
  drawWifi();
  const savedNote = h("span", { class: "muted small" }, defaults.updated ? `Defaults saved ${new Date(defaults.updated * 1000).toLocaleString()}` : "");

  const stickBody = () => ({
    device: { timezone: tz.value, ...(name.value.trim() ? { name: name.value.trim() } : {}) },
    ntp: { servers: ntp.value.split(/[\s,]+/).filter(Boolean) },
    display: { rotation: Number(rot.value), ...(mode.value.trim() ? { mode: mode.value.trim() } : {}) },
    countdown: Number(countdown.value || 0),
    mok_password: mok.value || "signage",
    dashboard_url: dashUrl.value.trim(),
  });
  const wifiIds = () => saved.filter((n) => chosen.has(n.id)).map((n) => n.id);
  const saveDefaults = async () => {
    err.replaceChildren();
    try {
      const r = await api("PUT", "/api/stick-defaults", { ...stickBody(), wifi: wifiIds() });
      savedNote.textContent = `Defaults saved ${new Date(r.defaults.updated * 1000).toLocaleString()}`;
      toast("Saved as defaults");
    } catch (e) { err.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
  };
  const err = h("div");
  const progress = h("div", { class: "progress", hidden: true }, h("div"));
  const progressText = h("div", { class: "muted small" });

  const config = async () => {
    const body = { ...stickBody(), network: { wifi: wifiIds().map((id) => ({ saved: id })) } };
    return (await api("POST", "/api/stick-config", body)).config;
  };

  const downloadConfig = async () => {
    err.replaceChildren();
    try {
      const text = await config();
      const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: "config.toml" });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) { err.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
  };

  const downloadImage = async (tag, compressed) => {
    err.replaceChildren();
    let text, img;
    try {
      text = await config();
      img = await api("GET", `/api/releases/${encodeURIComponent(tag)}/image`);
    } catch (e) { return err.replaceChildren(h("div", { class: "bad" }, e.message), errorList(e)); }
    const readme = await fetch("/static/README-config.txt").then((r) => r.text()).catch(() => "Edit config.toml, then boot the stick.\n");
    const files = [{ name: "config.toml", data: enc.encode(text) }, { name: "README.txt", data: enc.encode(readme) }];
    const filename = img.filename.replace(/\.raw$/, "") + (name.value.trim() ? `-${name.value.trim()}` : "") + (compressed ? ".img.gz" : ".img");
    progress.hidden = false;
    const started = Date.now();
    try {
      let size = img.size;
      let stream;
      if (compressed) {
        progressText.textContent = "Building the config partition…";
        ({ size, stream } = await gzImageStream({ headUrl: img.gz_head_url, headSize: img.gz_head_size, tailUrl: img.gz_tail_url,
          tailSize: img.gz_tail_size, configOffset: img.config_offset, configSize: img.config_size, files }));
      } else {
        stream = imageStream({ url: img.url, size: img.size, configOffset: img.config_offset, configSize: img.config_size, files });
      }
      await saveStream(filename, size, stream,
        (done, total) => {
          progress.firstChild.style.width = `${(100 * done) / total}%`;
          const rate = done / Math.max(1, (Date.now() - started) / 1000);
          progressText.textContent = `${bytes(done)} of ${bytes(total)} · ${bytes(rate)}/s`;
        });
      progressText.textContent = compressed
        ? `Saved ${filename}. Flash it as is with balenaEtcher or Raspberry Pi Imager, or: gunzip -c ${filename} | sudo dd of=/dev/rdiskN bs=4m`
        : `Saved ${filename}. Flash it with balenaEtcher, Raspberry Pi Imager or dd.`;
    } catch (e) {
      progressText.textContent = "";
      if (e.name !== "AbortError") err.replaceChildren(h("div", { class: "bad" }, e.message));
    }
  };

  const loadReleases = async () => {
    let r;
    try { r = await api("GET", "/api/releases"); } catch (e) { box.replaceChildren(h("p", { class: "bad" }, e.message)); return; }
    if (!r.repo) {
      box.replaceChildren(h("p", { class: "warn" }, "No GitHub repository is configured. Redeploy with the GitHubRepo parameter to list releases."));
      return;
    }
    const busy = r.releases.some((x) => ["queued", "copying"].includes(x.mirror?.state));
    box.replaceChildren(r.releases.length ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Release"), h("th", {}, "Published"), h("th", {}, "Image"), h("th", {}, ""))),
      h("tbody", {}, r.releases.map((rel) => {
        const m = rel.mirror;
        let action;
        const recopy = (label) => h("button", { class: "small", onclick: async () => {
          try { await api("POST", `/api/releases/${encodeURIComponent(rel.tag)}/mirror`); loadReleases(); } catch (e) { toast(e.message); }
        } }, label);
        if (m?.state === "ready" && m.gz_head_key) {
          const gzSize = m.gz_head_size + m.gz_tail_size;
          action = h("div", { class: "row" },
            h("button", { class: "primary small", onclick: () => downloadImage(rel.tag, true) }, `Download .img.gz (~${bytes(gzSize)})`),
            h("button", { class: "small", onclick: () => downloadImage(rel.tag, false) }, `.img (${bytes(m.size)})`));
        } else if (m?.state === "ready") {
          action = h("div", { class: "row" },
            h("button", { class: "primary small", onclick: () => downloadImage(rel.tag, false) }, `Download .img (${bytes(m.size)})`),
            recopy("Copy again for a compressed download"));
        }
        else if (m?.state === "queued" || m?.state === "copying") action = h("span", { class: "muted small" }, `Copying from GitHub… ${m.copied ? bytes(m.copied) : ""}`);
        else if (rel.asset) action = h("span", {}, h("button", { class: "small", onclick: async () => {
          try { await api("POST", `/api/releases/${encodeURIComponent(rel.tag)}/mirror`); loadReleases(); } catch (e) { toast(e.message); }
        } }, "Copy to dashboard"), m?.state === "failed" ? h("div", { class: "bad small" }, m.error) : "");
        else action = h("span", { class: "muted small" }, "no install image in this release");
        return h("tr", {},
          h("td", { class: "mono" }, rel.tag, rel.prerelease ? h("span", { class: "chip", style: "margin-left:6px" }, "pre") : ""),
          h("td", {}, rel.published ? new Date(rel.published).toLocaleDateString() : ""),
          h("td", { class: "small" }, m?.size ? bytes(m.size) : rel.asset ? `${bytes(rel.asset.size)} compressed` : ""),
          h("td", {}, action));
      })))) : h("p", { class: "muted" }, `No releases in ${r.repo} yet. Push a v* tag to publish one.`));
    if (busy) setTimeout(() => location.hash === "#/images" && loadReleases(), 5000);
  };

  setView(
    h("h1", {}, "Install images"),
    h("p", { class: "muted" }, "Build a USB install stick that already knows this dashboard and your WiFi. The image streams from storage straight to your disk with config.toml written into its FAT32 partition, so nothing large is held in memory."),
    h("div", { class: "grid2" },
      h("div", { class: "panel" }, h("h2", {}, "1. Stick settings"),
        h("div", { class: "fields" },
          h("label", { class: "field" }, h("span", {}, "Device name (leave blank for a batch of players)"), name),
          h("label", { class: "field" }, h("span", {}, "Time zone"), tz),
          h("label", { class: "field" }, h("span", {}, "Resolution"), mode),
          h("label", { class: "field" }, h("span", {}, "Rotation"), rot),
          h("label", { class: "field" }, h("span", {}, "NTP servers"), ntp),
          h("label", { class: "field" }, h("span", {}, "Install countdown (seconds)"), countdown),
          h("label", { class: "field" }, h("span", {}, "Secure Boot enrollment password"), mok),
          h("label", { class: "field" }, h("span", {}, "Dashboard address"), dashUrl)),
        h("h3", {}, "WiFi (Ethernet with DHCP is always tried first)"),
        h("p", { class: "muted small" }, "Ticked networks go on the stick. Saved passwords stay on the dashboard and are never shown again."),
        wifiBox, wifiMsg,
        h("p", { class: "muted small" }, info.enroll_token_set ? "The enroll token is filled in from the dashboard's deployment." : "No enroll token is set; redeploy with EnrollToken so players can enroll."),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: saveDefaults }, "Save as defaults"),
          h("button", { type: "button", onclick: downloadConfig }, "Download config.toml only"), savedNote)),
      h("div", { class: "panel" }, h("h2", {}, "2. Pick a release"), box, err, progress, progressText)));
  loadReleases();
}

// ------------------------------------------------------------ router

async function router() {
  const hash = location.hash || "#/devices";
  const token = localStorage.getItem("token");
  document.getElementById("logout").hidden = !token;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", hash.startsWith(a.getAttribute("href"))));
  if (!token || hash === "#/login") return viewLogin();
  try {
    if (!info) info = await api("GET", "/api/info");
    const [, page, id] = hash.split("/");
    if (page === "devices" && id) await viewDevice(id);
    else if (page === "programs" && id) await viewProgram(id);
    else if (page === "programs") await viewPrograms();
    else if (page === "packages") await viewPackages();
    else if (page === "images") await viewImages();
    else await viewDevices();
  } catch (e) {
    if (e.message !== "log in again") setView(h("div", { class: "panel bad" }, e.message));
  }
}

document.getElementById("logout").addEventListener("click", () => {
  localStorage.removeItem("token");
  location.hash = "#/login";
});
window.addEventListener("hashchange", router);
router();
