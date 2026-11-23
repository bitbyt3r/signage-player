// MAGFest schedule: an OGraf graphic (real-time, one step) for signage.
//
// With rooms set: what's on now in each room (with a progress bar), what's up
// next, and an abbreviated list of what's later in those rooms.
// With no rooms: the schedule by itself, paging through what's on now and
// coming up.
//
// Data comes from MAGSched (schedule.magfest.net) and is cached in
// localStorage, so the sign keeps showing the schedule through network loss.
// Interface: https://ograf.ebu.io/v1/specification/docs/Specification.html

import { getStore, resolveRooms, resolveTracks, abbreviate, shortName, asList, DEFAULT_API } from "./schedule-data.mjs";

const DEFAULTS = {
    rooms: [],
    tracks: [],
    excludeTracks: [],
    abbreviate: 0,
    title: "",
    lookaheadHours: 3,
    maxDuration: 180,
    pageSeconds: 12,
    showDescription: true,
    clock24: false,
    timeZone: "",
    accent: "#e4405f",
    background: "#0e1218",
    apiBase: DEFAULT_API,
    refreshSeconds: 120,
};

// Tracks that are ratings or noise levels rather than topics: not shown as chips.
const HIDDEN_CHIPS = /^(noise level|all ages|schedule track|alcohol|animated blood|blood and gore|mature|nudity|sexual|violence)/i;
const ROOMS_PER_PAGE = 4;
const EASE = "cubic-bezier(.2,.8,.2,1)";

