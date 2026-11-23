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
    theme: "super2027",
    accent: "",
    background: "",
    apiBase: DEFAULT_API,
    refreshSeconds: 120,
};

// Tracks that are ratings or noise levels rather than topics: not shown as chips.
const HIDDEN_CHIPS = /^(noise level|all ages|schedule track|alcohol|animated blood|blood and gore|mature|nudity|sexual|violence)/i;
const ROOMS_PER_PAGE = 4;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const HEARTS = 10;

// Super MAGFest 2027 theme: art from the theme team's asset pack, only
// cropped and scaled (see assets/). Colours from the style guide.
const asset = (f) => new URL(`./assets/${f}`, import.meta.url).href;
const THEMES = {
    super2027: { accent: "#E4BC60", background: "#0E5135" },
    plain: { accent: "#e4405f", background: "#0e1218" },
};

// Fonts from the asset pack. @font-face doesn't reach into shadow roots, so
// register them on the document once.
let fontsLoaded = null;
function loadFonts() {
    if (fontsLoaded) return fontsLoaded;
    const faces = [
        new FontFace("S27 Hylia", `url("${asset("HyliaSerifBeta-Regular.otf")}")`),
        new FontFace("S27 Noto", `url("${asset("NotoSans-Variable.ttf")}")`, { weight: "100 900", stretch: "62.5% 100%" }),
    ];
    fontsLoaded = Promise.all(faces.map((f) => { document.fonts.add(f); return f.load(); }))
        .catch((e) => console.warn("[magsched] font failed to load", e));
    return Promise.race([fontsLoaded, new Promise((r) => setTimeout(r, 3000))]);
}

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

/* ---- Super MAGFest 2027 theme */
.s27 { display: none; }
.t-super2027 { --fg: #f7eedb; --muted: #d6c19a; --line: rgba(228,188,96,.30); --panel: rgba(48,30,18,.86);
               --gold: #E4BC60; --green: #2F9445; --brown: #301E12;
               background: var(--img-bg) center / cover no-repeat, var(--bg);
               font-family: "S27 Noto", "Noto Sans", "DejaVu Sans", sans-serif; padding: 3.4cqmin 4.4cqmin 4.2cqmin; }
.t-super2027 .s27 { display: block; }
.t-super2027 .bar { border-bottom: none; padding-bottom: 0; align-items: center; gap: 2.6cqmin; position: relative; }
.t-super2027 .logo { height: 11cqmin; width: auto; flex: none; filter: drop-shadow(0 .4cqmin .6cqmin rgba(0,0,0,.6)); }
.t-super2027 .title { font-family: "S27 Hylia", serif; font-weight: 400; font-size: 6.4cqmin; color: var(--gold);
                      text-shadow: .25cqmin .35cqmin 0 var(--brown), 0 0 1.6cqmin rgba(0,0,0,.7); }
