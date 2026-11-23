// Forms for OGraf graphic parameters, built from the manifest's JSON schema.
//
// schemaForm(schema, value)            the whole object, for a program item
// overrideForm(schema, value, base)    only the parameters set for one device
//
// A string or string-array parameter whose schema has
//   "x-signage-options": {"source": "schedule", "list": "locations", "baseParam": "apiBase"}
// gets a searchable picker filled from that list (fetched through /api/options),
// which still takes free text. Arrays are multi-select; a string takes one value.

let h, api;
export function initParams(deps) { ({ h, api } = deps); }

const optionCache = new Map();

function loadOptions(spec, values) {
  const base = (spec.baseParam && values()?.[spec.baseParam]) || spec.base || "";
  const q = new URLSearchParams({ source: spec.source || "", list: spec.list || "" });
  if (base) q.set("base", base);
  const key = q.toString();
  if (!optionCache.has(key)) {
    const p = api("GET", `/api/options?${key}`).then((r) => r.options);
    p.catch(() => optionCache.delete(key));
    optionCache.set(key, p);
  }
  return optionCache.get(key);
}

// ---------------------------------------------------------------- picker

export function picker({ values = [], multiple = true, options = null, placeholder = "" }) {
  let chosen = [...values];
  let opts = Array.isArray(options) ? options : null;
  let status = "";
  let active = -1;
  const chips = h("span", { class: "chips" });
  const input = h("input", { class: "pick-input", placeholder, autocomplete: "off" });
  const list = h("div", { class: "pick-list", hidden: true });
  const box = h("div", { class: "picker" + (multiple ? " multi" : "") }, chips, input, list);
  const changed = () => box.dispatchEvent(new Event("change", { bubbles: true }));

  const drawChips = () => {
    chips.replaceChildren(...chosen.map((v, i) => h("span", { class: "chip pick-chip", title: v }, v,
      h("button", { type: "button", class: "chip-x", title: `Remove ${v}`, onclick: (e) => {
        e.stopPropagation();
        chosen.splice(i, 1);
        drawChips();
        changed();
      } }, "×"))));
    input.placeholder = !multiple && chosen.length ? "" : placeholder;
  };
  const add = (v) => {
    v = String(v).trim();
    if (!v) return;
    if (!multiple) chosen = [v];
    else if (!chosen.includes(v)) chosen.push(v);
    input.value = "";
    drawChips();
    changed();
    if (!multiple) close();
    else drawList();
  };
  const matches = () => {
    const q = input.value.trim().toLowerCase();
    return (opts || []).filter((o) => !chosen.includes(o.value) &&
      (!q || o.value.toLowerCase().includes(q) || (o.id && o.id.toLowerCase() === q))).slice(0, 200);
  };
  const drawList = () => {
    const m = matches();
    const q = input.value.trim();
    active = Math.min(active, m.length - 1);
    const rows = m.map((o, i) => h("div", { class: "pick-opt" + (i === active ? " active" : ""),
      onmousedown: (e) => { e.preventDefault(); add(o.value); } },
      h("span", {}, o.value), o.id && o.id !== o.value ? h("span", { class: "muted small" }, ` ${o.id}`) : ""));
    if (q && !m.some((o) => o.value.toLowerCase() === q.toLowerCase())) {
      rows.push(h("div", { class: "pick-opt free" + (active === -1 ? " active" : ""), onmousedown: (e) => { e.preventDefault(); add(q); } },
        `Use "${q}"`));
    }
    if (status) rows.unshift(h("div", { class: "pick-status muted small" }, status));
    list.replaceChildren(...rows);
    list.hidden = !rows.length || document.activeElement !== input;
  };
  const close = () => { list.hidden = true; active = -1; };

  box.addEventListener("click", () => input.focus());
  input.addEventListener("focus", async () => {
    drawList();
    if (!opts && box.load) {
      status = "Loading…";
      drawList();
      try { opts = await box.load(); status = opts.length ? "" : "No suggestions; type a value."; }
      catch (e) { opts = []; status = `Suggestions unavailable (${e.message}); type a value.`; }
      drawList();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim() && !multiple) add(input.value);
    close();
  });
  input.addEventListener("input", () => { active = -1; drawList(); });
  input.addEventListener("keydown", (e) => {
    const m = matches();
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, m.length - 1); drawList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, -1); drawList(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && m[active]) add(m[active].value);
      else if (input.value.trim()) add(input.value);
    } else if (e.key === "," && multiple && !(opts || []).length) { e.preventDefault(); add(input.value); }
    else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); drawChips(); changed(); }
    else if (e.key === "Escape") close();
  });
  drawChips();
  box.getValue = () => (multiple ? [...chosen] : chosen[0] ?? "");
  return box;
}

// ---------------------------------------------------------------- fields

// Properties in the manifest's order (the dashboard stores schemas as sorted
// JSON, so the package version carries the original order separately).
export function withOrder(schema, order) {
  if (!schema?.properties || !order?.length) return schema;
  const props = {};
  for (const k of order) if (k in schema.properties) props[k] = schema.properties[k];
  for (const k of Object.keys(schema.properties)) if (!(k in props)) props[k] = schema.properties[k];
  return { ...schema, properties: props };
}

const optionsSpec = (s) => s?.["x-signage-options"] || s?.items?.["x-signage-options"] || null;

function isStringArray(s) { return s.type === "array" && (!s.items || s.items.type === "string" || s.items.enum); }

