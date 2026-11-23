// Shared by the player and the host page: the device status files that
// signage-web serves under /status/, the dashboard connection line and the
// OS update progress bar.

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function getJson(path) {
    try {
        const r = await fetch(path, { cache: "no-store" });
        if (r.ok) return await r.json();
    } catch { /* not there (yet) */ }
    return null;
}

const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The agent's agent.json as {cls: ok|warn|dim, text}. */
export function dashboardState(a) {
    if (!a) return { cls: "dim", text: "agent not running" };
    if (a.state === "connected") return { cls: "ok", text: `connected · checked in ${ago(a.last_ok || a.last_attempt)} ago` };
    if (a.state === "unconfigured") return { cls: "dim", text: "not configured" };
    let text = a.last_ok ? `offline since ${hhmm(a.last_ok)}` : "connecting";
    if (a.error) text += ` — ${a.error}`;
    return { cls: "warn", text };
}

export function dashboardLine(a) {
    const d = dashboardState(a);
    return `<span class="k">Dashboard</span> <span class="${d.cls}">${esc(d.text)}</span>`;
}

/**
 * The agent writes update.json while systemd-sysupdate runs. Show a
 * full-width bar along the bottom until it's done; a failure stays up for a
 * minute. el needs .fill and .label children (see the pages' CSS).
 */
export function startUpdateBar(el, interval = 2000) {
    async function refresh() {
        const u = await getJson("/status/update.json");
        let show = !!(u && u.state && u.state !== "done");
        if (show && u.state === "failed") show = Date.now() - (u.updated || 0) < 60000;
        el.hidden = !show;
        if (!show) return;
        const pct = Math.max(0, Math.min(100, Number(u.percent) || 0));
        const v = u.version ? ` to v${u.version}` : "";
        const label = u.state === "failed" ? `Update${v} failed: ${u.message || "unknown error"}`
            : u.state === "rebooting" ? `Updated${v}, rebooting…`
            : `Updating${v}… ${pct}%`;
        el.classList.toggle("failed", u.state === "failed");
        el.querySelector(".fill").style.width = `${u.state === "failed" ? 100 : pct}%`;
        el.querySelector(".label").textContent = label;
    }
    refresh();
    return setInterval(refresh, interval);
}
