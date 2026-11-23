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
| `display.mjs` | the display layout: an ordinary screen, or the arch canvas sliced to the LED controller |
| `layouts.mjs` | the geometry table for sliced layouts (also read by `scripts/ograf-preview.html`) |
| `perf.mjs` | frame timing stats and what was on screen, posted to signage-web every 5 s |
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
| `/status/perf.json` | the player's last frame timing summary (below), read-only |
| `POST /perf` | the player's frame timing summary; the only thing `signage-web` writes |
| `/status/display.json` | `signage-config`'s display settings, including `layout` (`/run/signage/display.json`) |
| `/player/`, `/host/` | `/usr/share/signage/` |

Nothing else under `/var/lib/signage` is served (`config.toml` has the
WiFi passwords). The only write is `POST /perf` (below).

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

## Display layouts

`[display] layout` in `config.toml` (or the dashboard's device settings)
picks how the page maps onto the video output. `signage-config` writes it
to `/run/signage/display.json`, and the kiosk links that into `/status/`.

- `screen` (the default, or empty): an ordinary monitor. The canvas is
  the viewport.
- `arch`: the entrance arch's LED wall. The header and both legs are one
  picture, a 2760x2565 canvas, which the player cuts up into the
  3840x2160 map the LED controller takes. `signage-config` sets
  `display.mode = "3840x2160"` unless a mode is given.

The player reads `display.json` when it starts and on every poll (2 s). If
the layout changes, it reloads the page. `?layout=screen` or
`?layout=arch` overrides the file, for testing on a desktop. `?debug=1`
outlines and labels the regions on the canvas.

### The arch

Every cabinet is 240x135 px, so the pixel pitch is the same everywhere and
the legs sit directly under the header's outer ends. On the canvas:

| Region | Canvas `[x, y, w, h]` | Output position |
|---|---|---|
| header (11.5 x 7 cabinets) | `[0, 0, 2760, 945]` | `(0, 0)` |
| left leg (1.5 x 12) | `[0, 945, 360, 1620]` | `(2760, 0)` |
| right leg (2 x 12) | `[2280, 945, 480, 1620]` | `(3120, 0)` |
| door opening (not shown) | `[360, 945, 1920, 1620]` | — |

Both strips are upright, and the rest of the output is black. The numbers
live in one table, `player/layouts.mjs`.

How it's drawn:

- `#layers`, the canvas every layer renders into, is fixed at 2760x2565 at
  the top left of the output. The header's output position is its canvas
  position, so it needs no copy.
- Each leg is a div at its output position with
  `background: -moz-element(#layers)`, offset to the leg's rect. Firefox
  paints the canvas into it as an image, including the part below the
  2160 px viewport, and repaints it as the canvas animates. Graphics run
  and lay out once.
- A black mask covers the canvas outside the header on the output.
- The status screen and the update bar go in the header, sized as if it
  were a 16:9 screen of the header's height.

Checked in Firefox ESR 153 headless at 3840x2160 with a test pattern of the
cabinet grid: the strips show rows 7-18 of the legs, down to the canvas
bottom, and follow an animation. `docs/arch/arch-debug.png` is that test
with `?debug=1`, `docs/arch/arch-status.png` the status screen and update
bar.

### What graphics get

`load()` gets `renderCharacteristics.resolution` = the canvas size
(2760x2565 on the arch). Before any graphic loads, the player sets
`globalThis.signageDisplay`:

```js
{
  layout: "arch",            // or "screen"
  width: 2760, height: 2565, // the canvas
  regions: {                 // [x, y, w, h] on the canvas
    header: [0, 0, 2760, 945],
    left: [0, 945, 360, 1620],
    right: [2280, 945, 480, 1620],
  },
  visible: [[0, 0, 2760, 945], [0, 945, 360, 1620], [2280, 945, 480, 1620]],
}
```

On a screen it's `{layout: "screen", width, height, regions: {screen:
[0, 0, w, h]}, visible: [[0, 0, w, h]]}` with the viewport size.

`#layers` also has `data-layout="arch"` and the custom properties
`--canvas-w`, `--canvas-h` and `--<region>-w` / `--<region>-h` (for example
`--header-h`, `--left-w`, `--right-w`). They're inherited into a graphic's
shadow DOM, so its CSS can use them. Each layer's container fills the
canvas, so `vw` and `vh` in a graphic still mean the 3840x2160 viewport.
Use `%` of the host, or the properties above, instead.

