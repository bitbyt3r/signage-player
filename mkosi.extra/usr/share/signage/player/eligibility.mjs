// When a content.json item may play. Pure functions, no DOM: unit tests in
// tests/player/eligibility.test.mjs (node --test).
//
// All times are the sign's local time. An item is eligible when
//   - days is missing or empty, or contains today (0 = Monday ... 6 = Sunday);
//   - the time of day is within start-end: start defaults to 00:00, a missing
//     end means midnight, and an end before start wraps past midnight
//     (22:00-02:00). For a wrapping window, the part after midnight belongs
//     to the day it started: with days [4] (Friday), 22:00-02:00 plays from
//     Friday 22:00 to Saturday 02:00. start == end means the whole day;
//   - now is at or after from and before until (naive local
//     "YYYY-MM-DDTHH:MM", as new Date() parses it).
// A value that can't be parsed is ignored (and reported by problems()).

/** "HH:MM" (or "H:MM", "HH:MM:SS") to minutes after midnight, else null. */
export function parseTime(s) {
    if (typeof s !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
    if (!m) return null;
    const h = +m[1], min = +m[2], sec = +(m[3] || 0);
    if (h > 24 || min > 59 || sec > 59 || (h === 24 && (min || sec))) return null;
    return h * 60 + min + sec / 60;
}

/** Naive local date-time to a Date, else null. */
export function parseLocal(s) {
    if (typeof s !== "string" || !s.trim()) return null;
    // Date-only strings parse as UTC; make them local midnight.
    const v = /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? `${s.trim()}T00:00` : s.trim();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 0 = Monday ... 6 = Sunday. */
export const weekday = (d) => (d.getDay() + 6) % 7;

const hasDays = (item) => Array.isArray(item.days) && item.days.length > 0;

export function isEligible(item, now = new Date()) {
    if (!item) return false;
    const from = parseLocal(item.from), until = parseLocal(item.until);
    if (from && now < from) return false;
    if (until && now >= until) return false;

    const today = weekday(now);
    const yesterday = (today + 6) % 7;
    const dayOk = (d) => !hasDays(item) || item.days.includes(d);

    let start = parseTime(item.start), end = parseTime(item.end);
    if (start === null && end === null) return dayOk(today);
    if (start === null) start = 0;
    if (end === null) end = 24 * 60;
    const t = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

    if (start === end) return dayOk(today);
    if (start < end) return dayOk(today) && t >= start && t < end;
    // Wraps midnight: the evening part is today's, the morning part yesterday's.
    if (t >= start) return dayOk(today);
    if (t < end) return dayOk(yesterday);
    return false;
}

/** Human-readable problems with an item's schedule fields (for the log). */
export function problems(item) {
    const out = [];
    for (const k of ["start", "end"]) {
        if (item[k] != null && item[k] !== "" && parseTime(item[k]) === null) out.push(`${k} "${item[k]}" is not HH:MM`);
    }
    for (const k of ["from", "until"]) {
        if (item[k] != null && item[k] !== "" && parseLocal(item[k]) === null) out.push(`${k} "${item[k]}" is not a date and time`);
    }
    if (item.days != null && !(Array.isArray(item.days) && item.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
        out.push("days must be a list of 0 (Monday) to 6 (Sunday)");
    }
    return out;
}
