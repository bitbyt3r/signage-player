"""Validation that mirrors the device's signage-config, so the dashboard
never sends an override the device would reject (a rejected config makes
the device fall back to defaults, dropping WiFi)."""

import re
from datetime import datetime

ROTATIONS = {0, 90, 180, 270}
MODE_RE = re.compile(r"^\d+x\d+(@\d+(\.\d+)?)?$")
NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
HOST_RE = re.compile(r"^[A-Za-z0-9.:-]{1,253}$")
TZ_RE = re.compile(r"^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$")
OUTPUT_RE = re.compile(r"^[A-Za-z0-9_.-]{0,64}$")
SPAN_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SETTINGS_KEYS = {
    "device": {"name", "timezone"},
    "network": {"wifi"},
    "ntp": {"servers"},
    "display": {"mode", "custom", "rotation", "output", "scale", "layout", "span", "max_fps"},
}


def _timezones():
    try:
        import zoneinfo
        return zoneinfo.available_timezones()
    except Exception:
        return set()


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def settings(s):
    """Validate device overrides; returns a cleaned dict and a list of errors."""
    errs = []
    if not isinstance(s, dict):
        return {}, ["settings must be an object"]
    out = {}
    for sec, val in s.items():
        if sec not in SETTINGS_KEYS:
            errs.append(f"unknown section [{sec}]")
            continue
        if not isinstance(val, dict):
            errs.append(f"[{sec}] must be an object")
            continue
        for k in val:
            if k not in SETTINGS_KEYS[sec]:
                errs.append(f"unknown setting {sec}.{k}")
        clean = {k: v for k, v in val.items() if k in SETTINGS_KEYS[sec] and v is not None}
        if clean:
            out[sec] = clean

    d = out.get("device", {})
    if "name" in d and not (isinstance(d["name"], str) and NAME_RE.match(d["name"])):
        errs.append("device.name: lowercase letters, digits and dashes, up to 63 characters")
    if "timezone" in d:
        tz = d["timezone"]
        zones = _timezones()
        if not isinstance(tz, str) or not TZ_RE.match(tz) or (zones and tz not in zones):
            errs.append(f"device.timezone: unknown time zone {tz!r}")

    n = out.get("network", {})
    if "wifi" in n:
        wifi = n["wifi"]
        if not isinstance(wifi, list):
            errs.append("network.wifi must be a list")
        else:
            cleaned = []
            for i, w in enumerate(wifi):
                where = f"network.wifi[{i}]"
                if not isinstance(w, dict):
                    errs.append(f"{where}: must be an object")
                    continue
                extra = set(w) - {"ssid", "psk", "priority", "hidden"}
                if extra:
                    errs.append(f"{where}: unknown keys {sorted(extra)}")
                ssid = w.get("ssid")
                if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32:
                    errs.append(f"{where}.ssid: required, 1 to 32 bytes")
                psk = w.get("psk", "")
                if not isinstance(psk, str) or (psk and not 8 <= len(psk) <= 64):
                    errs.append(f"{where}.psk: 8 to 63 characters (or 64 hex), or empty for an open network")
                elif len(psk) == 64 and not re.fullmatch(r"[0-9a-fA-F]{64}", psk):
                    errs.append(f"{where}.psk: a 64 character key must be hex")
                if not is_int(w.get("priority", 0)):
                    errs.append(f"{where}.priority: must be a whole number")
                if not isinstance(w.get("hidden", False), bool):
                    errs.append(f"{where}.hidden: must be true or false")
                c = {"ssid": ssid, "psk": psk or "", "priority": w.get("priority", 0),
                     "hidden": w.get("hidden", False)}
                cleaned.append(c)
            n["wifi"] = cleaned

    t = out.get("ntp", {})
    if "servers" in t:
        sv = t["servers"]
        if not isinstance(sv, list) or not all(isinstance(x, str) and HOST_RE.match(x) for x in sv):
            errs.append("ntp.servers: must be a list of host names or addresses")

    disp = out.get("display", {})
    if "mode" in disp and not (isinstance(disp["mode"], str) and (disp["mode"] == "" or MODE_RE.match(disp["mode"]))):
        errs.append("display.mode: use WIDTHxHEIGHT or WIDTHxHEIGHT@HZ")
    if "custom" in disp and not isinstance(disp["custom"], bool):
        errs.append("display.custom: must be true or false")
    if "layout" in disp and disp["layout"] not in ("screen", "arch"):
        errs.append("display.layout: must be screen or arch")
    if "rotation" in disp and not (is_int(disp["rotation"]) and disp["rotation"] in ROTATIONS):
        errs.append("display.rotation: must be 0, 90, 180 or 270")
    if "output" in disp and not (isinstance(disp["output"], str) and OUTPUT_RE.match(disp["output"])):
        errs.append("display.output: a connector name like HDMI-A-1")
    if "span" in disp:
        sp = disp["span"]
        if not (isinstance(sp, list) and 2 <= len(sp) <= 4 and all(isinstance(x, str) and SPAN_RE.match(x) for x in sp)
                and len(set(sp)) == len(sp)):
            errs.append("display.span: 2 to 4 different output names, left to right, like DP-1")
        elif disp.get("layout") == "arch":
            errs.append("display.span: only works with the screen layout")
    if "max_fps" in disp and not (is_int(disp["max_fps"]) and (disp["max_fps"] == 0 or 10 <= disp["max_fps"] <= 240)):
        errs.append("display.max_fps: 0 (off) or 10 to 240")
    if "scale" in disp:
        sc = disp["scale"]
        if isinstance(sc, bool) or not isinstance(sc, (int, float)) or not 0.25 <= sc <= 4:
            errs.append("display.scale: must be 0.25 to 4")
        else:
            disp["scale"] = float(sc)
    return out, errs


