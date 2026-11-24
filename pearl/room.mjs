// Mode logic for the Pearl panel-room page. No DOM here, so it runs under
// node for tests (tests/pearl/room.test.mjs).
//
// Three modes:
//   "schedule"     between panels: the room's schedule and a countdown
//   "logo"         a panel is on but nothing is plugged in (only when the
//                  page knows the signal state, see `signal` below)
//   "passthrough"  a panel is on: the page goes transparent so the HDMI input
//                  under it in the Pearl layout shows through

export const DEFAULTS = {
    pre: 0,        // minutes before a session starts to leave the schedule
    post: 0,       // minutes after a session ends to stay in panel mode
    mingap: 5,     // gaps between sessions shorter than this stay in panel mode
    overrun: 15,   // with video still coming in, minutes a panel may run over
    early: false,  // show video that arrives between panels instead of the schedule
};

// "Panels 1 (Cherry Blossom Ballroom)" -> "Panels 1"
export function shortName(name) {
    const s = String(name || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
    return s || String(name || "");
}

// Find a room by location ID, full name, or name without the bracketed part.
export function findRoom(wanted, locations) {
    const w = String(wanted || "").trim();
    if (!w) return null;
    const q = w.toLowerCase();
    const entries = Object.entries(locations || {});
    const hit = (locations?.[w] != null && [w, locations[w]])
        || entries.find(([, n]) => n.toLowerCase() === q)
        || entries.find(([, n]) => shortName(n).toLowerCase() === q);
    return hit ? { id: hit[0], name: hit[1], short: shortName(hit[1]) } : null;
}

// MAGSched /sessions + /locations -> {sessions: [{id,name,start,end,loc}], locations: {id: name}}
export function normalize(sessions, locations) {
    const loc = {};
    for (const l of locations || []) if (l && l.id != null) loc[String(l.id)] = String(l.name ?? l.id);
    const out = [];
    for (const s of sessions || []) {
        const start = Date.parse(s?.start_time);
        if (!Number.isFinite(start) || s.all_day) continue;
        let end = Date.parse(s.end_time);
        if (!Number.isFinite(end) || end <= start) end = start + 30 * 60000;
        out.push({ id: String(s.id), name: String(s.name ?? "").trim(), start, end, loc: (s.locations || []).map(String) });
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return { sessions: out, locations: loc };
}

export function roomSessions(data, roomId) {
    return (data?.sessions || []).filter((s) => s.loc.includes(String(roomId)));
}

// Merge sessions that overlap or sit closer than `gapMs` into blocks, so a
// two-minute changeover doesn't flash the schedule up.
export function blocks(sessions, gapMs) {
    const out = [];
    for (const s of sessions) {
        const last = out[out.length - 1];
        if (last && s.start - last.end < gapMs) { last.end = Math.max(last.end, s.end); last.sessions.push(s); }
        else out.push({ start: s.start, end: s.end, sessions: [s] });
    }
    return out;
}

// signal: true (video coming in), false (no video), null (unknown: no bridge,
// or the bridge isn't answering). With null the page can't show the logo
// itself; during panels it goes transparent and the Pearl's own "no signal"
// image on the HDMI input stands in.
//
// overrunUntil: carried between calls. When a panel ends with video still
// coming in, we keep passing it through until the video stops, the next
// session starts, or `overrun` minutes pass.
export function decide({ sessions, now, signal = null, opts = {}, state = {} }) {
    const o = { ...DEFAULTS, ...opts };
    const min = 60000;
    const bl = blocks(sessions, o.mingap * min);
    const current = bl.find((b) => b.start - o.pre * min <= now && now < b.end + o.post * min) || null;
    const nextBlock = bl.find((b) => b.start > now) || null;
    const onNow = sessions.find((s) => s.start <= now && now < s.end) || null;
    const next = sessions.find((s) => s.start > now) || null;
    const upcoming = sessions.filter((s) => s.start > now);
    const prev = [...bl].reverse().find((b) => b.end + o.post * min <= now) || null;
    const st = { overrunUntil: state.overrunUntil || 0 };

    let mode, reason;
    if (current) {
        st.overrunUntil = 0;
        if (signal === false) { mode = "logo"; reason = "panel on, no video"; }
        else { mode = "passthrough"; reason = signal ? "panel on, video in" : "panel on (signal unknown)"; }
    } else if (signal === true && o.early) {
        mode = "passthrough"; reason = "video in between panels (early=1)";
    } else if (signal === true && prev && o.overrun > 0
               && (st.overrunUntil ? now < st.overrunUntil : now < prev.end + (o.post + o.overrun) * min)
               && !(nextBlock && now >= nextBlock.start - o.pre * min)) {
        // Keep the deadline fixed from the first time we see the overrun.
        st.overrunUntil = st.overrunUntil || prev.end + (o.post + o.overrun) * min;
        mode = "passthrough"; reason = "panel running over, video still in";
    } else {
        st.overrunUntil = signal === true ? st.overrunUntil : 0;
        mode = "schedule"; reason = next ? "between panels" : "nothing more scheduled";
    }
    return { mode, reason, current, onNow, next, upcoming, state: st };
}

// "12:34" under an hour, "1:02:03" under a day; null otherwise.
export function countdown(ms) {
    if (!(ms >= 0)) return null;
    const t = Math.ceil(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h >= 24) return null;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// Pearl /api/v2.0/inputs/{id}/status -> true/false. With nothing plugged in,
// Pearl Mini firmware 4.24 still reports state "active" but at 0x0 and 0 fps.
export function pearlHasVideo(status) {
    const v = status?.video;
    if (!v) return null;
    if (v.state && v.state !== "active") return false;
    const [w, h] = String(v.resolution || "0x0").split("x").map(Number);
    return w > 0 && h > 0;
}
