// node --test dashboard/tests/pearls_copy_test.mjs
// planCopy: which Pearl API calls copy settings from one snapshot to another.
import test from "node:test";
import assert from "node:assert/strict";
import { planCopy } from "../src/static/pearls.js";

const layout = (src) => ({ video: [{ type: "source", settings: { source: src } }], audio: [], background: "#000000" });
const snap = (over = {}) => ({
  inputs: [{ id: "hdmi-a", type: "embedded" }, { id: "WEBG1", type: "web-graphics" }],
  input_settings: {
    "hdmi-a": { video: { nosignal: { image: "logo.png", timeout: 1 } } },
    WEBG1: { video: { nosignal: { image: "", timeout: 5 } }, web_graphics: { url: "http://x/?room=Panels%201", resolution: "1920x1080", fps: 30 } },
  },
  channels: [{ id: "1", name: "Projector" }, { id: "3", name: "Channel 3" }],
  layouts: { 1: [{ id: "1", name: "Default", active: false }, { id: "2", name: "Room", active: true }], 3: [{ id: "1", name: "Default", active: true }] },
  layout_settings: { 1: { 1: layout("D2P0.hdmi-a"), 2: layout("WEBG1") }, 3: { 1: layout("D2P0.hdmi-a") } },
  outputs: [{ id: "D1" }], output_settings: { D1: { source: "1", audio: true } },
  publishers: { 1: [], 3: [] }, publisher_settings: { 1: {}, 3: {} },
  ...over,
});

test("identical Pearls need nothing", () => {
  assert.deepEqual(planCopy(snap(), snap(), ["inputs", "layouts", "active", "outputs", "names", "streams"], "b").ops, []);
});

test("copies input settings but keeps the target's Graphics URL", () => {
  const dst = snap();
  dst.input_settings = structuredClone(dst.input_settings);
  dst.input_settings["hdmi-a"].video.nosignal.image = "";
  dst.input_settings.WEBG1.web_graphics.url = "http://x/?room=Panels%202";
  dst.input_settings.WEBG1.video.nosignal.timeout = 9;
  const { ops } = planCopy(snap(), dst, ["inputs"], "b");
  assert.deepEqual(ops.map((o) => o.path), ["/api/v2.0/inputs/hdmi-a/settings", "/api/v2.0/inputs/WEBG1/settings"]);
  assert.equal(ops[1].body.web_graphics.url, "http://x/?room=Panels%202");
  assert.equal(ops[1].body.video.nosignal.timeout, 5);
  // With graphics ticked too, the URL comes across.
  const both = planCopy(snap(), dst, ["inputs", "graphics"], "b").ops;
  assert.equal(both[1].body.web_graphics.url, "http://x/?room=Panels%201");
});

test("layouts, active layout, names and outputs; missing ones are skipped", () => {
  const dst = snap({
    channels: [{ id: "1", name: "HDMI-A" }],
    layouts: { 1: [{ id: "1", name: "Default", active: true }] },
    layout_settings: { 1: { 1: layout("D2P0.hdmi-b") } },
    output_settings: { D1: { source: "2", audio: true } },
  });
  const { ops, skipped } = planCopy(snap(), dst, ["layouts", "active", "names", "outputs"], "b");
  assert.deepEqual(ops.map((o) => `${o.method} ${o.path}`), [
    "PUT /api/v2.0/channels/1/name", "PUT /api/v2.0/channels/1/layouts/1/settings", "PUT /api/v2.0/outputs/D1/settings"]);
  assert.deepEqual(ops[0].query, { name: "Projector" });
  assert.deepEqual(skipped, ["channel 1 layout 2", "channel 3"]);
  assert.ok(ops.every((o) => o.pearl === "b"));
});
