// Live preview for the program editor: the real player (/static/player/, the
// same files that run on the signs) plays the unsaved program in an iframe.
// The service worker (sw.js) stands in for signage-web on a device, answering
// the player's /content.json, /packages/... and /status/... requests for this
// preview only. Every edit posts the draft to /api/preview, which resolves it
// exactly as a device check-in would, and hands the result to the worker; the
// player picks it up on its next 2-second poll.

let h, api;
export function initPreview(deps) { ({ h, api } = deps); }

// Frame sizes: the arch plays as its canvas (?view=canvas: one copy, the door
// hatched, scaled to fit), as people see it, not as the controller's output.
const SIZES = { screen: [1920, 1080], arch: [2760, 2565] };
const VIEW = { arch: "&view=canvas" };
const REFRESH_MS = 20000;   // picks up newly activated package versions, renews zip links
const DEBOUNCE_MS = 450;

let regPromise = null;
function worker() {
  if (!("serviceWorker" in navigator)) return Promise.reject(new Error("this browser has no service workers, so it can't preview"));
  regPromise ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
  return regPromise.then((reg) => reg.active);
}

function post(sw, msg) {
  return new Promise((resolve, reject) => {
    const chan = new MessageChannel();
    const t = setTimeout(() => reject(new Error("the preview worker didn't answer")), 5000);
    chan.port1.onmessage = () => { clearTimeout(t); resolve(); };
    sw.postMessage(msg, [chan.port2]);
  });
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// getDraft() returns the editor's program as it stands, or null while it can't
// be read (a JSON box mid-edit). Returns {el, changed(), stop()}.
export function previewPanel(getDraft) {
  const sid = `p${Math.random().toString(36).slice(2, 10)}`;
  const frame = h("iframe", { class: "preview-frame", title: "Program preview", allow: "autoplay; fullscreen", tabindex: "-1" });
  const stage = h("div", { class: "preview-stage" }, frame);
  const status = h("div", { class: "muted small preview-status" }, "Starting…");
  const err = h("div", { class: "small" });
  const asSel = h("select", { "aria-label": "Show the preview as" },
    h("option", { value: "screen" }, "Screen, 1920×1080"),
    h("option", { value: "arch" }, "LED arch"));
  const pop = h("a", { class: "button small ghost", target: "_blank", rel: "noopener", title: "Open the preview in its own window; it keeps following your edits" }, "Pop out");
  const reload = h("button", { type: "button", class: "small ghost", title: "Restart the player" }, "Restart");
  const open = store.get("signage.preview.open") !== "0";
  const el = h("details", { class: "panel preview", open },
    h("summary", {}, h("strong", {}, "Live preview"), h("span", { class: "muted small" }, " unsaved changes play here as you type")),
    h("div", { class: "row preview-tools" }, asSel, reload, pop),
    stage, status, err);

  let layout = null, size = null, src = "", timer = null, refresh = null, seq = 0, stopped = false, started = false;

  api("GET", "/api/devices").then((r) => {
    const devs = r.devices || [];
    if (!devs.length) return;
    asSel.append(h("optgroup", { label: "As a device (its room and other parameters)" },
      devs.map((d) => h("option", { value: `device:${d.id}` }, d.name || d.id))));
    const want = store.get("signage.preview.as");
    if (want && [...asSel.options].some((o) => o.value === want)) { asSel.value = want; if (started) update(); }
  }).catch(() => {});

  function fit() {
    const [w, hgt] = size || SIZES[layout || "screen"];
    stage.style.aspectRatio = `${w} / ${hgt}`;
    frame.style.width = `${w}px`;
    frame.style.height = `${hgt}px`;
    frame.style.transform = `scale(${stage.clientWidth / w})`;
  }
  const ro = new ResizeObserver(fit);
  ro.observe(stage);

  async function update() {
    if (stopped || !el.open) return;
    const draft = getDraft();
    if (!draft) { status.textContent = "Waiting for valid graphic data…"; return; }
    const n = ++seq;
    const body = { program: draft };
    if (asSel.value.startsWith("device:")) body.device_id = asSel.value.slice(7);
    else body.layout = asSel.value;
    try {
      const [r, sw] = await Promise.all([api("POST", "/api/preview", body), worker()]);
      if (n !== seq || stopped) return;
      await post(sw, { type: "preview", id: sid, content: r.content, layout: r.layout, outputs: r.outputs });
      // A device spanning several monitors: the page is their combined size.
      const spanSize = r.outputs?.length ? [Math.max(...r.outputs.map((o) => o.x + o.width)), Math.max(...r.outputs.map((o) => o.y + o.height))] : null;
      err.replaceChildren();
      const spanKey = r.outputs ? r.outputs.map((o) => `${o.name}:${o.width}x${o.height}`).join(",") : "";
      if (r.layout !== layout || String(spanSize) !== String(size)) {
        layout = r.layout;
        size = spanSize;
        fit();
      }
      // The player reads the outputs once at start, so a new span restarts it.
      const url = `/static/player/index.html?preview=${sid}&layout=${layout}${VIEW[layout] || ""}${spanKey ? `&span=${encodeURIComponent(spanKey)}` : ""}`;
      if (url !== src) { src = url; frame.src = url; pop.href = url; }
      const items = r.content.layers.reduce((a, l) => a + l.items.length, 0);
      status.textContent = `${r.device ? `As ${r.device.name}, ` : ""}${layout === "arch" ? "LED arch, as seen" : size ? `${r.outputs.length} monitors, ${size[0]}×${size[1]}` : "1920×1080"} · `
        + `${items ? `${items} graphic${items === 1 ? "" : "s"}` : "no graphics yet"} · updated ${new Date().toLocaleTimeString()}`;
      started = true;
    } catch (e) {
      if (n !== seq) return;
      status.textContent = "The preview couldn't update.";
      const list = e.errors || [];
      err.replaceChildren(h("div", { class: "bad" }, e.message), list.length ? h("ul", { class: "errors" }, list.map((x) => h("li", {}, x))) : "");
    }
  }

  function changed() {
    clearTimeout(timer);
    timer = setTimeout(update, DEBOUNCE_MS);
  }

  asSel.addEventListener("change", () => { store.set("signage.preview.as", asSel.value); update(); });
  reload.addEventListener("click", () => { if (src) frame.src = src; });
  el.addEventListener("toggle", () => {
    store.set("signage.preview.open", el.open ? "1" : "0");
    if (el.open) { update(); fit(); } else { frame.removeAttribute("src"); src = ""; }
  });
  const onVisible = () => document.visibilityState === "visible" && update(); // back from the Packages tab
  document.addEventListener("visibilitychange", onVisible);
  refresh = setInterval(() => document.visibilityState === "visible" && update(), REFRESH_MS);
  setTimeout(() => { fit(); update(); });

  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearInterval(refresh);
    document.removeEventListener("visibilitychange", onVisible);
    ro.disconnect();
    frame.removeAttribute("src");
    worker().then((sw) => sw.postMessage({ type: "preview-end", id: sid })).catch(() => {});
  }
  return { el, changed, stop };
}
