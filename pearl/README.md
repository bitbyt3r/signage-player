# Pearl panel-room page

A page for an Epiphan Pearl's **Web Graphics** input that runs a panel
room's projector:

| When | Shows |
|---|---|
| Between panels | The room's schedule: what's up next, a countdown to it, and the few after |
| A panel is on, nothing plugged in | The MAGFest logo |
| A panel is on, a laptop is plugged in | The laptop (the page goes transparent over the HDMI input) |
| A panel runs over with the laptop still in | The laptop, for up to `overrun` minutes or until the next session |

The schedule comes from [MAGSched](https://schedule.magfest.net) and is cached
in the page, so it keeps working through network drops.

## How it fits on the Pearl

One layout on the channel that feeds the HDMI output (the projector):

1. **HDMI-A**, full frame, at the bottom. Set its *No signal image* to the
   MAGFest logo and the timeout low (1 s). This is the logo when the page
   can't tell whether video is coming in.
2. **Graphics 1** (Web Graphics, 1920×1080), full frame, on top, pointed at
   this page.

Between panels the page is opaque and covers the HDMI input. During a panel
it goes transparent. Tested on a Pearl Mini (firmware 4.24.7): the Web
Graphics renderer keeps the page's transparent background, and the HDMI
input (or the layout background) shows through.

The layout can be set through the API, though the endpoint isn't in
Epiphan's published spec: `PUT /api/v2.0/channels/{cid}/layouts/{lid}/settings`
with sources `D2P0.hdmi-a` and `WEBG1`, e.g.

```json
{"video": [
  {"type": "source", "position": {"top": 0, "bottom": 0, "left": 0, "right": 0, "keep_aspect_ratio": true}, "settings": {"source": "D2P0.hdmi-a"}},
  {"type": "source", "position": {"top": 0, "bottom": 0, "left": 0, "right": 0, "keep_aspect_ratio": true}, "settings": {"source": "WEBG1"}}],
 "audio": [{"type": "source", "settings": {"source": "D2P0.hdmi-a-audio"}}],
 "background": "#000000"}
```

and the page URL with `PATCH /api/v2.0/inputs/WEBG1/settings`
`{"web_graphics": {"url": "..."}}`.

## Knowing whether video is coming in

The Pearl API (`GET /api/v2.0/inputs/hdmi-a/status`) says. On a Pearl Mini
with firmware 4.24.7 an unplugged HDMI input reads `state: "active"` at
`resolution: "0x0"`, `actual_fps: 0`. But the API needs the admin password
and rejects cross-origin preflight requests, so the page can't ask it
directly, and the password shouldn't be in a URL on the Pearl.

`pearl-bridge.py` polls the Pearl once a second and answers `GET /status`
with `{"video": true|false|null}`, no password, CORS open. It also serves this
page and the theme art. It only reads from the Pearl.

```bash
PEARL_PASS=... python3 pearl/pearl-bridge.py --pearl 10.1.29.127 --port 8099
```

then point Graphics 1 at

```
http://<bridge host>:8099/?room=Panels%201&status=/status
```

Without `status=`, the page goes transparent for every panel and the
HDMI input's own "no signal" image does the logo.

## Page parameters

| Parameter | Default | |
|---|---|---|
| `room` | (required) | Room name ("Panels 1 (Cherry Blossom Ballroom)"), short name ("Panels 1"), or MAGSched location ID |
| `status` | none | Signal bridge URL, e.g. `/status` |
| `api` | `https://schedule.magfest.net` | MAGSched base URL |
| `assets` | `/packages/` | Where the theme art lives (the git-ignored `packages/` folder: `magfest-schedule/assets/` and `magfest-logo/assets/`). Missing art just makes the page plainer |
| `tz` | `America/New_York` | Time zone for times on screen |
| `pre` | 0 | Minutes before a session to leave the schedule |
| `post` | 0 | Minutes after a session to stay in panel mode |
| `mingap` | 5 | Changeovers shorter than this stay in panel mode |
| `overrun` | 15 | With video still in, minutes a panel may run over |
| `early` | off | `early=1` shows video that arrives between panels |
| `now` | | Pretend it's this time (ISO 8601), for testing |
| `offline` | 60 | Seconds without reaching the page's server before the page goes transparent |
| `debug` | | `debug=1` shows the mode and why |

## When things go wrong, the laptop wins

Whenever the page can't do its job it goes transparent, so the room's HDMI
input shows: no `room`, no schedule yet, room not found, or the page's server
out of reach for `offline` seconds (checked with a HEAD of the page every
15 s). Tested on the Pearl: when the server goes away the Pearl marks the
Web Graphics input as errored after 10 to 20 s but keeps running the page it
already has, so the page's own fallback is what you see.

One gap: if the Pearl (re)starts while the server is unreachable, it can't
load the page at all and shows an opaque "Failed to render the Web Output
URL" card over the HDMI input.

## Tests

```bash
node --test tests/pearl/
```