// Returns an element with getValue(). values() gives the current whole object
// (for options that depend on another parameter, like the schedule server).
function fieldInput(key, s, value, values) {
  const spec = optionsSpec(s);
  if (s.type === "boolean") {
    const el = h("input", { type: "checkbox", checked: !!value });
    el.getValue = () => el.checked;
    return el;
  }
  if (s.enum && s.type !== "array") {
    const el = h("select", {}, ...s.enum.map((v) => h("option", { value: JSON.stringify(v) }, String(v))));
    el.value = JSON.stringify(value ?? s.default ?? s.enum[0]);
    el.getValue = () => JSON.parse(el.value);
    return el;
  }
  if (s.type === "integer" || s.type === "number") {
    const el = h("input", { type: "number", value: value ?? "", min: s.minimum, max: s.maximum, step: s.type === "integer" ? 1 : "any" });
    el.getValue = () => (el.value === "" ? undefined : Number(el.value));
    return el;
  }
  if (isStringArray(s) || (s.type === "string" && spec)) {
    const multiple = s.type === "array";
    const el = picker({ values: multiple ? (Array.isArray(value) ? value.map(String) : []) : (value ? [String(value)] : []), multiple,
      options: s.items?.enum ? s.items.enum.map((v) => ({ value: String(v) })) : null,
      placeholder: spec ? `Search ${spec.list || "options"} or type…` : "Type and press Enter" });
    if (spec) el.load = () => loadOptions(spec, values);
    return el;
  }
  if (s.type === "string") {
    const color = s.format === "color" || s.gddType === "color-rrggbb";
    const long = s.gddType === "multi-line" || s.format === "textarea" || (s.maxLength || 0) > 200;
    const el = long ? h("textarea", { style: "min-height:60px" }) : h("input", { value: value ?? "" });
    if (long) el.value = value ?? "";
    el.getValue = () => el.value;
    if (!color) return el;
    const hex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");
    const swatch = h("input", { type: "color", value: hex(value) ? value : "#000000", title: "Pick a colour",
      oninput: (e) => { el.value = e.target.value; swatch.classList.remove("unset"); } });
    const sync = () => { if (hex(el.value)) swatch.value = el.value; swatch.classList.toggle("unset", !hex(el.value)); };
    el.addEventListener("input", sync);
    sync();
    el.placeholder = "#rrggbb, empty = default";
    const wrap = h("span", { class: "row color-field" }, swatch, el);
    wrap.getValue = el.getValue;
    return wrap;
  }
  if (s.type === "object" && s.properties) {
    const sub = schemaForm(s, value || {});
    return sub;
  }
  // Anything else: JSON.
  const el = h("textarea", { class: "mono", style: "min-height:50px" });
  el.value = value === undefined ? "" : JSON.stringify(value, null, 2);
  el.getValue = () => {
    if (!el.value.trim()) return undefined;
    try { return JSON.parse(el.value); } catch { throw new Error(`${s.title || key}: not valid JSON`); }
  };
  return el;
}

function fieldRow(key, s, input, extra) {
  const wide = input.classList?.contains("picker") || input.tagName === "TEXTAREA" || (s.type === "object");
  return h("div", { class: "param" + (wide ? " wide" : ""), "data-key": key },
    h("label", { class: "field" },
      h("span", {}, s.title || key, extra || ""),
      input,
      s.description ? h("small", { class: "muted" }, s.description) : ""));
}

// The whole parameter object. Keys the schema doesn't know are kept as they are.
export function schemaForm(schema, value = {}) {
  const props = schema?.properties || {};
  const inputs = {};
  const values = () => get();
  const box = h("div", { class: "params" });
  for (const [k, s] of Object.entries(props)) {
    inputs[k] = fieldInput(k, s, value[k] !== undefined ? value[k] : s.default, values);
    box.append(fieldRow(k, s, inputs[k]));
  }
  const get = () => {
    const out = { ...value };
    for (const [k, el] of Object.entries(inputs)) {
      const v = el.getValue();
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  };
  box.getValue = get;
  return box;
}

const show = (v) => (v === undefined || v === "" || (Array.isArray(v) && !v.length) ? "(empty)" : Array.isArray(v) ? v.join(", ") : String(v));

// Only the parameters set for one device; base is what the program gives.
export function overrideForm(schema, value = {}, base = {}) {
  const props = schema?.properties || {};
  const inputs = {};
  const rows = h("div", { class: "params" });
  const merged = () => ({ ...base, ...get() });
  const add = (k, v) => {
    const s = props[k] || {};
    inputs[k] = fieldInput(k, s, v, merged);
    const row = fieldRow(k, s, inputs[k], h("span", { class: "muted" }, ` · program: ${show(base[k] ?? s.default)}`));
    row.append(h("button", { type: "button", class: "small ghost danger", onclick: () => { delete inputs[k]; row.remove(); fillPick(); } }, "Use the program's value"));
    rows.append(row);
    fillPick();
  };
  const pick = h("select", { onchange: () => {
    const k = pick.value;
    pick.value = "";
    if (k) add(k, base[k] ?? props[k]?.default);
  } });
  const fillPick = () => {
    const left = Object.keys(props).filter((k) => !(k in inputs));
    pick.replaceChildren(h("option", { value: "" }, left.length ? "Set a parameter for this device…" : "All parameters are set"),
      ...left.map((k) => h("option", { value: k }, props[k].title || k)));
    pick.disabled = !left.length;
  };
  for (const [k, v] of Object.entries(value)) add(k, v);
  fillPick();
  const get = () => {
    const out = {};
    for (const [k, el] of Object.entries(inputs)) {
      const v = el.getValue();
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const box = h("div", {}, rows, pick);
  box.getValue = get;
  return box;
}