To design for the arch, open `scripts/ograf-preview.html?layout=arch`. It
renders the graphic on the canvas with the door opening hatched, and can
show the sliced output (in Firefox).

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

## Performance stats

`perf.mjs` runs a `requestAnimationFrame` loop for the page's lifetime and
records each frame interval in a preallocated ring (no allocation per
frame; nothing is measured while the page is hidden). About every 5 s it
summarises the frames since the last summary and POSTs it to `/perf`,
fire and forget. Errors never reach the player.

`signage-web` accepts `POST /perf` from 127.0.0.1 only, up to 4 KB, and only
a JSON object with the fields below (anything else is a 400). It writes the
body atomically to `/run/signage-web/perf.json` (mode 0644) and answers
204. signage-web runs as a systemd `DynamicUser`, so that's its
`RuntimeDirectory`; `tmpfiles.d/signage.conf` links it as
`/run/signage/perf.json`, which is where the dashboard agent reads it. The
agent ignores a file whose `t` is more than 30 s old, and samples CPU,
memory and temperatures itself. `/status/perf.json` shows the latest
summary, for testing.

```jsonc
{
  "t": 1795427012.547,        // unix seconds when the window ended
  "window": 5,                // seconds of frames covered
  "frames": 300,
  "fps": 60,                  // frames / window
  "frame_ms": {"p50": 16.7, "p95": 16.8, "p99": 17.3, "max": 17.5},
  "long_frames": 0,           // frames over 50 ms
  "renderer": "firefox-esr 153.0",
  "layout": "screen",         // or "arch"
  "active": [                 // what was on screen during the window
    {"layer": 20, "layer_name": "Lower thirds", "package": "magfest-lower-third",
     "version": "1.1.0", "label": "Main stage", "from": 1795427007.543, "to": null},
    {"layer": -1, "layer_name": "status", "package": "status-screen",
     "from": 1795427007.543, "to": 1795427009.1}
  ]
}
```

Any field may be missing (an empty window has only `window: 0` and
`frames: 0`).

`active` has one entry per graphic per layer that was visible at any point
in the window, so the dashboard can show what was playing at a point on
its frame-time chart:

- A graphic counts as visible from when its `playAction()` resolves until
  its `stopAction()` starts.
- `layer` is the program's numeric layer, `layer_name` its name. The status
  screen is `{"layer": -1, "layer_name": "status", "package":
  "status-screen"}` while it shows.
- `from` is clipped to the window's start. `to` is when it went away, or
  `null` if it's still showing.
- `label` is the item's label, left out when there is none.
- Front layer (highest `layer`) first, at most 32 entries. If the body
  would be over 4 KB, back-layer entries are dropped.

Checked in Firefox ESR 153 headless with the demo program for 35 s:
`perf.json` was rewritten every 5 s, with 300 frames per window at 60 fps,
p50 16.7 ms, p99 at most 17.4 ms and no long frames. The first window
listed the status screen's 8 ms before the demo lower third started.

## Profiling

Two tools for the dashboard's web terminal (both run as root and are on
`PATH`).

### signage-gfx

A quick look at how the player renders:

- **GPU**: from `lspci`, or `/sys/class/drm/card*/device` when lspci isn't
  installed (vendor, device ID, kernel driver).