const STYLE = `
:host { position: absolute; inset: 0; pointer-events: none; container-type: size;
        --accent: #e4405f; --bg: #0e1218; --fg: #f4f6f8; --muted: #9aa9b6; --line: rgba(255,255,255,.12);
        --panel: rgba(255,255,255,.05); font-family: "Noto Sans", "DejaVu Sans", sans-serif; color: var(--fg); }
* { box-sizing: border-box; }
.frame { position: absolute; inset: 0; background: var(--bg); display: flex; flex-direction: column;
         padding: 3.2cqmin 3.6cqmin; gap: 2.4cqmin; visibility: hidden; overflow: hidden; }
.bar { display: flex; align-items: flex-end; justify-content: space-between; gap: 3cqmin;
       border-bottom: .5cqmin solid var(--accent); padding-bottom: 1.4cqmin; }
.title { font-size: 5.6cqmin; font-weight: 800; line-height: 1.05; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { font-size: 2.2cqmin; color: var(--muted); margin-top: .5cqmin; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { text-align: right; flex: none; }
.clock { font-size: 5cqmin; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.status { font-size: 1.8cqmin; color: var(--muted); margin-top: .6cqmin; min-height: 1em; }
.status.warn { color: #ffb74d; }
.body { flex: 1; min-height: 0; position: relative; }
.empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
         font-size: 4cqmin; color: var(--muted); }

/* ---- room mode */
.rooms-mode { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 3cqmin; height: 100%; }
.rooms-col { display: flex; flex-direction: column; gap: 1.4cqmin; min-height: 0; min-width: 0; }
.rooms { flex: 1; display: flex; flex-direction: column; gap: 2cqmin; min-height: 0; }
.side { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-radius: 1.2cqmin; padding: 2cqmin 2.4cqmin; }
.side h2, .label { margin: 0; font-size: 2.1cqmin; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
.side h2 { margin-bottom: 1.2cqmin; }
.side .list { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.side .list .row { flex: none; }
.card { background: var(--panel); border-radius: 1.2cqmin; padding: 2.4cqmin 2.8cqmin; display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
.card .room { font-size: 3cqmin; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .room small { font-size: .62em; font-weight: 400; color: var(--muted); margin-left: .5em; }
.label .dot { display: inline-block; width: 1.4cqmin; height: 1.4cqmin; border-radius: 50%; background: var(--accent);
              margin-right: .8cqmin; vertical-align: .05em; animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.label .when { color: var(--fg); letter-spacing: .04em; margin-left: .6em; text-transform: none; font-weight: 400; }
.now-name { font-size: 6.4cqmin; font-weight: 800; line-height: 1.08; margin: 1cqmin 0 .8cqmin;
            display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.times { font-size: 2.6cqmin; color: var(--muted); font-variant-numeric: tabular-nums; }
.chips { display: flex; flex-wrap: wrap; gap: .8cqmin; margin-top: 1.2cqmin; }
.chip { font-size: 1.8cqmin; padding: .35cqmin 1.1cqmin; border-radius: 99px; border: .2cqmin solid var(--line); color: var(--muted); }
.desc { font-size: 2.3cqmin; line-height: 1.4; color: #cfd8df; margin-top: 1.6cqmin;
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.progress { margin-top: auto; padding-top: 2cqmin; }
.track { height: 1.3cqmin; border-radius: 99px; background: rgba(255,255,255,.12); overflow: hidden; }
.fill { height: 100%; width: 0; background: var(--accent); border-radius: 99px; transition: width 1s linear; }
.progress .times { display: flex; justify-content: space-between; margin-top: .9cqmin; font-size: 2.2cqmin; }
.left { color: var(--fg); font-weight: 700; }
.next { border-top: .2cqmin solid var(--line); margin-top: 2.4cqmin; padding-top: 2cqmin; }
.next-name { font-size: 3.8cqmin; font-weight: 700; line-height: 1.15; margin: .6cqmin 0 .4cqmin;
             display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.idle { font-size: 4.4cqmin; color: var(--muted); margin: 1.4cqmin 0; font-weight: 700; }
/* compact cards, for several rooms */
.card.compact { padding: 1.6cqmin 2.2cqmin; }
.card.compact .row1 { display: flex; align-items: baseline; gap: 1.6cqmin; }
.card.compact .room { flex: none; max-width: 40%; font-size: 2.6cqmin; }
.card.compact .now-name { font-size: 3.4cqmin; -webkit-line-clamp: 1; margin: .5cqmin 0 0; }
.rooms.few .card.compact .now-name { font-size: 4.4cqmin; -webkit-line-clamp: 2; }
.rooms.few .card.compact .room { font-size: 3.2cqmin; }
.rooms.few .card.compact .next { font-size: 2.6cqmin; }
.rooms.few .card.compact .track { height: 1.2cqmin; }
.rooms.few .card.compact { justify-content: center; gap: 1.4cqmin; }
.rooms.few .card.compact .next { margin-top: 0; padding-top: 1.4cqmin; }
.card.compact .idle { font-size: 3cqmin; margin: .5cqmin 0 0; }
.card.compact .progress { padding-top: 1cqmin; margin-top: 0; }
.card.compact .track { height: .9cqmin; }
.card.compact .progress .times { font-size: 1.8cqmin; margin-top: .5cqmin; }
.card.compact .next { margin-top: auto; padding-top: 1cqmin; font-size: 2.2cqmin; color: var(--muted);
                      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card.compact .next b { color: var(--fg); font-weight: 600; }
.pager { display: flex; gap: 1cqmin; justify-content: center; min-height: 1.2cqmin; }
.pager i { width: 1.2cqmin; height: 1.2cqmin; border-radius: 50%; background: var(--line); }
.pager i.on { background: var(--accent); }

/* ---- list rows (side list and schedule mode) */
.row { display: grid; grid-template-columns: 14cqmin minmax(0, 1fr); gap: 1.6cqmin; align-items: center;
       border-bottom: .15cqmin solid var(--line); padding: .9cqmin 0; min-height: 0; overflow: hidden; }
.row .t { font-size: 2.4cqmin; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.row .t small { display: block; font-size: .72em; font-weight: 400; color: var(--muted); }
.row .t.live { color: var(--accent); letter-spacing: .1em; }
.row .n { font-size: 2.6cqmin; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .r { font-size: 1.9cqmin; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: .2cqmin; }
.row .track { height: .6cqmin; margin-top: .6cqmin; }

/* ---- schedule mode */
.sched { height: 100%; display: flex; flex-direction: column; gap: 1.4cqmin; }
.sched .list { flex: 1; min-height: 0; display: grid; grid-auto-flow: column; column-gap: 4cqmin;
               grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr));
               grid-template-rows: repeat(var(--rows, 8), var(--row-h)); align-content: start; }
.sched .row { height: var(--row-h); }

/* portrait */
@container (aspect-ratio < 1) {
    .rooms-mode { grid-template-columns: 1fr; grid-template-rows: 1.5fr 1fr; }
    .now-name { font-size: 7cqmin; }
    .row { grid-template-columns: 17cqmin minmax(0, 1fr); }
    .card.compact .room { max-width: 30%; }
}
`;

