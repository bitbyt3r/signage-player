# MAGFest schedule (OGraf graphic)

A full-screen schedule from [MAGSched](https://schedule.magfest.net)
(`/sessions`, `/locations`, `/tracks`).

- **Rooms set:** the session on now in each room, with a progress bar and
  time left, what's up next (with a countdown), and a "Later" list of what
  follows in those rooms. One room gets a large card with the description;
  two to four rooms get a card each; more than four page through, four at a
  time.
- **No rooms:** the schedule by itself: sessions in progress (marked NOW,
  with a progress bar) and then everything starting in the next few hours,
  in one or two columns depending on the screen, paging when it doesn't fit.

It fits any resolution and switches to a stacked layout on portrait screens.

## Settings (the dashboard's *Graphic data*)

```json
{
  "rooms": ["Panels 1", "Panels 2"],
  "tracks": ["Panels"],
  "excludeTracks": [],
  "abbreviate": 30
}
```

| Key | Default | |
|---|---|---|
| `rooms` | `[]` | Room names as on the schedule (`"Panels 1 (Cherry Blossom Ballroom)"`), the name without the brackets (`"Panels 1"`), or location IDs; case doesn't matter. Empty shows the whole schedule. Unknown names show a warning under the clock. |
| `tracks` | `[]` | Only sessions in at least one of these tracks (names or IDs). |
| `excludeTracks` | `[]` | Hide sessions in any of these tracks. |
| `abbreviate` | `0` | Shorten names in the lists to this many characters, at a word boundary, with "…". 0 = no limit (names are still cut to fit the line). |
| `title` | `""` | Heading. Empty: the room name, "Now and next" for several rooms, "Schedule" for none. |
| `lookaheadHours` | `3` | Schedule view: how far ahead to list. |
| `maxDuration` | `180` | Schedule view: leave out sessions in progress longer than this many minutes (free play, open rooms). 0 shows all. |
| `pageSeconds` | `12` | Time per page. |
| `showDescription` | `true` | Description on the single-room card. |
| `clock24` | `false` | 24-hour times. |
| `timeZone` | `""` | IANA zone; empty uses the player's. |
| `accent`, `background` | `#e4405f`, `#0e1218` | Colours. A transparent background shows the layers behind. |
| `apiBase` | `https://schedule.magfest.net` | Schedule server. |
| `refreshSeconds` | `120` | How often to fetch (at least 30). |

## Offline

The whole schedule (about 280 KB gzipped) is fetched every `refreshSeconds`
and kept in the browser's `localStorage` (the kiosk's Firefox profile is in
`/var/lib/signage/home`, so it survives reboots). When the server can't be
reached the graphic keeps running from that copy, the clock, progress bars
and "now/next" keep moving, and an "Offline · schedule as of …" note shows
under the clock. Failed fetches retry after 15 s, 30 s, 60 s … up to the
refresh interval. An empty response from a server that had sessions before
is treated as an error, so the cache isn't wiped. All graphics on the page
share one copy and one fetch.

## OGraf

Real-time only, one step. `playAction` fades the frame in and slides the
header and cards up (about 1.3 s); `stopAction` fades them out (about
0.7 s), so a layer can animate one graphic out and the next in.
`updateAction` takes new settings and cross-fades. Inside the graphic,
changes (a session ending, the next page) cross-fade the part that changed.
Custom action `refresh` fetches the schedule now.

## Packaging

`scripts/package-ograf.sh` writes `dist/ograf/magfest-schedule-<version>.zip`
for the dashboard's Packages page. Bump `version` in the manifest for each
upload (versions are immutable on the dashboard). The image also bakes the
package into `/usr/share/signage/packages/`, so the demo host can preview it:
`http://127.0.0.1:8080/host/?graphic=/packages/magfest-schedule/magfest-schedule.ograf.json&hold=600000`.
