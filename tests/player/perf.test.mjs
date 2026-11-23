// node --test tests/player/
import test from "node:test";
import assert from "node:assert/strict";
import { summarize, activeList } from "../../mkosi.extra/usr/share/signage/player/perf.mjs";

const run = (arr) => summarize(Float64Array.from(arr), arr.length, new Float64Array(arr.length));

test("summarize: steady 60 Hz", () => {
    const s = run(Array(300).fill(1000 / 60));
    assert.equal(s.frames, 300);
    assert.equal(s.window, 5);
    assert.equal(s.fps, 60);
    assert.deepEqual(s.frame_ms, { p50: 16.7, p95: 16.7, p99: 16.7, max: 16.7 });
    assert.equal(s.long_frames, 0);
});

test("summarize: percentiles and long frames", () => {
    // 95 frames of 10 ms, 4 of 60 ms, 1 of 200 ms.
    const s = run([...Array(95).fill(10), ...Array(4).fill(60), 200]);
    assert.equal(s.frames, 100);
    assert.equal(s.frame_ms.p50, 10);
    assert.equal(s.frame_ms.p95, 10);
    assert.equal(s.frame_ms.p99, 60);
    assert.equal(s.frame_ms.max, 200);
    assert.equal(s.long_frames, 5);
    assert.equal(s.window, 1.39);
});

test("summarize: no frames", () => {
    assert.deepEqual(run([]), { window: 0, frames: 0 });
});

test("activeList: clips, orders front layer first, drops empty labels", () => {
    const showing = new Map([
        ["a", { layer: 0, layer_name: "Back", package: "bg", version: "1.0.0", from: 90 }],
        ["b", { layer: 20, layer_name: "Front", package: "lt", version: "2.0.0", label: "Lower third", from: 104 }],
    ]);
    const ended = [
        { layer: 20, layer_name: "Front", package: "old", version: "1.0.0", label: "", from: 95, to: 103 },
        { layer: 10, layer_name: "Mid", package: "gone", version: "1.0.0", from: 80, to: 99 }, // before the window
        { layer: -1, layer_name: "status", package: "status-screen", from: 98, to: 101 },
    ];
    assert.deepEqual(activeList(showing, ended, 100), [
        { layer: 20, layer_name: "Front", package: "old", version: "1.0.0", from: 100, to: 103 },
        { layer: 20, layer_name: "Front", package: "lt", version: "2.0.0", label: "Lower third", from: 104, to: null },
        { layer: 0, layer_name: "Back", package: "bg", version: "1.0.0", from: 100, to: null },
        { layer: -1, layer_name: "status", package: "status-screen", from: 100, to: 101 },
    ]);
});

test("activeList: at most 32 entries", () => {
    const showing = new Map(Array.from({ length: 40 }, (_, i) => [i, { layer: i, layer_name: `L${i}`, package: "p", from: 0 }]));
    const out = activeList(showing, [], 0);
    assert.equal(out.length, 32);
    assert.equal(out[0].layer, 39);
});