.t-super2027 .subtitle { color: var(--fg); font-size: 2.3cqmin; text-shadow: 0 .2cqmin .5cqmin #000; }
.t-super2027 .meta { display: flex; flex-direction: column; align-items: flex-end; }
.t-super2027 .clock { border-style: solid; border-color: transparent; border-width: 1.3cqmin 1.6cqmin;
                      border-image: var(--img-context) 34 40 fill / 1.3cqmin 1.6cqmin stretch;
                      color: var(--brown); font-size: 4.2cqmin; padding: .4cqmin 1.4cqmin; }
.t-super2027 .status { text-shadow: 0 .2cqmin .4cqmin #000; }
.t-super2027 .loot { position: absolute; right: calc(100% + 1cqmin); top: -1.5cqmin; height: 15cqmin; width: auto;
                     filter: drop-shadow(0 .5cqmin .8cqmin rgba(0,0,0,.5)); transform-origin: 50% 100%;
                     animation: bob 3.2s ease-in-out infinite; }
.t-super2027 .meta-wrap { position: relative; }
.t-super2027 .divider { height: 3.2cqmin; flex: none;
    background: var(--img-tri) center / auto 100% no-repeat, var(--img-wave) center / auto 100% repeat-x; }
@keyframes bob { 50% { transform: translateY(-.8cqmin) rotate(-2deg); } }
@keyframes float { 0%,100% { transform: translate(0, 0); } 30% { transform: translate(.4cqmin, -.9cqmin); } 65% { transform: translate(-.3cqmin, -.3cqmin); } }
@keyframes glint { 50% { filter: drop-shadow(0 0 .9cqmin rgba(255,226,140,.95)) brightness(1.25); } }
.t-super2027 .card, .t-super2027 .side { background: var(--panel); border: .3cqmin solid var(--gold); border-radius: .6cqmin;
    box-shadow: inset 0 0 0 .5cqmin rgba(48,30,18,.9), inset 0 0 0 .65cqmin rgba(228,188,96,.45), 0 .8cqmin 2cqmin rgba(0,0,0,.45); }
.t-super2027 .side h2, .t-super2027 .label { font-family: "S27 Hylia", serif; font-weight: 400; letter-spacing: .06em;
    font-size: 2.9cqmin; color: var(--gold); }
.t-super2027 .label .dot { display: none; }
.t-super2027 .label .tomi { display: inline-block; height: 4cqmin; width: auto; image-rendering: pixelated; vertical-align: -1cqmin;
                            margin-right: 1cqmin; animation: float 2.6s ease-in-out infinite; }
.t-super2027 .label .when { font-family: "S27 Noto", sans-serif; font-size: 2.3cqmin; color: var(--fg); }
.t-super2027 .now-name { font-weight: 800; font-stretch: 87.5%; text-shadow: 0 .3cqmin .5cqmin rgba(0,0,0,.6); }
.t-super2027 .next-name, .t-super2027 .row .n { font-stretch: 87.5%; }
.t-super2027 .chip { border-color: rgba(228,188,96,.55); color: var(--gold); }
.t-super2027 .track { background: rgba(0,0,0,.55); border: .2cqmin solid #f7eedb; height: 1.6cqmin; }
.t-super2027 .fill { background: linear-gradient(#5fd36f, var(--green)); }
.t-super2027 .card.compact .track { height: 1.1cqmin; border-width: .15cqmin; }
.t-super2027 .row .track { height: .7cqmin; border: none; background: rgba(0,0,0,.45); }
.t-super2027 .sched .list { background: var(--panel); border: .3cqmin solid var(--gold); border-radius: .6cqmin; padding: 0 2.2cqmin;
    box-shadow: inset 0 0 0 .5cqmin rgba(48,30,18,.9), inset 0 0 0 .65cqmin rgba(228,188,96,.45), 0 .8cqmin 2cqmin rgba(0,0,0,.45); }
.t-super2027 .hearts { display: flex; gap: .7cqmin; margin-top: 2cqmin; }
.t-super2027 .hearts img { height: 4.2cqmin; width: auto; transition: opacity .6s, filter .6s;
                           filter: drop-shadow(0 .3cqmin .3cqmin rgba(0,0,0,.6)); }
.t-super2027 .hearts img.spent { opacity: .38; filter: grayscale(1) brightness(.75); }
.t-super2027 .hearts img.beat { animation: beat 1.1s ease-in-out infinite; }
@keyframes beat { 0%,100% { transform: scale(1); } 15% { transform: scale(1.14); } 30% { transform: scale(1); } 45% { transform: scale(1.08); } }
.t-super2027 .hero .progress { padding-top: 1.2cqmin; }
.t-super2027 .hero .progress .track { display: none; }
.t-super2027 .room, .t-super2027 .card.compact .room {
    font-family: "S27 Hylia", serif; font-weight: 400; color: var(--brown);
    border-style: solid; border-color: transparent; border-width: .9cqmin 2.2cqmin;
    border-image: var(--img-heading) 30 60 fill / .9cqmin 2.2cqmin stretch; padding: .1cqmin .6cqmin; align-self: flex-start; }
.t-super2027 .room small { color: rgba(48,30,18,.75); }
.t-super2027 .row .t.live { color: var(--gold); display: flex; align-items: center; gap: .6cqmin; letter-spacing: .06em;
                            font-family: "S27 Hylia", serif; font-weight: 400; font-size: 2.8cqmin; }
.t-super2027 .row .t.live img { height: 2.8cqmin; width: auto; animation: glint 2.4s ease-in-out infinite; }
.t-super2027 .row .t { color: var(--gold); }
.t-super2027 .pager i.on { background: var(--gold); }
.t-super2027 .hyut { position: absolute; left: 0; bottom: .2cqmin; height: 9cqmin; width: auto; z-index: 3;
                     transform: translateX(-30cqw); filter: drop-shadow(0 .4cqmin .4cqmin rgba(0,0,0,.5)); }
.t-super2027 .idle { color: var(--muted); font-family: "S27 Hylia", serif; font-weight: 400; }
.t-super2027 .empty { color: var(--fg); font-family: "S27 Hylia", serif; text-shadow: 0 .3cqmin .6cqmin #000; }

.t-super2027 .card.compact { padding: 1.2cqmin 2cqmin; }
.t-super2027 .card.compact .room { font-size: 2.3cqmin; border-width: .6cqmin 1.6cqmin; border-image-width: .6cqmin 1.6cqmin; }
.t-super2027 .card.compact .progress { padding-top: .6cqmin; }
.t-super2027 .card.compact .next { padding-top: .6cqmin; }
@container (aspect-ratio < 1) {
    .t-super2027 .loot { display: none; }
    .t-super2027 .logo { height: 8cqmin; }
}
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
        if (!THEMES[d.theme]) d.theme = DEFAULTS.theme;
        const th = THEMES[d.theme];
        this.style.setProperty("--accent", d.accent || th.accent);
        this.style.setProperty("--bg", d.background || th.background);
        if (this.els?.frame) this.els.frame.className = `frame t-${d.theme}`;
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
                h("div", { class: "label" }, h("span", { class: "dot" }), h("img", { class: "tomi s27", src: asset("pixel-tomi.png"), alt: "" }), "Now"),
                h("div", { class: "now-name" }, c.name),
                h("div", { class: "chips" }, this.chips(c, m)),
                this.data.showDescription && c.desc ? h("div", { class: "desc" }, c.desc) : null,
                h("div", { class: "hearts s27", "data-hearts-start": c.start, "data-hearts-end": c.end },
                    Array.from({ length: HEARTS }, () => h("img", { src: asset("heart-full.png"), alt: "" }))),
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
            live ? h("div", { class: "t live" }, h("img", { class: "s27", src: asset("trihard.png"), alt: "" }), "NOW") : h("div", { class: "t" },
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
            this.runHyut();
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
        const rows = Math.max(1, Math.floor((list.clientHeight + 0.5) / rowH));
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
        // Hearts: the time left, Zelda style (ten hearts at the start, half-hearts as it runs down).
        for (const box of root.querySelectorAll("[data-hearts-start]")) {
            const s = Number(box.dataset.heartsStart), e = Number(box.dataset.heartsEnd);
            const v = Math.max(0, Math.ceil(((e - now) / (e - s)) * HEARTS * 2)) / 2;
            [...box.children].forEach((img, i) => {
                const kind = i < Math.floor(v) ? "full" : i < v ? "half" : "empty";
                const src = asset(kind === "half" ? "heart-half.png" : "heart-full.png");
                if (img.getAttribute("src") !== src) img.setAttribute("src", src);
                img.classList.toggle("spent", kind === "empty");
                img.classList.toggle("beat", kind !== "empty" && i === Math.ceil(v) - 1);
            });
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
            <div class="frame"><header class="bar"><img class="logo s27" alt="">
            <div style="min-width:0;flex:1"><div class="title"></div><div class="subtitle"></div></div>
            <div class="meta-wrap"><img class="loot s27" alt=""><div class="meta"><div class="clock"></div><div class="status"></div></div></div></header>
            <div class="divider s27"></div><main class="body"></main><img class="hyut s27" alt=""></div>`;
        root.querySelector(".logo").src = asset("logo-flat.png");
        root.querySelector(".loot").src = asset("loot-presenting.png");
        root.querySelector(".hyut").src = asset("hyut-run.png");
        for (const [k, f] of [["--img-bg", "background-crest-fabric.png"], ["--img-context", "context-box.png"], ["--img-heading", "heading-box-long.png"],
            ["--img-wave", "squarewave-brown-tile.png"], ["--img-tri", "squarewave-triangle.png"]]) this.style.setProperty(k, `url("${asset(f)}")`);
        const q = (s) => root.querySelector(s);
        this.els = { frame: q(".frame"), bar: q(".bar"), logo: q(".logo"), loot: q(".loot"), hyut: q(".hyut"), divider: q(".divider"), title: q(".title"), subtitle: q(".subtitle"), clock: q(".clock"), status: q(".status"), body: q(".body"), regions: {} };
        this.setData(data);
        // Show cached data at once; with no cache, give the network a moment.
        await Promise.all([this.store.ready(5000), loadFonts(), this.decodeImages()]);
        await document.fonts?.ready;
        this.render(true);
        this.updateLive(Date.now());
        this.ticker = setInterval(() => this.tick(), 1000);
        this.onResize = new ResizeObserver(() => { if (this.mode === "schedule") { this.key = ""; this.render(false); } });
        this.onResize.observe(this);
        return { statusCode: 200 };
    }

    // Wait for the art so nothing pops in mid-animation.
    decodeImages() {
        const imgs = [this.els.logo, this.els.loot, this.els.hyut];
        const bgs = ["background-crest-fabric.png", "heading-box-long.png", "context-box.png", "heart-full.png", "heart-half.png", "pixel-tomi.png", "trihard.png"]
            .map((f) => Object.assign(new Image(), { src: asset(f) }));
        const all = [...imgs, ...bgs].map((i) => i.decode().catch(() => {}));
        return Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 4000))]);
    }

    get themed() { return this.data.theme === "super2027"; }

    // Hyut runs along the bottom edge (on page flips and when the graphic comes in).
    runHyut() {
        const el = this.els?.hyut;
        if (!el || !this.themed || !this.visible || this.hyutRunning) return;
        this.hyutRunning = true;
        const a = el.animate([
            { transform: "translateX(-30cqw) translateY(0)" }, { transform: "translateX(10cqw) translateY(-1.2cqmin)", offset: .25 },
            { transform: "translateX(50cqw) translateY(0)", offset: .5 }, { transform: "translateX(90cqw) translateY(-1.2cqmin)", offset: .75 },
            { transform: "translateX(130cqw) translateY(0)" }], { duration: 2600, easing: "linear" });
        a.finished.catch(() => {}).finally(() => { this.hyutRunning = false; });
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
                const t = this.themed, E = this.els;
                await Promise.all([
                    this.anim(f, [{ opacity: 0 }, { opacity: 1 }], 400, skip),
                    this.anim(E.bar, [{ transform: "translateY(-120%)", opacity: 0 }, { transform: "none", opacity: 1 }], 600, skip, 150),
                    t && this.anim(E.logo, [{ transform: "scale(.4) rotate(-8deg)", opacity: 0 }, { transform: "scale(1.08)", opacity: 1, offset: .7 }, { transform: "none", opacity: 1 }], 700, skip, 300),
                    t && this.anim(E.divider, [{ transform: "scaleX(0)", opacity: 0 }, { transform: "none", opacity: 1 }], 600, skip, 350),
                    t && this.anim(E.loot, [{ transform: "translateY(40%) scale(.6)", opacity: 0 }, { transform: "translateY(-6%) scale(1.04)", opacity: 1, offset: .7 }, { transform: "none", opacity: 1 }], 650, skip, 650),
                    ...parts.map((p, i) => this.anim(p, [{ transform: "translateY(4cqmin)", opacity: 0 }, { transform: "none", opacity: 1 }], 550, skip, 250 + Math.min(i, 12) * 45)),
                ]);
                for (const a of [f, E.bar, E.logo, E.divider, E.loot, ...parts]) for (const x of a.getAnimations()) if (x.playState === "finished" && x.effect?.getComputedTiming().fill === "both") x.cancel();
                if (!skip) this.runHyut();
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
                    this.themed && this.anim(this.els.hyut, [{ opacity: 1 }, { opacity: 0 }], 200, skip),
                    this.themed && this.anim(this.els.loot, [{ transform: "none", opacity: 1 }, { transform: "translateY(30%) scale(.7)", opacity: 0 }], 300, skip),
                    this.themed && this.anim(this.els.divider, [{ transform: "none", opacity: 1 }, { transform: "scaleX(0)", opacity: 0 }], 300, skip, 80),
                ]);
                await this.anim(f, [{ opacity: 1 }, { opacity: 0 }], 250, skip);
                f.style.visibility = "hidden";
                for (const x of this.els.hyut.getAnimations()) x.cancel();
                for (const a of [f, this.els.bar, this.els.loot, this.els.divider, ...parts]) for (const x of a.getAnimations()) if (x.effect?.getComputedTiming().fill === "both") x.cancel();
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
