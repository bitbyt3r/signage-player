// The display layout: an ordinary screen, or a logical canvas cut into
// pieces for an LED controller (layouts.mjs). See docs/player.md.
//
// For a sliced layout the canvas (#layers) is laid out once at the
// canvas size from the top-left corner of the output, so a region whose
// output position equals its canvas position (the arch header) needs no
// copy. Each other region is a div at its output position painted with
// -moz-element(#layers): Firefox paints the canvas into it as an image,
// without laying out or running the graphics a second time.
import { LAYOUTS } from "./layouts.mjs";
import { getJson } from "./status.mjs";

const params = new URLSearchParams(location.search);
const OVERRIDE = params.get("layout");
const DEBUG = params.get("debug") === "1";

export const layoutName = (v) => (v && Object.hasOwn(LAYOUTS, v) ? v : "screen");

/**
 * The layout the device is set to: ?layout=, else /status/display.json.
 * null when display.json can't be read right now.
 */
export async function wantedLayout() {
    if (OVERRIDE) return layoutName(OVERRIDE);
    const d = await getJson("/status/display.json");
    return d ? layoutName(d.layout) : null;
}

const px = (n) => `${n}px`;

function box(rect, cls) {
    const [x, y, w, h] = rect;
    const el = document.createElement("div");
    el.className = cls;
    Object.assign(el.style, { left: px(x), top: px(y), width: px(w), height: px(h) });
    return el;
}

function debugOverlay(layersEl, d) {
    const ov = document.createElement("div");
    ov.id = "debug";
    const add = (name, rect, cls) => {
        const b = box(rect, cls);
        b.textContent = `${name} [${rect.join(", ")}]`;
        ov.append(b);
    };
    const L = LAYOUTS[d.layout];
    if (L) {
        for (const [name, r] of Object.entries(L.regions)) add(`${name} → out ${r.out.join(",")}`, r.rect, "region");
        for (const [name, rect] of Object.entries(L.hidden || {})) add(`${name} (not shown)`, rect, "region hidden");
    } else {
        add("screen", d.visible[0], "region");
    }
    layersEl.append(ov);
}

/**
 * Lay out the page for `layout`. layersEl is the canvas the graphics render
 * into; frameEl holds the status screen and the update bar and is put where
 * a person can see it. Returns the description graphics get as
 * globalThis.signageDisplay.
 */
export function setupDisplay(layout, layersEl, frameEl) {
    const L = LAYOUTS[layout];
    let d;
    if (!L) {
        const w = innerWidth, h = innerHeight;
        d = { layout: "screen", width: w, height: h, regions: { screen: [0, 0, w, h] }, visible: [[0, 0, w, h]] };
    } else {
        const [cw, ch] = L.canvas;
        const regions = Object.fromEntries(Object.entries(L.regions).map(([k, r]) => [k, [...r.rect]]));
        d = { layout, width: cw, height: ch, regions, visible: Object.values(regions) };

        document.documentElement.dataset.layout = layout;
        layersEl.dataset.layout = layout;
        Object.assign(layersEl.style, { width: px(cw), height: px(ch) });
        layersEl.style.setProperty("--canvas-w", px(cw));
        layersEl.style.setProperty("--canvas-h", px(ch));
        for (const [k, r] of Object.entries(L.regions)) {
            layersEl.style.setProperty(`--${k}-w`, px(r.rect[2]));
            layersEl.style.setProperty(`--${k}-h`, px(r.rect[3]));
        }

        // The output, front to back: slices, then a black mask over the
        // canvas outside the regions that are shown in place.
        const out = document.createElement("div");
        out.id = "output";
        const inPlace = [];
        for (const [name, r] of Object.entries(L.regions)) {
            const [x, y, w, h] = r.rect;
            const [ox, oy] = r.out;
            if (x === ox && y === oy) { inPlace.push(r.rect); continue; }
            const s = box([ox, oy, w, h], "slice");
            s.dataset.region = name;
            s.style.backgroundSize = `${px(cw)} ${px(ch)}`;
            s.style.backgroundPosition = `${px(-x)} ${px(-y)}`;
            out.append(s);
        }
        // Mask: the canvas area that isn't one of the in-place regions.
        // Done as the in-place rects' complement, one strip per edge of the
        // bounding box (fine for the single in-place header).
        const [ow, oh] = L.output;
        for (const [x, y, w, h] of inPlace) {
            for (const m of [[0, 0, ow, y], [0, y + h, cw, oh - y - h], [0, y, x, h], [x + w, y, cw - x - w, h]]) {
                if (m[2] > 0 && m[3] > 0) out.prepend(box(m, "mask"));
            }
        }
        document.body.append(out);

        // Status screen and update bar: in the first region shown in place
        // (the header), so they're on the LEDs.
        const home = inPlace[0] || Object.values(L.regions)[0].rect;
        Object.assign(frameEl.style, { left: px(home[0]), top: px(home[1]), width: px(home[2]), height: px(home[3]) });
        // The status screen is sized in --u (1vw on a screen): treat the
        // region like a 16:9 screen of its height.
        frameEl.style.setProperty("--u", px(home[3] * 16 / 9 / 100));
    }
    if (DEBUG) debugOverlay(layersEl, d);
    globalThis.signageDisplay = Object.freeze(d);
    return d;
}
