// Live view: the device's screen over WebRTC (hardware H.264 at 30 fps),
// with this browser's mouse and keyboard sent back to the sign.
//
// The terminal's WebSocket relay carries only the handshake: the device
// sends one offer (ICE candidates included), we send one answer. The video
// and the input data channel then go directly between the browser and the
// device (or through a TURN server, when the dashboard has one).

let h, api, toast;
export function initLive(deps) { ({ h, api, toast } = deps); }

const ROT = { normal: 0, 90: 90, 180: 180, 270: 270, "flipped": 0, "flipped-90": 90, "flipped-180": 180, "flipped-270": 270 };

// opts.outputs: the device's enabled output names. Returns a stop function.
export function openLive(deviceId, box, opts = {}) {
  if (box.firstChild) return null;
  const pref = (() => { try { return JSON.parse(localStorage.getItem("live-prefs") || "{}"); } catch { return {}; } })();
  const status = h("span", { class: "muted small" });
  const stats = h("span", { class: "muted small mono" });
  const quality = h("select", { title: "Encoded size. Native is the screen's own resolution." },
    h("option", { value: "native" }, "Native"), h("option", { value: "1080" }, "Up to 1080p"), h("option", { value: "720" }, "Up to 720p"));
  quality.value = pref.quality || "native";
  const outputs = opts.outputs || [];
  const output = h("select", { title: "Which screen to show" }, outputs.map((o) => h("option", { value: o }, o)));
  const control = h("input", { type: "checkbox", checked: pref.control !== false });
  const video = h("video", { autoplay: true, muted: true, playsinline: true, disablepictureinpicture: true });
  const screen = h("div", { class: "live-screen", tabindex: "0" }, video);
  const stage = h("div", { class: "live-stage" }, screen);
  const panel = h("div", { class: "panel" },
    h("div", { class: "row spread" },
      h("div", { class: "row" }, h("h2", { style: "margin:0" }, "Live view"), status),
      h("div", { class: "row" },
        quality,
        outputs.length > 1 ? output : "",
        h("label", { class: "row small", title: "Send this browser's mouse and keyboard to the sign while the video has focus" }, control, "Control"),
        h("button", { class: "small", title: "Turn the picture if it comes out sideways", onclick: () => { rotExtra = (rotExtra + 90) % 360; layout(); } }, "Rotate"),
        h("button", { class: "small", onclick: () => stage.requestFullscreen?.() }, "Full screen"),
        h("button", { class: "small", onclick: () => restart() }, "Reconnect"),
        h("button", { class: "small", onclick: () => stop() }, "Close"))),
    stage,
    h("div", { class: "row spread", style: "margin-top:6px" }, stats,
      h("span", { class: "muted small" }, "Click the picture to type into the sign. Firefox there gets every key except the browser's own shortcuts here.")));
  box.replaceChildren(panel);

  let ws = null, pc = null, dc = null, info = null, rotExtra = 0, statTimer = null, closed = false, offerTimer = null;
  let ended = false;

  // ---- layout: `screen` is the upright picture's box; the video inside is
  // turned to match the output's transform (wlroots renders rotated outputs
  // into the scanout buffer we capture, so the frames arrive sideways).
  const rotation = () => ((info ? ROT[info.transform] ?? 0 : 0) + rotExtra) % 360;
  const flipped = () => String(info?.transform || "").startsWith("flipped");
  function layout() {
    const vw = video.videoWidth || info?.width || 16, vh = video.videoHeight || info?.height || 9;
    const r = rotation(), side = r === 90 || r === 270;
    const lw = side ? vh : vw, lh = side ? vw : vh;
    const maxW = stage.clientWidth, maxH = document.fullscreenElement === stage ? stage.clientHeight : Math.max(240, window.innerHeight * 0.75);
    const s = Math.min(maxW / lw, maxH / lh);
    const sw = Math.floor(lw * s), sh = Math.floor(lh * s);
    screen.style.width = sw + "px";
    screen.style.height = sh + "px";
    video.style.width = (side ? sh : sw) + "px";
    video.style.height = (side ? sw : sh) + "px";
    video.style.transform = `translate(-50%, -50%) rotate(${r}deg)${flipped() ? " scaleX(-1)" : ""}`;
  }
  const ro = new ResizeObserver(layout);
  ro.observe(stage);
  video.addEventListener("resize", layout);
  document.addEventListener("fullscreenchange", layout);

  // ---- input
  const send = (m) => { if (dc?.readyState === "open" && control.checked && info?.control) dc.send(JSON.stringify(m)); };
  const pos = (e) => {
    const r = screen.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  let moveQueued = null;
  screen.addEventListener("pointermove", (e) => {
    if (!moveQueued) requestAnimationFrame(() => { send({ t: "m", ...moveQueued }); moveQueued = null; });
    moveQueued = pos(e);
  });
  screen.addEventListener("pointerdown", (e) => {
    screen.focus();
    if (!control.checked) return;
    e.preventDefault();
    screen.setPointerCapture(e.pointerId);
    send({ t: "m", ...pos(e) });
    send({ t: "b", b: e.button, d: 1 });
  });
  screen.addEventListener("pointerup", (e) => { send({ t: "m", ...pos(e) }); send({ t: "b", b: e.button, d: 0 }); });
  screen.addEventListener("contextmenu", (e) => control.checked && e.preventDefault());
  screen.addEventListener("wheel", (e) => {
    if (!control.checked) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    send({ t: "w", dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });
  const key = (d) => (e) => {
    if (!control.checked) return;
    e.preventDefault();
    if (!e.repeat) send({ t: "k", c: e.code, d });
  };
  screen.addEventListener("keydown", key(1));
  screen.addEventListener("keyup", key(0));
  screen.addEventListener("blur", () => send({ t: "release" }));
  control.addEventListener("change", () => { if (!control.checked) dc?.readyState === "open" && dc.send('{"t":"release"}'); savePrefs(); });
  quality.addEventListener("change", () => { savePrefs(); restart(); });
  output.addEventListener("change", () => restart());
  function savePrefs() {
    try { localStorage.setItem("live-prefs", JSON.stringify({ quality: quality.value, control: control.checked })); } catch { /* private mode */ }
  }

  // ---- connection
  async function start() {
    ended = false;
    info = null;
    status.textContent = "Asking the device to start…";
    stats.textContent = "";
    let s;
    try {
      s = await api("POST", `/api/devices/${deviceId}/stream`, {
        quality: quality.value, output: outputs.length > 1 ? output.value : "", control: control.checked });
    } catch (e) { status.textContent = e.message; return; }
    if (closed) return;
    const sock = ws = new WebSocket(`${s.ws_url}?session=${s.session}&role=admin&token=${encodeURIComponent(s.token)}`);
    const wsend = (o) => sock.readyState === 1 && sock.send(JSON.stringify(o));
    sock.onopen = () => wsend({ t: "hello" });
    const ping = setInterval(() => wsend({ t: "ping" }), 60000);
    sock.onclose = () => { clearInterval(ping); if (sock === ws && !ended && pc?.connectionState !== "connected") status.textContent = "Disconnected"; };
    offerTimer = setTimeout(() => { if (!pc) status.textContent = "The device hasn't answered. Is it online, and on an OS version with live view?"; }, 45000);
    sock.onmessage = async (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "ready") status.textContent = "Device connected, starting the capture…";
      else if (m.t === "waiting") status.textContent = "Waiting for the device…";
      else if (m.t === "info") { info = m; layout(); }
      else if (m.t === "warning") toast(m.message);
      else if (m.t === "error") { ended = true; status.textContent = `Couldn't start: ${m.message}`; }
      else if (m.t === "ended") { ended = true; status.textContent = `Ended: ${m.reason}`; }
      else if (m.t === "closed") { if (!ended) status.textContent = "The device closed the session"; }
      else if (m.t === "offer") {
        clearTimeout(offerTimer);
        status.textContent = "Connecting to the device…";
        try { wsend({ t: "answer", sdp: await answer(m.sdp, s.ice_servers) }); }
        catch (err) { status.textContent = `WebRTC failed: ${err.message}`; }
      }
    };
  }

  async function answer(sdp, iceServers) {
    pc?.close();
    const peer = pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    peer.ontrack = (e) => {
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    peer.ondatachannel = (e) => { dc = e.channel; };
    peer.onconnectionstatechange = () => {
      const st = peer.connectionState;
      if (st === "connected") { status.textContent = "Live"; statTimer = statTimer || setInterval(showStats, 1000); }
      else if (st === "failed") status.textContent = "No network path to the device. A TURN server fixes this (see the dashboard README).";
      else if (st === "disconnected") status.textContent = "Connection interrupted…";
    };
    await peer.setRemoteDescription({ type: "offer", sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    // Non-trickle: wait for our candidates (or 4 s) and send them in one go.
    await new Promise((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      peer.addEventListener("icegatheringstatechange", () => peer.iceGatheringState === "complete" && resolve());
      setTimeout(resolve, 4000);
    });
    return peer.localDescription.sdp;
  }

  let last = null;
  async function showStats() {
    if (!pc) return;
    const r = await pc.getStats();
    let inb = null, pair = null;
    const byId = new Map();
    r.forEach((x) => {
      byId.set(x.id, x);
      if (x.type === "inbound-rtp" && x.kind === "video") inb = x;
      if (x.type === "transport" && x.selectedCandidatePairId) pair = x.selectedCandidatePairId;
    });
    if (!pair) r.forEach((x) => { if (x.type === "candidate-pair" && x.nominated && x.state === "succeeded") pair = x.id; });
    if (!inb) return;
    const cp = byId.get(pair), remote = cp && byId.get(cp.remoteCandidateId);
    const parts = [];
    if (video.videoWidth) parts.push(`${video.videoWidth}×${video.videoHeight}`);
    if (info) parts.push(info.encoder === "h264_vaapi" ? "GPU H.264" : `${info.encoder} (software)`);
    if (last) {
      const dt = (inb.timestamp - last.timestamp) / 1000;
      parts.push(`${Math.round((inb.framesDecoded - last.framesDecoded) / dt)} fps`);
      parts.push(`${((inb.bytesReceived - last.bytesReceived) * 8 / dt / 1e6).toFixed(1)} Mb/s`);
    }
    if (remote) parts.push(remote.candidateType === "relay" ? "via TURN" : remote.candidateType === "host" ? "direct (LAN)" : "direct");
    if (cp?.currentRoundTripTime) parts.push(`${Math.round(cp.currentRoundTripTime * 1000)} ms`);
    if (info && !info.control) parts.push("view only");
    stats.textContent = parts.join(" · ");
    last = inb;
  }

  function teardown() {
    clearTimeout(offerTimer);
    clearInterval(statTimer);
    statTimer = null;
    last = null;
    try { dc?.readyState === "open" && dc.send('{"t":"release"}'); } catch { /* closing anyway */ }
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "stop" }));
    ws?.close();
    pc?.close();
    ws = pc = dc = null;
    video.srcObject = null;
  }
  function restart() { teardown(); start(); }
  function stop() {
    if (closed) return;
    closed = true;
    teardown();
    ro.disconnect();
    document.removeEventListener("fullscreenchange", layout);
    box.replaceChildren();
  }
  start();
  return stop;
}