- **Firefox rendering**: which Mesa driver Firefox's processes have mapped
  (`/proc/<pid>/maps`):
  - `WebRender/GL: HARDWARE (radeonsi)`: WebRender draws with the AMD GPU.
    This is what a sign should show.
  - `WebRender/GL: SOFTWARE (llvmpipe/swrast)`: Mesa's CPU rasteriser, so
    the GPU isn't being used (no `/dev/dri` access, a missing driver, or a
    blocklisted GPU). Expect high CPU and dropped frames.
  - `SOFTWARE (no Mesa driver mapped: ...)`: Firefox fell back to its own
    software WebRender, the same problem as above.
- **Player**: the renderer and the last frame stats from
  `/run/signage/perf.json`, and what's on screen. The renderer string
  comes from WebGL's `WEBGL_debug_renderer_info` on a throwaway canvas at
  page start: `firefox-esr 153.0 / AMD Radeon Graphics (radeonsi, ...)` on
  the GPU, `... / llvmpipe (LLVM ...)` in software, `no WebGL` when
  there's no GL at all (headless Firefox, for example). The dashboard shows
  it too.
- **GPU load and temperatures**: `gpu_busy_percent` and the amdgpu,
  k10temp, coretemp, acpitz and nvme hwmon sensors.
- **radeontop**: a 5 s sample (`radeontop -d - -l 5`) of the GPU's
  pipeline blocks. amdgpu_top isn't packaged in trixie, so it isn't
  included.

### signage-profile [SECONDS]

Records a Firefox profile of the running player (default 30 s), to see
where frame time goes. Firefox isn't restarted:

1. The kiosk always starts Firefox with `MOZ_UPLOAD_DIR=/var/lib/signage/profiles/.dump`.
   That costs nothing: the profiler isn't running.
2. signage-profile sends the player's Firefox **SIGUSR1**, which starts the
   Gecko profiler, waits SECONDS, then sends **SIGUSR2**, which stops it,
   gathers the parent and every child process (the page itself runs in a
   content process) and writes `profile_0_<pid>.json` to `MOZ_UPLOAD_DIR`.
3. Once that file is complete JSON it is gzipped to
   `/var/lib/signage/profiles/profile-<host>-<YYYYmmddTHHMMSSZ>.json.gz`;
   the newest 5 are kept (never deleting the new one) and the path, size
   and number of content processes are printed. It warns if no content
   process made it into the profile.

Firefox ESR 153 starts the signal profiler with fixed settings and ignores
`MOZ_PROFILER_STARTUP_*`: features js, stackwalk and cpu, all threads,
1 ms interval, 64M-entry buffer. In particular there are no screenshots
(the `graphics` preset used before captured a full 4K frame per composite,
which cost GPU time itself and skewed the result).

It exits 0 only when a complete profile was written, and otherwise exits
non-zero saying why (Firefox not running, Firefox started by an older kiosk
without `MOZ_UPLOAD_DIR`: restart the player once, or "NO PROFILE WRITTEN:
..."). The dashboard agent relies on that when it runs it for the
dashboard's GPU profile button and uploads the file. To read it, open
https://profiler.firefox.com and choose "Load a profile from file". The
`.json.gz` loads as is.

In the profile, check the renderer and compositor threads (`Renderer`,
`WRRenderBackend`, `WRSceneBuilder`) for how long each frame takes to draw,
and the content process's `GeckoMain` (the tab whose name is the player's
URL origin) for script, style and layout work.

Checked in Firefox ESR 153 headless on a page with a JS-heavy
requestAnimationFrame loop, with the test overrides `SIGNAGE_PROFILE_USER`
and `SIGNAGE_PROFILE_DIR`. An 8 s run exited 0 in 10 s with a 6.6 MB
`.json.gz` holding 7 content processes, the page's own JS function and no
screenshots; a second run against the same Firefox worked too. It pruned 6
older files down to 4 plus the new one. With no Firefox running, or a
`MOZ_UPLOAD_DIR` other than `<dir>/.dump`, it exited 1 with a clear
message and left no file.

## Testing

- Unit tests: `node --test tests/player/` (eligibility, and the perf
  summary and `active` list)
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