function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style") el.style.cssText = v;
        else if (k.startsWith("data-")) el.setAttribute(k, v);
        else el[k] = v;
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
}

export default class MagfestSchedule extends HTMLElement {
    constructor() {
        super();
        this.data = { ...DEFAULTS };
        this.visible = false;
        this.queue = Promise.resolve();
        this.swaps = new WeakMap();
        this.page = 0;
        this.pageAt = 0;
        this.key = "";
        this.sideKey = "";
    }

    // Action calls may arrive while an earlier one is still animating; run
    // them in order rather than overlapping animations.
    enqueue(fn) {
        const next = this.queue.then(fn, fn);
        this.queue = next.catch(() => {});
        return next;
    }

    // ------------------------------------------------------------ settings

    setData(data) {
        const d = { ...this.data, ...(data || {}) };
        for (const k of ["rooms", "tracks", "excludeTracks"]) d[k] = asList(d[k]);
        for (const k of ["abbreviate", "lookaheadHours", "maxDuration", "pageSeconds", "refreshSeconds"]) {
            const n = Number(d[k]);
            d[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
        }
        d.pageSeconds = Math.max(3, d.pageSeconds || DEFAULTS.pageSeconds);
        const resubscribe = !this.store || d.apiBase !== this.data.apiBase || d.refreshSeconds !== this.data.refreshSeconds;
        this.data = d;
        this.style.setProperty("--accent", d.accent || DEFAULTS.accent);
        this.style.setProperty("--bg", d.background || DEFAULTS.background);
        try {
            this.fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: !d.clock24, timeZone: d.timeZone || undefined });
            this.fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: d.timeZone || undefined });
            this.fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: d.timeZone || undefined });
            this.fmtKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: d.timeZone || undefined });
        } catch {
            // Unknown time zone: fall back to the device's.
            this.data.timeZone = "";
            return this.setData({});
        }
        if (resubscribe) {
            this.unsub?.();
            this.store = getStore(d.apiBase);
            this.unsub = this.store.subscribe(() => this.refreshView(), d.refreshSeconds);
        }
    }

    // ------------------------------------------------------------ formatting

    time(ms) { return this.fmtTime.format(ms); }
    dayKey(ms) { return this.fmtKey.format(ms); }
    // Start time, with the weekday when it isn't today.
    when(ms, now) {
        return this.dayKey(ms) === this.dayKey(now) ? this.time(ms) : `${this.fmtDay.format(ms)} ${this.time(ms)}`;
    }
    range(s, now) { return `${this.when(s.start, now)} – ${this.dayKey(s.end) === this.dayKey(s.start) ? this.time(s.end) : this.when(s.end, now)}`; }
    static dur(ms) {
        const m = Math.max(0, Math.ceil(ms / 60000));
        if (m < 60) return `${m} min`;
        const hrs = Math.floor(m / 60), rem = m % 60;
        return rem ? `${hrs} h ${rem} min` : `${hrs} h`;
    }
    left(s, now) { return now >= s.end ? "ending" : `${MagfestSchedule.dur(s.end - now)} left`; }
    until(s, now) { return s.start - now < 60000 ? "starting now" : `in ${MagfestSchedule.dur(s.start - now)}`; }
    name(s) { return abbreviate(s.name, this.data.abbreviate); }

    // ------------------------------------------------------------ model

    model(now) {
        const d = this.data, store = this.store, sd = store.data;
        const m = { now, warnings: [] };
        if (!sd) { m.state = "nodata"; return m; }
        const rooms = resolveRooms(d.rooms, sd), want = resolveTracks(d.tracks, sd), skip = resolveTracks(d.excludeTracks, sd);
        for (const x of rooms.missing) m.warnings.push(`unknown room "${x}"`);
        for (const x of [...want.missing, ...skip.missing]) m.warnings.push(`unknown track "${x}"`);
        const wantIds = new Set(want.found.map((t) => t.id)), skipIds = new Set(skip.found.map((t) => t.id));
        const trackOk = (s) => (!d.tracks.length || s.tr.some((t) => wantIds.has(t))) && !s.tr.some((t) => skipIds.has(t));
        const horizon = now + d.lookaheadHours * 3600000;
        m.locations = sd.locations;
        m.trackNames = sd.tracks;

        if (d.rooms.length) {
            m.state = "rooms";
            m.rooms = rooms.found.map((r) => {
                const ss = sd.sessions.filter((s) => s.loc.includes(r.id) && trackOk(s));
                // Overlaps happen (an all-day free play under a panel): show the one that started last.
                const live = ss.filter((s) => s.start <= now && s.end > now);
                const current = live.length ? live.reduce((a, b) => (b.start >= a.start ? b : a)) : null;
                const next = ss.find((s) => s.start > now && s !== current) || null;
                return { ...r, current, next };
            });
            const shown = new Set(m.rooms.flatMap((r) => [r.current?.id, r.next?.id]));
            const ids = new Set(m.rooms.map((r) => r.id));
            // The side list shows as much of the next day as fits.
            m.later = sd.sessions.filter((s) => s.start > now && s.start < now + 86400000 && !shown.has(s.id)
                && s.loc.some((l) => ids.has(l)) && trackOk(s));
            m.key = JSON.stringify(m.rooms.map((r) => [r.id, r.current?.id, r.next?.id, r.current?.end, r.next?.start, r.current?.name, r.next?.name]));
            m.sideKey = JSON.stringify(m.later.map((s) => [s.id, s.start, s.name]));
        } else {
            m.state = "schedule";
            const maxMs = d.maxDuration * 60000;
            const live = sd.sessions.filter((s) => s.start <= now && s.end > now && trackOk(s) && (!maxMs || s.end - s.start <= maxMs));
            const soon = sd.sessions.filter((s) => s.start > now && s.start < horizon && trackOk(s));
            m.rows = [...live, ...soon];
            m.key = JSON.stringify(m.rows.map((s) => [s.id, s.start, s.end, s.name, s.start <= now]));
        }
        return m;
    }

    // ------------------------------------------------------------ rendering

    roomLabel(r) { return r.short; }
    roomOf(s, m) { return shortName(m.locations[s.loc[0]] || ""); }
    chips(s, m) {
        return s.tr.map((t) => m.trackNames[t]).filter((n) => n && !HIDDEN_CHIPS.test(n)).slice(0, 3)
            .map((n) => h("span", { class: "chip" }, n));
    }
    progress(s, now, compact) {
        return h("div", { class: "progress" },
            h("div", { class: "track" }, h("div", { class: "fill", "data-start": s.start, "data-end": s.end })),
            h("div", { class: "times" },
                h("span", {}, compact ? `until ${this.time(s.end)}` : this.range(s, now)),
                h("span", { class: "left", "data-left": s.end }, this.left(s, now))));
    }

    heroCard(r, now, m) {
        const { current: c, next: n } = r;
        const full = r.name !== r.short ? r.name.slice(r.short.length).trim().replace(/^\(|\)$/g, "") : "";
        return h("div", { class: "card hero" },
            this.data.rooms.length > 1 || m.rooms.length > 1 ? h("div", { class: "room" }, r.short, full && h("small", {}, full)) : null,
            c ? [
                h("div", { class: "label" }, h("span", { class: "dot" }), "Now"),
                h("div", { class: "now-name" }, c.name),
                h("div", { class: "chips" }, this.chips(c, m)),
                this.data.showDescription && c.desc ? h("div", { class: "desc" }, c.desc) : null,
                this.progress(c, now, false),
            ] : h("div", { class: "idle" }, n ? "Nothing on right now" : "No more sessions scheduled"),
            n ? h("div", { class: "next" },
                h("div", { class: "label" }, "Up next", h("span", { class: "when", "data-until": n.start }, this.until(n, now))),
                h("div", { class: "next-name" }, n.name),
                h("div", { class: "times" }, this.range(n, now))) : null);
    }

    compactCard(r, now) {
        const { current: c, next: n } = r;
        return h("div", { class: "card compact" },
            h("div", { class: "row1" },
                h("div", { class: "room" }, r.short),
                c ? h("div", { class: "now-name" }, c.name) : h("div", { class: "idle" }, n ? "Nothing on now" : "Done for today")),
            c ? this.progress(c, now, true) : null,
            n ? h("div", { class: "next" }, "Next ", h("span", { "data-until": n.start }, this.until(n, now)), ": ", h("b", {}, n.name)) : null);
    }

    row(s, now, m, withRoom) {
        const live = s.start <= now;
        return h("div", { class: "row" },
            live ? h("div", { class: "t live" }, "NOW") : h("div", { class: "t" },
                this.dayKey(s.start) === this.dayKey(now) ? this.time(s.start) : [this.time(s.start), h("small", {}, this.fmtDay.format(s.start))]),
            h("div", {},
                h("div", { class: "n" }, this.name(s)),
                withRoom || live ? h("div", { class: "r" },
                    [withRoom ? this.roomOf(s, m) : null, live ? `until ${this.time(s.end)}` : null].filter(Boolean).join(" · ")) : null,
                live ? h("div", { class: "track" }, h("div", { class: "fill", "data-start": s.start, "data-end": s.end })) : null));
    }

    // Swap a region's content, fading it when the graphic is on screen.
    swap(el, build) {
        const prev = this.swaps.get(el) || Promise.resolve();
        const p = prev.then(async () => {
            if (this.visible && el.isConnected && el.childElementCount) {
                await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: "forwards" }).finished;
                el.replaceChildren(...[build()].flat().filter(Boolean));
                this.updateLive(Date.now());
                await el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, fill: "forwards", easing: EASE }).finished;
            } else {
                el.replaceChildren(...[build()].flat().filter(Boolean));
                this.updateLive(Date.now());
            }
        }).catch((e) => console.error("[magsched]", e));
        this.swaps.set(el, p);
        return p;
    }

    renderHeader(m) {
        const d = this.data;
        let title = d.title, sub = this.fmtDate.format(m.now);
        if (m.state === "rooms" && !title) {
            const r = m.rooms || [];
            title = r.length === 1 ? r[0].short : "Now and next";
            if (r.length === 1 && r[0].name !== r[0].short) sub = `${r[0].name.slice(r[0].short.length).trim().replace(/^\(|\)$/g, "")} · ${sub}`;
        }
        this.els.title.textContent = title || "Schedule";
        this.els.subtitle.textContent = sub;
        this.renderStatus(m);
    }

    renderStatus(m) {
        const st = this.store, s = this.els.status;
        const stale = st.error && st.data;
        const parts = [];
        if (stale) parts.push(st.fetchedAt ? `Offline · schedule as of ${this.when(st.fetchedAt, Date.now())}` : "Offline");
        if (m?.warnings?.length) parts.push(m.warnings.join(", "));
        s.textContent = parts.join(" · ");
        s.classList.toggle("warn", parts.length > 0);
    }

    // Full rebuild of the body for a mode change; otherwise per-region swaps.
    render(force) {
        const now = Date.now(), m = this.model(now);
        this.renderHeader(m);
        const mode = m.state;
        if (force || mode !== this.mode) {
            this.mode = mode;
            this.key = this.sideKey = "";
            this.page = 0;
            this.pageAt = now;
            let body;
            if (mode === "nodata") {
                body = h("div", { class: "empty" }, this.store.error ? `Waiting for the schedule (${this.store.error})` : "Loading the schedule…");
                this.els.regions = {};
            } else if (mode === "rooms") {
                const rooms = h("div", { class: "rooms" }), list = h("div", { class: "list" }), pager = h("div", { class: "pager" });
                body = h("div", { class: "rooms-mode" }, h("div", { class: "rooms-col" }, rooms, pager),
                    h("div", { class: "side" }, h("h2", {}, "Later"), list));
                this.els.regions = { rooms, list, pager };
            } else {
                const list = h("div", { class: "list" }), pager = h("div", { class: "pager" });
                body = h("div", { class: "sched" }, list, pager);
                this.els.regions = { list, pager };
            }
            this.els.body.replaceChildren(body);
        }
        if (mode === "rooms") this.renderRooms(m, now);
        else if (mode === "schedule") this.renderSchedule(m, now);
    }

    pageCount(n, per) { return Math.max(1, Math.ceil(n / per)); }
    advancePage(pages, now) {
        if (pages <= 1) { this.page = 0; return false; }
        if (now - this.pageAt >= this.data.pageSeconds * 1000) {
            this.page = (this.page + 1) % pages;
            this.pageAt = now;
            return true;
        }
        if (this.page >= pages) this.page = 0;
        return false;
    }
    renderPager(pages) {
        const p = this.els.regions.pager;
        p.replaceChildren(...(pages > 1 ? Array.from({ length: pages }, (_, i) => h("i", { class: i === this.page ? "on" : "" })) : []));
    }

    renderRooms(m, now) {
        const R = this.els.regions;
        const pages = m.rooms.length > ROOMS_PER_PAGE ? this.pageCount(m.rooms.length, ROOMS_PER_PAGE) : 1;
        const flipped = this.advancePage(pages, now);
        const key = `${this.page}|${m.key}`;
        if (key !== this.key) {
            this.key = key;
            const slice = m.rooms.slice(this.page * ROOMS_PER_PAGE, (this.page + 1) * ROOMS_PER_PAGE);
            const build = () => !m.rooms.length ? h("div", { class: "empty" }, "No matching rooms")
                : slice.length === 1 ? this.heroCard(slice[0], now, m) : slice.map((r) => this.compactCard(r, now));
            R.rooms.classList.toggle("few", slice.length <= 2);
            this.swap(R.rooms, build);
            this.renderPager(pages);
        }
        if (m.sideKey !== this.sideKey || flipped) {
            this.sideKey = m.sideKey;
            const multi = m.rooms.length > 1;
            this.swap(R.list, () => {
                if (!m.later.length) return h("div", { class: "row" }, h("div", { class: "t" }), h("div", { class: "n", style: "color:var(--muted)" }, "Nothing else scheduled"));
                // Only as many rows as fit; the list does not page.
                return m.later.slice(0, 40).map((s) => this.row(s, now, m, multi));
            }).then(() => this.trimToFit(R.list));
        }
    }

    trimToFit(list) {
        const max = list.getBoundingClientRect().bottom;
        for (const r of [...list.children].reverse()) {
            if (list.childElementCount > 1 && r.getBoundingClientRect().bottom > max + 1) r.remove();
        }
    }

    layoutSchedule() {
        const list = this.els.regions.list;
        const box = list.getBoundingClientRect();
        const host = this.getBoundingClientRect();
        const unit = Math.min(host.width, host.height) / 100 || 8;
        const rowH = Math.max(24, unit * 8.2);
        const cols = box.width / unit > 150 ? 2 : 1;
        const rows = Math.max(1, Math.floor((box.height + 0.5) / rowH));
        list.style.setProperty("--row-h", `${rowH}px`);
        list.style.setProperty("--cols", cols);
        list.style.setProperty("--rows", rows);
        return rows * cols;
    }

    renderSchedule(m, now) {
        const R = this.els.regions;
        const per = this.layoutSchedule();
        const pages = this.pageCount(m.rows.length, per);
        this.advancePage(pages, now);
        const key = `${this.page}|${per}|${m.key}`;
        if (key === this.key) return;
        this.key = key;
        this.swap(R.list, () => m.rows.length
            ? m.rows.slice(this.page * per, (this.page + 1) * per).map((s) => this.row(s, now, m, true))
            : h("div", { class: "empty" }, "Nothing scheduled right now"));
        this.renderPager(pages);
    }

    // Every second: the clock, progress bars and countdowns, in place.
    updateLive(now) {
        const root = this.shadowRoot;
        if (!root) return;
        this.els.clock.textContent = this.time(now);
        for (const f of root.querySelectorAll(".fill[data-start]")) {
            const s = Number(f.dataset.start), e = Number(f.dataset.end);
            f.style.width = `${Math.min(100, Math.max(0, ((now - s) / (e - s)) * 100)).toFixed(2)}%`;
        }
        for (const el of root.querySelectorAll("[data-left]")) el.textContent = this.left({ end: Number(el.dataset.left) }, now);
        for (const el of root.querySelectorAll("[data-until]")) el.textContent = this.until({ start: Number(el.dataset.until) }, now);
    }

    tick() {
        const now = Date.now();
        this.updateLive(now);
        if (now - (this.lastRender || 0) >= 1000) { this.lastRender = now; this.render(false); }
    }

    refreshView() {
        if (this.els) this.render(false);
    }

    // ------------------------------------------------------------ OGraf

    async load({ data, renderType } = {}) {
        if (renderType && renderType !== "realtime") {
            return { statusCode: 400, statusMessage: "Only real-time rendering is supported" };
        }
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `<style>${STYLE}</style>
            <div class="frame"><header class="bar"><div style="min-width:0"><div class="title"></div><div class="subtitle"></div></div>
            <div class="meta"><div class="clock"></div><div class="status"></div></div></header><main class="body"></main></div>`;
        const q = (s) => root.querySelector(s);
        this.els = { frame: q(".frame"), bar: q(".bar"), title: q(".title"), subtitle: q(".subtitle"), clock: q(".clock"), status: q(".status"), body: q(".body"), regions: {} };
        this.setData(data);
        // Show cached data at once; with no cache, give the network a moment.
        await this.store.ready(5000);
        await document.fonts?.ready;
        this.render(true);
        this.updateLive(Date.now());
        this.ticker = setInterval(() => this.tick(), 1000);
        this.onResize = new ResizeObserver(() => { if (this.mode === "schedule") { this.key = ""; this.render(false); } });
        this.onResize.observe(this);
        return { statusCode: 200 };
    }

    async dispose() {
        clearInterval(this.ticker);
        this.onResize?.disconnect();
        this.unsub?.();
        this.shadowRoot?.replaceChildren();
        return { statusCode: 200 };
    }

    anim(el, frames, ms, skip, delay = 0) {
        if (!el) return Promise.resolve();
        return el.animate(frames, { duration: skip ? 0 : ms, delay: skip ? 0 : delay, easing: EASE, fill: "both" }).finished;
    }

    // Pieces that animate in and out, in order.
    pieces() {
        const body = this.els.body;
        const groups = [...body.querySelectorAll(".card, .side, .sched .row, .empty")];
        return groups.slice(0, 24);
    }

    playAction({ skipAnimation } = {}) {
        return this.enqueue(async () => {
            if (!this.visible) {
                const f = this.els.frame, skip = !!skipAnimation;
                this.render(false);
                this.updateLive(Date.now());
                f.style.visibility = "visible";
                this.visible = true;
                const parts = this.pieces();
                await Promise.all([
                    this.anim(f, [{ opacity: 0 }, { opacity: 1 }], 400, skip),
                    this.anim(this.els.bar, [{ transform: "translateY(-120%)", opacity: 0 }, { transform: "none", opacity: 1 }], 600, skip, 150),
                    ...parts.map((p, i) => this.anim(p, [{ transform: "translateY(4cqmin)", opacity: 0 }, { transform: "none", opacity: 1 }], 550, skip, 250 + Math.min(i, 12) * 45)),
                ]);
                for (const a of [f, this.els.bar, ...parts]) for (const x of a.getAnimations()) if (x.playState === "finished") x.cancel();
            }
            return { statusCode: 200, currentStep: 0 };
        });
    }

    stopAction({ skipAnimation } = {}) {
        return this.enqueue(async () => {
            if (this.visible) {
                const f = this.els.frame, skip = !!skipAnimation;
                const parts = this.pieces();
                await Promise.all([
                    ...parts.map((p, i) => this.anim(p, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-3cqmin)" }], 300, skip, Math.min(i, 12) * 25)),
                    this.anim(this.els.bar, [{ opacity: 1 }, { opacity: 0 }], 300, skip, 100),
                ]);
                await this.anim(f, [{ opacity: 1 }, { opacity: 0 }], 250, skip);
                f.style.visibility = "hidden";
                for (const a of [f, this.els.bar, ...parts]) for (const x of a.getAnimations()) x.cancel();
                this.visible = false;
            }
            return { statusCode: 200 };
        });
    }

    updateAction({ data, skipAnimation } = {}) {
        return this.enqueue(async () => {
            this.setData(data);
            if (this.visible && !skipAnimation) {
                await this.anim(this.els.body, [{ opacity: 1 }, { opacity: 0 }], 200, false);
                this.render(true);
                this.updateLive(Date.now());
                await this.anim(this.els.body, [{ opacity: 0 }, { opacity: 1 }], 300, false);
                for (const x of this.els.body.getAnimations()) x.cancel();
            } else {
                this.render(true);
            }
            return { statusCode: 200 };
        });
    }

    async customAction({ id } = {}) {
        if (id === "refresh") { await this.store.refresh(); return { statusCode: 200 }; }
        return { statusCode: 404, statusMessage: `Unknown action ${id}` };
    }

    // Non-real-time methods: not supported (supportsNonRealTime is false).
    async goToTime() { return { statusCode: 400, statusMessage: "Non-real-time rendering is not supported" }; }
    async setActionsSchedule() { return { statusCode: 400, statusMessage: "Non-real-time rendering is not supported" }; }
}