def slug(v, what):
    if not isinstance(v, str) or not SLUG_RE.match(v):
        return f"{what}: letters, digits, dot, dash and underscore only"
    return None


def _dt(v):
    try:
        datetime.fromisoformat(v)
        return True
    except (TypeError, ValueError):
        return False


def program(p):
    """Validate a program (layers of rotating graphics)."""
    errs = []
    if not isinstance(p, dict):
        return {}, ["program must be an object"]
    name = p.get("name")
    if not isinstance(name, str) or not name.strip():
        errs.append("name is required")
    layers = p.get("layers", [])
    if not isinstance(layers, list):
        return {}, errs + ["layers must be a list"]
    out_layers = []
    for li, layer in enumerate(layers):
        where = f"layer {li + 1}"
        if not isinstance(layer, dict):
            errs.append(f"{where}: must be an object")
            continue
        z = layer.get("layer", li)
        if not is_int(z) or not -1000 <= z <= 1000:
            errs.append(f"{where}: layer number must be a whole number")
        items = layer.get("items", [])
        if not isinstance(items, list):
            errs.append(f"{where}: items must be a list")
            continue
        out_items = []
        for ii, it in enumerate(items):
            w = f"{where}, item {ii + 1}"
            if not isinstance(it, dict):
                errs.append(f"{w}: must be an object")
                continue
            e = slug(it.get("package"), f"{w} package")
            if e:
                errs.append(e)
            ver = it.get("version") or ""
            if ver and slug(ver, "version"):
                errs.append(f"{w}: bad version")
            dur = it.get("duration", 30)
            if not isinstance(dur, (int, float)) or isinstance(dur, bool) or not 0 <= dur <= 86400:
                errs.append(f"{w}: duration must be 0 to 86400 seconds (0 = stay until replaced)")
            data = it.get("data", {})
            if not isinstance(data, dict):
                errs.append(f"{w}: data must be a JSON object")
            days = it.get("days") or []
            if not isinstance(days, list) or not all(is_int(d) and 0 <= d <= 6 for d in days):
                errs.append(f"{w}: days must be a list of 0 (Mon) to 6 (Sun)")
            for k in ("start", "end"):
                v = it.get(k) or ""
                if v and not (isinstance(v, str) and HHMM_RE.match(v)):
                    errs.append(f"{w}: {k} must be HH:MM")
            for k in ("from", "until"):
                v = it.get(k) or ""
                if v and not _dt(v):
                    errs.append(f"{w}: {k} must be a date and time like 2027-01-08T09:00")
            clean = {"package": it.get("package"), "version": ver, "duration": dur, "data": data}
            for k in ("days", "start", "end", "from", "until"):
                if it.get(k):
                    clean[k] = it[k]
            if it.get("label"):
                clean["label"] = str(it["label"])[:100]
            out_items.append(clean)
        out_layers.append({
            "name": str(layer.get("name") or f"Layer {z}")[:100],
            "layer": z,
            "items": out_items,
        })
    return {
        "name": (name or "").strip()[:100],
        "description": str(p.get("description") or "")[:500],
        "layers": out_layers,
    }, errs
