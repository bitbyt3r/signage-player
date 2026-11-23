// Schedule data for the MAGFest schedule graphic: fetches the schedule from
// MAGSched (schedule.magfest.net), keeps the last good copy in localStorage
// so the sign keeps working through network loss and reboots, and helps
// filter it by room and track.
//
// One store per API base, shared by every graphic on the page (the module is
// imported once), so a layer transition between two schedule graphics does
// not fetch twice.

export const DEFAULT_API = "https://schedule.magfest.net";
const CACHE_VERSION = 1;
const cacheKey = (base) => `magsched:v${CACHE_VERSION}:${base}`;
const FETCH_TIMEOUT_MS = 30000;
const DESC_MAX = 400;

const stores = new Map();

export function getStore(apiBase) {
    const base = String(apiBase || DEFAULT_API).trim().replace(/\/+$/, "") || DEFAULT_API;
    let s = stores.get(base);
    if (!s) { s = new ScheduleStore(base); stores.set(base, s); }
    return s;
}

function stripHtml(html) {
    if (!html) return "";
    // A <template>'s content is inert: nothing loads or runs.
    const t = document.createElement("template");
    t.innerHTML = String(html).replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, " ");
    return t.content.textContent.replace(/\s+/g, " ").trim();
}

export function normalize(sessions, locations, tracks) {
    const loc = {}, trk = {};
    for (const l of locations || []) if (l && l.id != null) loc[String(l.id)] = String(l.name ?? l.id);
    for (const t of tracks || []) if (t && t.id != null) trk[String(t.id)] = String(t.name ?? t.id);
    const out = [];
    for (const s of sessions || []) {
        const start = Date.parse(s?.start_time);
        if (!Number.isFinite(start)) continue;
        let end = Date.parse(s.end_time);
        if (!Number.isFinite(end) || end <= start) end = start + 30 * 60000;
        let desc = stripHtml(s.description);
        if (desc.length > DESC_MAX) desc = desc.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, "") + "…";
        out.push({
            id: String(s.id), name: String(s.name ?? "").trim(), start, end,
            loc: (s.locations || []).map(String), tr: (s.tracks || []).map(String), desc,
        });
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return { sessions: out, locations: loc, tracks: trk };
}

class ScheduleStore {
    constructor(base) {
        this.base = base;
        this.data = null;          // {sessions, locations, tracks}
        this.fetchedAt = 0;        // when data last came from the network
        this.error = "";           // last refresh error, "" when the last refresh worked
        this.fails = 0;
        this.subs = new Map();     // callback -> refresh interval (s)
        this.timer = null;
        this.inflight = null;
        try {
            const raw = localStorage.getItem(cacheKey(base));
            if (raw) {
                const c = JSON.parse(raw);
                if (c && c.v === CACHE_VERSION && c.data?.sessions) { this.data = c.data; this.fetchedAt = c.fetchedAt || 0; }
            }
        } catch (e) { console.warn("[magsched] cache unreadable", e); }
        addEventListener("online", () => this.refresh());
    }

    get interval() {
        const v = Math.min(...this.subs.values());
        return Number.isFinite(v) ? Math.max(30, v) : 300;
    }

    // fn() runs after every refresh attempt (success or failure).
    subscribe(fn, intervalSeconds = 300) {
        this.subs.set(fn, Number(intervalSeconds) || 300);
        if (!this.inflight) {
            const age = (Date.now() - this.fetchedAt) / 1000;
            if (!this.data || age >= this.interval || this.error) this.refresh();
            else this.schedule((this.interval - age) * 1000);
        }
        return () => {
            this.subs.delete(fn);
            if (!this.subs.size) { clearTimeout(this.timer); this.timer = null; }
        };
    }

    schedule(ms) {
        clearTimeout(this.timer);
        this.timer = this.subs.size ? setTimeout(() => this.refresh(), Math.max(1000, ms)) : null;
    }

    // Resolves once there is data (cached or fetched), or after ms.
    ready(ms) {
        if (this.data) return Promise.resolve(true);
        return new Promise((resolve) => {
            const t = setTimeout(() => { this.subs.delete(fn); resolve(false); }, ms);
            const fn = () => { if (this.data) { clearTimeout(t); this.subs.delete(fn); resolve(true); } };
            this.subs.set(fn, Infinity);
        });
    }

