# Player

The kiosk (Firefox ESR in cage) always opens `http://127.0.0.1:8080/player/`.
The player page plays the program that the dashboard assigned to this
player. When there's nothing to play, it shows the device status screen.
The page is plain ES modules in `mkosi.extra/usr/share/signage/player/`, with no
build step:

| File | |
|---|---|
| `index.html` | layout, the status screen and update bar styles |
| `player.mjs` | polling, layers, transitions |
| `eligibility.mjs` | when an item may play (pure; unit tests in `tests/player/`) |
| `status.mjs` | status files, dashboard line and update bar (shared with `/host/`) |

`signage-web` (`/usr/lib/signage/signage-web`) serves it all from
`127.0.0.1:8080`. Keep that origin: graphics keep their offline caches
(the schedule, for example) in its `localStorage`, which lives in the
kiosk's Firefox profile under `/var/lib/signage/home`.

| URL | From |
|---|---|
| `/content.json` | `/var/lib/signage/content.json` (`Cache-Control: no-store`) |
| `/packages/<id>/<version>/…` | `/var/lib/signage/packages/` (the dashboard's packages), else the image's `/usr/share/signage/packages/` |
| `/status/status.json` | the kiosk's device status (hostname, version, addresses, clock, config, display) |
| `/status/agent.json`, `/status/update.json` | the dashboard agent's connection and OS update progress (`/run/signage/`) |
| `/player/`, `/host/` | `/usr/share/signage/` |

Nothing else under `/var/lib/signage` is served (`config.toml` has the
WiFi passwords).

## content.json

The dashboard agent writes it atomically once every package it names is
downloaded and unpacked. Its format is defined in
[dashboard/README.md](../dashboard/README.md#contentjson-what-the-player-reads).
What the player uses:

- `rev`: the player reconciles when it changes. It falls back to
  `generation` if `rev` is missing.
- `program`: `null` means no program, so the status screen shows.
- `layers[]`: `layer` is the stacking order (higher is in front). `name`
  plus `layer` identify a layer across content changes.
- `items[]`, in order:
  - `url` + `main` is the module to import.
  - `url` + `manifest` is fetched first. A missing manifest is a failed
    item, so a wrong package root shows up as an error, not a blank layer.
  - `duration` is in seconds; 0 means it stays until the content changes or
    it stops being eligible.
  - `data` goes to `load()` and `updateAction()`, merged over the
    manifest schema's defaults.
  - `label` is used in log lines.
  - `days`, `start`, `end`, `from` and `until` are the schedule fields
    (below).
- `warnings[]` are logged to the browser console.

`path` and `packages[]` aren't used by the page.

### When an item is eligible

All times are the player's local time (`/etc/localtime`, from `timezone` in
`config.toml`).

- `days`: if present and not empty, today must be in it. 0 is Monday and 6
  is Sunday (`(getDay() + 6) % 7`).
- `start` and `end` (`HH:MM`): `start` defaults to 00:00, and a missing `end`
  means midnight. The end time is exclusive.
  - An `end` before `start` wraps past midnight: `22:00`–`02:00` plays from
    22:00 to 02:00 the next morning.
  - The part after midnight belongs to the day the window started. With
    `days: [4]` (Friday), `22:00`–`02:00` plays Friday 22:00 to Saturday
    02:00, and not on Friday at 01:00.
  - `start == end` means the whole day.
- `from` and `until` (`YYYY-MM-DDTHH:MM`, naive local time): eligible when
  `from <= now < until`. A date with no time means local midnight.
- A value that doesn't parse is ignored and logged.

## Playback

The page has a black base with one full-screen, transparent container per
layer, `z-index` = `layer`. Each layer runs on its own:

- It plays its eligible items in order and loops. It checks eligibility
  every second, so a window opening or closing takes effect within a
  second.
- When an item's `duration` is up, the layer moves to the next eligible
  item. If that is the same item (the only one eligible), the item keeps
  running.
- A layer with nothing eligible shows nothing (transparent).

**Transition** (same layer, one at a time):

1. `stopAction()` on the current graphic (5 s timeout), then `dispose()` (3 s),
   then remove it.
2. Fetch the next item's manifest. `import(url + main)` and define it as a
   custom element named `ograf-<package>-<version>`. A name is defined once
   and reused, never redefined.
3. `load({data, renderType: "realtime", renderCharacteristics})` (15 s), then
   `playAction()` (10 s).

The out-animation finishes before the next graphic loads. That is the
"animate one out, then the next one in" behaviour.

**Content changes** (polled every 2 s, applied without reloading the page):

- If the running graphic is still in the layer's list with the same package,
  version and data, it keeps running, and the layer continues from its new
  position in the list.
- If it is the only eligible item and only its `data` changed, the player
  calls `updateAction({data})` instead of restarting it.
- Otherwise the layer transitions to the next eligible item straight away.
  This matters because the agent deletes package versions that are no
  longer referenced, so a graphic from an old rev can lose its files.
- Layers that disappear are stopped and removed. New layers start.

**Failures.** If an import, manifest fetch, `load`, `playAction` or
`updateAction` throws, times out or returns `statusCode >= 300`, that item
is skipped for 60 s and the error is logged to the console. The layer
moves on, and other layers aren't affected. A failing `stopAction` or
`dispose` is logged, and the graphic is removed anyway.

## Status screen

The status screen shows hostname, version, addresses, clock and NTP state,
config source, display settings and the dashboard connection, with a line
saying why it's showing. It appears when:

- `content.json` is missing or unreadable,
- `program` is `null`, or
- no layer has a running or eligible item.

With `[player] demo = true`, the player plays the demo lower third instead
of the status screen while no program is assigned (the kiosk adds
`?demo=1`). `?status=0` turns the status screen off (black instead).

The dashboard line, from `agent.json`:

| State | Shows |
|---|---|
| connected | green: "connected · checked in 12 s ago" |
| offline / error (had connected before) | amber: "offline since 14:02 — error" |
| connecting (never connected) | amber: "connecting — error" |
| unconfigured | grey: "not configured" |
| no file | grey: "agent not running" |

## OS update bar

While the agent runs `systemd-sysupdate`, it writes `update.json`. The
player (and `/host/`) polls it every 2 s and shows a full-width bar along the
bottom, above every layer: "Updating to v0.1.2… 45%", then "Updated to
v0.1.2, rebooting…". A failure shows in red with the error for a minute.
After the reboot, the boot banner on tty1 says "Updated to v0.1.2 (was
v0.1.1)".

## Testing

- Unit tests: `node --test tests/player/`
- In a desktop browser: run `signage-web` against fixture directories. Its
  paths come from the environment:

  ```bash
  SIGNAGE_STATE=/tmp/fx/state SIGNAGE_SHARE=/tmp/fx/share SIGNAGE_WEB_PORT=8099 \
      mkosi.extra/usr/lib/signage/signage-web
  ```

  - `/tmp/fx/state` holds `content.json` and `packages/<id>/<version>/`.
  - `/tmp/fx/share` links `player`, `host` and `packages` to the checkout,
    and has a `status/` folder with a `status.json`.
  - Open `http://127.0.0.1:8099/player/` and edit `content.json` while it
    runs. Change `rev` each time.
