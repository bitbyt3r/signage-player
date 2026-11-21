// Demo OGraf graphic: a lower third (name + title) that slides in from the
// left, holds, and slides out. Real-time only, one step.
// Interface: https://ograf.ebu.io/v1/specification/docs/Specification.html

const DEFAULTS = { name: "MAGFest Signage", title: "Player demo", accent: "#e4405f" };

const STYLE = `
:host { position: absolute; inset: 0; pointer-events: none; }
.wrap { position: absolute; left: 6vw; bottom: 9vh; display: flex; align-items: stretch;
        font-family: "Noto Sans", "DejaVu Sans", sans-serif; visibility: hidden; }
.accent { width: 0.9vw; background: var(--accent); transform-origin: bottom; }
.panel { overflow: hidden; }
.box { background: rgba(14, 18, 24, 0.88); color: #f4f6f8; padding: 1.4vw 2.6vw 1.5vw 1.8vw;
       box-shadow: 0 0.6vw 2vw rgba(0, 0, 0, 0.35); }
.name { font-size: 3.2vw; font-weight: 700; line-height: 1.1; white-space: nowrap; }
.title { font-size: 1.7vw; line-height: 1.3; margin-top: 0.4vw; color: #c9d3dc;
         letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
`;

export default class DemoLowerThird extends HTMLElement {
    constructor() {
        super();
        this.data = { ...DEFAULTS };
        this.visible = false;
        this.queue = Promise.resolve();
    }

    // Action calls may arrive while an earlier one is still animating; run
    // them in order rather than overlapping animations.
    enqueue(fn) {
        const next = this.queue.then(fn, fn);
        this.queue = next.catch(() => {});
        return next;
    }

    render() {
        this.els.accent.style.setProperty("--accent", this.data.accent || DEFAULTS.accent);
        this.els.name.textContent = this.data.name ?? "";
        this.els.title.textContent = this.data.title ?? "";
    }

    animate(el, frames, ms, skip) {
        const a = el.animate(frames, { duration: skip ? 0 : ms, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
        return a.finished;
    }

    async load({ data, renderType } = {}) {
        if (renderType && renderType !== "realtime") {
            return { statusCode: 400, statusMessage: "Only real-time rendering is supported" };
        }
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `<style>${STYLE}</style>
            <div class="wrap"><div class="accent"></div>
            <div class="panel"><div class="box"><div class="name"></div><div class="title"></div></div></div></div>`;
        this.els = {
            wrap: root.querySelector(".wrap"), accent: root.querySelector(".accent"),
            box: root.querySelector(".box"), name: root.querySelector(".name"), title: root.querySelector(".title"),
        };
        this.data = { ...DEFAULTS, ...(data || {}) };
        this.render();
        await document.fonts?.ready;
        return { statusCode: 200 };
    }

    async dispose() {
        this.shadowRoot?.replaceChildren();
        return { statusCode: 200 };
    }

    playAction({ skipAnimation } = {}) {
        return this.enqueue(async () => {
            if (!this.visible) {
                this.visible = true;
                this.els.wrap.style.visibility = "visible";
                await this.animate(this.els.accent, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], 300, skipAnimation);
                await Promise.all([
                    this.animate(this.els.box, [{ transform: "translateX(-105%)" }, { transform: "translateX(0)" }], 500, skipAnimation),
                    this.animate(this.els.title, [{ opacity: 0 }, { opacity: 1 }], 600, skipAnimation),
                ]);
            }
            // One step: currentStep is undefined once the graphic has reached its end state.
            return { statusCode: 200, currentStep: 0 };
        });
    }

    stopAction({ skipAnimation } = {}) {
        return this.enqueue(async () => {
            if (this.visible) {
                await this.animate(this.els.box, [{ transform: "translateX(0)" }, { transform: "translateX(-105%)" }], 400, skipAnimation);
                await this.animate(this.els.accent, [{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], 200, skipAnimation);
                this.els.wrap.style.visibility = "hidden";
                this.visible = false;
            }
            return { statusCode: 200 };
        });
    }

    updateAction({ data, skipAnimation } = {}) {
        return this.enqueue(async () => {
            this.data = { ...this.data, ...(data || {}) };
            if (this.visible && !skipAnimation) {
                await this.animate(this.els.box, [{ opacity: 1 }, { opacity: 0 }], 150, false);
                this.render();
                await this.animate(this.els.box, [{ opacity: 0 }, { opacity: 1 }], 150, false);
            } else {
                this.render();
            }
            return { statusCode: 200 };
        });
    }

    customAction({ id, skipAnimation } = {}) {
        if (id !== "highlight") {
            return Promise.resolve({ statusCode: 404, statusMessage: `Unknown action ${id}` });
        }
        return this.enqueue(async () => {
            await this.animate(this.els.accent,
                [{ filter: "brightness(1)" }, { filter: "brightness(1.8)" }, { filter: "brightness(1)" }], 500, skipAnimation);
            return { statusCode: 200 };
        });
    }

    // Non-real-time methods: not supported (supportsNonRealTime is false).
    async goToTime() { return { statusCode: 400, statusMessage: "Non-real-time rendering is not supported" }; }
    async setActionsSchedule() { return { statusCode: 400, statusMessage: "Non-real-time rendering is not supported" }; }
}
