// node --test tests/player/  (runs in the player's local time zone; the
// cases build local dates, so they hold in any zone)
import test from "node:test";
import assert from "node:assert/strict";
import { isEligible, parseTime, parseLocal, weekday, problems } from "../../mkosi.extra/usr/share/signage/player/eligibility.mjs";

// 2027-01-04 is a Monday.
const at = (day, hh, mm = 0, ss = 0) => new Date(2027, 0, 4 + day, hh, mm, ss);
const MON = 0, TUE = 1, FRI = 4, SAT = 5, SUN = 6;

test("weekday is 0 = Monday", () => {
    assert.equal(weekday(at(MON, 12)), 0);
    assert.equal(weekday(at(SUN, 12)), 6);
});

test("no constraints: always", () => {
    assert.ok(isEligible({}, at(MON, 0)));
    assert.ok(isEligible({ days: [], start: "", end: null }, at(SAT, 23, 59)));
});

test("days", () => {
    const it = { days: [FRI, SAT] };
    assert.ok(isEligible(it, at(FRI, 9)));
    assert.ok(isEligible(it, at(SAT, 23, 59)));
    assert.ok(!isEligible(it, at(SUN, 0, 0)));
    assert.ok(!isEligible(it, at(MON, 12)));
});

test("start-end window, end exclusive", () => {
    const it = { start: "10:00", end: "22:00" };
    assert.ok(!isEligible(it, at(MON, 9, 59, 59)));
    assert.ok(isEligible(it, at(MON, 10, 0)));
    assert.ok(isEligible(it, at(MON, 21, 59, 59)));
    assert.ok(!isEligible(it, at(MON, 22, 0)));
});

test("missing end means until midnight, missing start from midnight", () => {
    assert.ok(isEligible({ start: "18:00" }, at(MON, 23, 59, 59)));
    assert.ok(!isEligible({ start: "18:00" }, at(TUE, 0, 0)));
    assert.ok(isEligible({ end: "06:00" }, at(MON, 0, 0)));
    assert.ok(!isEligible({ end: "06:00" }, at(MON, 6, 0)));
});

test("end before start wraps past midnight", () => {
    const it = { start: "22:00", end: "02:00" };
    assert.ok(isEligible(it, at(MON, 22, 0)));
    assert.ok(isEligible(it, at(MON, 23, 59)));
    assert.ok(isEligible(it, at(TUE, 0, 0)));
    assert.ok(isEligible(it, at(TUE, 1, 59)));
    assert.ok(!isEligible(it, at(TUE, 2, 0)));
    assert.ok(!isEligible(it, at(TUE, 12, 0)));
    assert.ok(!isEligible(it, at(TUE, 21, 59)));
});

test("a wrapped window's morning part belongs to the day it started", () => {
    const it = { days: [FRI], start: "22:00", end: "02:00" };
    assert.ok(!isEligible(it, at(FRI, 1, 0)), "Friday 01:00 is Thursday night's window");
    assert.ok(isEligible(it, at(FRI, 23, 0)));
    assert.ok(isEligible(it, at(SAT, 1, 30)), "Saturday 01:30 is still Friday night");
    assert.ok(!isEligible(it, at(SAT, 23, 0)));
    // Sunday night into Monday morning, across the week boundary.
    const sun = { days: [SUN], start: "20:00", end: "03:00" };
    assert.ok(isEligible(sun, at(MON + 7, 2, 0)));
    assert.ok(!isEligible(sun, at(MON, 20, 30)));
});

test("start == end is the whole day", () => {
    assert.ok(isEligible({ start: "08:00", end: "08:00" }, at(MON, 3)));
});

test("from/until are naive local times; until is exclusive", () => {
    const it = { from: "2027-01-08T00:00", until: "2027-01-11T18:00" };
    assert.ok(!isEligible(it, at(FRI - 1, 23, 59, 59)));
    assert.ok(isEligible(it, at(FRI, 0, 0)));
    assert.ok(isEligible(it, new Date(2027, 0, 11, 17, 59)));
    assert.ok(!isEligible(it, new Date(2027, 0, 11, 18, 0)));
    // Date-only means local midnight, not UTC.
    assert.equal(parseLocal("2027-01-08").getTime(), new Date(2027, 0, 8).getTime());
});

test("everything combined", () => {
    const it = { days: [SAT], start: "10:00", end: "12:00", from: "2027-01-09T00:00", until: "2027-01-10T00:00" };
    assert.ok(isEligible(it, at(SAT, 11)));
    assert.ok(!isEligible(it, at(SAT + 7, 11)), "outside from/until a week later");
    assert.ok(!isEligible(it, at(SAT, 13)));
});

test("unparseable values are ignored and reported", () => {
    assert.equal(parseTime("25:00"), null);
    assert.equal(parseTime("10am"), null);
    assert.equal(parseTime("24:00"), 1440);
    assert.ok(isEligible({ start: "nonsense", end: "12:00" }, at(MON, 11)));
    assert.deepEqual(problems({ start: "x", from: "soon", days: [7] }).length, 3);
    assert.deepEqual(problems({ start: "10:00", days: [0, 6] }), []);
});
