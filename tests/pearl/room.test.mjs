// node --test tests/pearl/
import test from "node:test";
import assert from "node:assert/strict";
import { decide, blocks, countdown, findRoom, normalize, pearlHasVideo } from "../../pearl/room.mjs";

const T = (hm) => Date.parse(`2027-01-08T${hm}:00-05:00`);
const S = (id, a, b) => ({ id, name: id, start: T(a), end: T(b), loc: ["1"] });
const day = [S("A", "10:00", "11:00"), S("B", "11:02", "12:00"), S("C", "13:00", "14:00")];
const at = (hm, signal = null, opts = {}, state = {}) => decide({ sessions: day, now: T(hm), signal, opts, state });

test("between panels shows the schedule and the next session", () => {
    const d = at("09:30");
    assert.equal(d.mode, "schedule");
    assert.equal(d.next.id, "A");
    assert.deepEqual(d.upcoming.map((s) => s.id), ["A", "B", "C"]);
});

test("during a panel: passthrough with video or unknown signal, logo without video", () => {
    assert.equal(at("10:30").mode, "passthrough");
    assert.equal(at("10:30", true).mode, "passthrough");
    assert.equal(at("10:30", false).mode, "logo");
});

test("a changeover shorter than mingap stays in panel mode", () => {
    assert.equal(at("11:01", false).mode, "logo");
    assert.equal(at("11:01", false, { mingap: 0 }).mode, "schedule");
});

test("pre and post margins", () => {
    assert.equal(at("12:58").mode, "schedule");
    assert.equal(at("12:58", null, { pre: 3 }).mode, "passthrough");
    assert.equal(at("14:01", null, { post: 2 }).mode, "passthrough");
});

test("a panel running over keeps its video until it stops or overrun ends", () => {
    assert.equal(at("12:05", true).mode, "passthrough");
    assert.equal(at("12:05", false).mode, "schedule");
    assert.equal(at("12:05", null).mode, "schedule");
    assert.equal(at("12:20", true).mode, "schedule");           // past 15 min overrun
    assert.equal(at("12:05", true, { overrun: 0 }).mode, "schedule");
});

test("early video between panels only with early=1", () => {
    assert.equal(at("09:00", true).mode, "schedule");
    assert.equal(at("09:00", true, { early: true }).mode, "passthrough");
});

test("after the last session", () => {
    const d = at("15:00");
    assert.equal(d.mode, "schedule");
    assert.equal(d.next, null);
});

test("blocks merge close sessions", () => {
    assert.equal(blocks(day, 5 * 60000).length, 2);
    assert.equal(blocks(day, 0).length, 3);
});

test("countdown", () => {
    assert.equal(countdown(65_000), "1:05");
    assert.equal(countdown(3_723_000), "1:02:03");
    assert.equal(countdown(25 * 3600_000), null);
    assert.equal(countdown(-1), null);
});

test("findRoom by id, full and short name", () => {
    const locs = { "5165752": "Panels 1 (Cherry Blossom Ballroom)", "5165757": "Panels 2 (Baltimore 3,4,5)" };
    assert.equal(findRoom("5165757", locs).short, "Panels 2");
    assert.equal(findRoom("panels 1", locs).id, "5165752");
    assert.equal(findRoom("Panels 1 (Cherry Blossom Ballroom)", locs).id, "5165752");
    assert.equal(findRoom("Panels 9", locs), null);
});

test("normalize skips all-day and fixes bad end times", () => {
    const d = normalize([
        { id: 1, name: "x", start_time: "2027-01-08T15:00:00Z", end_time: "2027-01-08T14:00:00Z", locations: ["1"] },
        { id: 2, name: "y", all_day: true, start_time: "2027-01-08T15:00:00Z", locations: ["1"] },
    ], [{ id: "1", name: "Panels 1" }]);
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessions[0].end - d.sessions[0].start, 30 * 60000);
});

test("pearlHasVideo reads the Pearl Mini's 0x0 no-signal report", () => {
    assert.equal(pearlHasVideo({ video: { state: "active", resolution: "0x0", actual_fps: 0 } }), false);
    assert.equal(pearlHasVideo({ video: { state: "active", resolution: "1920x1080", actual_fps: 60 } }), true);
    assert.equal(pearlHasVideo({ video: { state: "inactive" } }), false);
    assert.equal(pearlHasVideo({}), null);
});
