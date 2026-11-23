// A QR code fetched from a URL every few seconds, for game signs.
//
// The URL can return an image (PNG, SVG, ...), or text, which is turned into
// a QR code here. JSON works too: a string, or an object with one of the
// fields qr, url, text, data or value. The last good code is kept in
// localStorage, so the sign keeps showing it through network loss and reboots.

const TIMEOUT_MS = 15000;
const CACHE_MAX = 400000;   // characters of data URL worth keeping
const cacheKey = (url) => `magsched:qr:v1:${url}`;

let qrLib = null;
async function encode(text) {
    qrLib ||= import("./vendor/qrcode.mjs").then((m) => m.default);
    const qrcode = await qrLib;
    qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
    const q = qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    // 4-module quiet zone, as the QR spec asks.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${n + 8} ${n + 8}" shape-rendering="crispEdges">` +
        `<rect x="-4" y="-4" width="${n + 8}" height="${n + 8}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
});

// Shows the image at src or rejects; used when the server doesn't allow
// cross-origin fetches (an <img> needs no CORS).
const probe = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    const t = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
    img.onload = () => { clearTimeout(t); img.naturalWidth ? resolve(src) : reject(new Error("empty image")); };
    img.onerror = () => { clearTimeout(t); reject(new Error("not an image")); };
    img.src = src;
});

function pick(json) {
    if (typeof json === "string") return json;
    for (const k of ["qr", "url", "text", "data", "value"]) if (typeof json?.[k] === "string") return json[k];
    throw new Error("JSON without a qr, url, text, data or value field");
}

export class QrFeed {
    // onChange(src) runs whenever the code to show changes ("" = nothing).
    constructor(url, seconds, onChange) {
        this.url = url;
        this.seconds = Math.max(5, Number(seconds) || 30);
        this.onChange = onChange;
        this.src = "";
        this.error = "";
        this.fails = 0;
        try { this.src = localStorage.getItem(cacheKey(url)) || ""; } catch {}
        this.refresh();
    }

    async load() {
        let r;
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            r = await fetch(this.url, { cache: "no-store", signal: ctl.signal });
        } catch (e) {
            if (e.name === "AbortError") throw new Error("timed out");
            // Network error or no CORS: try it as a plain image, cache-busted.
            const sep = this.url.includes("?") ? "&" : "?";
            return { src: await probe(`${this.url}${sep}_t=${Date.now()}`), keep: false };
        } finally { clearTimeout(t); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const type = (r.headers.get("content-type") || "").toLowerCase();
        if (type.startsWith("image/")) {
            const src = await toDataUrl(await r.blob());
            await probe(src);
            return { src, keep: true };
        }
        let text = (await r.text()).trim();
        if (type.includes("json") || /^[{"]/.test(text)) { try { text = pick(JSON.parse(text)).trim(); } catch (e) { if (type.includes("json")) throw e; } }
        if (!text) throw new Error("empty response");
        if (/^data:image\//i.test(text)) return { src: await probe(text), keep: true };
        if (/^<svg[\s>]/i.test(text) || /^<\?xml/i.test(text)) return { src: await probe("data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text)))), keep: true };
        return { src: await encode(text), keep: true };
    }

    async refresh() {
        clearTimeout(this.timer);
        if (this.stopped) return;
        try {
            const { src, keep } = await this.load();
            if (this.stopped) return;
            this.error = ""; this.fails = 0;
            if (keep) try { if (src.length <= CACHE_MAX) localStorage.setItem(cacheKey(this.url), src); } catch {}
            if (src !== this.src) { this.src = src; this.onChange(src); }
        } catch (e) {
            this.error = e.message || String(e);
            this.fails++;
            console.warn("[magsched] QR refresh failed:", this.error);
        }
        if (this.stopped) return;
        // After a failure, retry sooner (5 s, 10 s, 20 s ...) up to the normal interval.
        const wait = this.error ? Math.min(this.seconds, 5 * 2 ** (this.fails - 1)) : this.seconds;
        this.timer = setTimeout(() => this.refresh(), wait * 1000);
    }

    stop() { this.stopped = true; clearTimeout(this.timer); }
}