    refresh() {
        if (this.inflight) return this.inflight;
        this.inflight = this.fetchAll()
            .then((ok) => {
                this.fails = ok ? 0 : this.fails + 1;
                // Retry failures sooner: 15 s, 30 s, 60 s ... up to the normal interval.
                this.schedule(ok ? this.interval * 1000 : Math.min(this.interval, 15 * 2 ** (this.fails - 1)) * 1000);
            })
            .finally(() => { this.inflight = null; for (const fn of [...this.subs.keys()]) { try { fn(); } catch (e) { console.error(e); } } });
        return this.inflight;
    }

    async get(path) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        try {
            const r = await fetch(this.base + path, { signal: ctl.signal, cache: "no-store" });
            if (!r.ok) throw new Error(`${path.split("?")[0]}: HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            throw e.name === "AbortError" ? new Error(`${path.split("?")[0]}: timed out`) : e;
        } finally { clearTimeout(t); }
    }

    async fetchAll() {
        try {
            const [sessions, locations, tracks] = await Promise.all([
                this.get("/sessions?limit=-1"), this.get("/locations?limit=-1"), this.get("/tracks?limit=-1"),
            ]);
            if (!Array.isArray(sessions) || !Array.isArray(locations) || !Array.isArray(tracks)) {
                throw new Error("unexpected response from the schedule server");
            }
            // An empty schedule from a server that had one is more likely a
            // server problem than a cancelled convention: keep the cache.
            if (!sessions.length && this.data?.sessions?.length) throw new Error("the schedule server returned no sessions");
            this.data = normalize(sessions, locations, tracks);
            this.fetchedAt = Date.now();
            this.error = "";
            this.save();
            return true;
        } catch (e) {
            this.error = e.message || String(e);
            console.warn("[magsched] refresh failed:", this.error);
            return false;
        }
    }

    save() {
        const write = (data) => localStorage.setItem(cacheKey(this.base),
            JSON.stringify({ v: CACHE_VERSION, fetchedAt: this.fetchedAt, data }));
        try { write(this.data); } catch {
            // Over quota: keep the schedule without descriptions.
            try { write({ ...this.data, sessions: this.data.sessions.map((s) => ({ ...s, desc: "" })) }); }
            catch (e) { console.warn("[magsched] could not cache the schedule", e); }
        }
    }
}

// ------------------------------------------------------------ filtering

// "Panels 1 (Cherry Blossom Ballroom)" -> "Panels 1"
export function shortName(name) {
    const s = String(name || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
    return s || String(name || "");
}

export function asList(v) {
    if (v == null || v === "") return [];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v).split(/\n/).map((x) => x.trim()).filter(Boolean);
}

// Match wanted names against an {id: name} map: by ID, by full name, or by
// the name without its parenthesised part, ignoring case.
function resolve(wanted, byId) {
    const entries = Object.entries(byId || {});
    const found = [], missing = [], seen = new Set();
    for (const w of asList(wanted)) {
        const q = w.toLowerCase();
        let hit = byId?.[w] != null ? [w, byId[w]] : null;
        hit ||= entries.find(([, n]) => n.toLowerCase() === q) || entries.find(([, n]) => shortName(n).toLowerCase() === q);
        if (!hit) { missing.push(w); continue; }
        if (!seen.has(hit[0])) { seen.add(hit[0]); found.push({ id: hit[0], name: hit[1], short: shortName(hit[1]) }); }
    }
    return { found, missing };
}

export const resolveRooms = (wanted, data) => resolve(wanted, data?.locations);
export const resolveTracks = (wanted, data) => resolve(wanted, data?.tracks);

// Shorten s to at most n characters, at a word boundary when one is close.
export function abbreviate(s, n) {
    s = String(s ?? "");
    n = Math.floor(Number(n) || 0);
    if (n <= 0 || s.length <= n) return s;
    if (n <= 2) return s.slice(0, n);
    let cut = s.slice(0, n - 1);
    const sp = cut.lastIndexOf(" ");
    if (sp >= n * 0.6) cut = cut.slice(0, sp);
    return cut.replace(/[\s,;:.\-–—/&(]+$/, "") + "…";
}
