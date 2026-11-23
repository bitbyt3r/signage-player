# MAGFest schedule (OGraf graphic)

A full-screen schedule from [MAGSched](https://schedule.magfest.net)
(`/sessions`, `/locations`, `/tracks`), styled for Super MAGFest 2027.

- **Rooms set:** the session on now in each room, with a progress bar and
  time left, what's up next (with a countdown), and a "Later" list of what
  follows in those rooms. One room gets a large card with the description;
  two to four rooms get a card each; more than four page through, four at a
  time.
- **No rooms:** the schedule by itself: sessions in progress (marked NOW,
  with a progress bar) and then everything starting in the next few hours,
  in one or two columns depending on the screen, paging when it doesn't fit.

It fits any resolution and switches to a stacked layout on portrait screens.

## Super MAGFest 2027 theme (default)

Built from the theme team's Asset Pack 01 and style guide. The art in
`assets/` is used as is, only cropped and scaled:

| File | From the pack |
|---|---|
| `background-crest-fabric.png` | Backgrounds & Wallpapers/Background-Crest-Fabric.png |
| `logo-flat.png` | Logos/FLAT LOGO/DEFAULT-Logo-Flat-Red-WhiteText-Border-NoShadow.png (the style guide's default) |
| `heading-box-long.png` | Background_WWMenu-Heading_Box_Long.png (room name tags) |
| `context-box.png` | Background_WWMenu-Context_Box.png (the clock) |
| `squarewave-brown-tile.png` | SquarewavePattern-Brown-Single (divider) |
| `heart-full.png`, `heart-half.png` | HUD-Hearts.png: the time left in the current session, as ten hearts |
| `trihard.png` | Icon-Trihard-Render-Glow-Shadow-NoBackground.png (sessions on now) |
| `HyliaSerifBeta-Regular.otf`, `NotoSans-Variable.ttf` | Fonts/ (headings and body, as the style guide says) |

Colours are the style guide's theme colours (gold #E4BC60, greens #2F9445 and
#0E5135, brown #301E12). The guide's sub-heading font, Chiaro, isn't in the
pack, so sub-headings use Hylia Serif. Animations: the logo pops in, the
divider draws out and the cards rise in order; the last full heart beats
and the Trihards glint. `"theme": "plain"` gives
the dark version without the art.

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
| `theme` | `super2027` | `super2027` or `plain`. |
| `accent`, `background` | `""` | Override the theme's colours. With `plain`, a transparent background shows the layers behind. |
| `apiBase` | `https://schedule.magfest.net` | Schedule server. |
| `refreshSeconds` | `120` | How often to fetch (at least 30). |
| `qrUrl` | `""` | Optional. Shows a QR code from this URL in a frame to the right of the clock (the clock slides over to make room). See below. |
| `qrSeconds` | `30` | How often to fetch `qrUrl` (at least 5). |

In the manifest, `rooms`, `tracks` and `excludeTracks` carry
`"x-signage-options": {"source": "schedule", "list": "locations" | "tracks", "baseParam": "apiBase"}`,
so the dashboard can offer the names from `<apiBase>/locations` or `/tracks`
as a searchable multi-select (free text still works). `accent` and
`background` have `"format": "color"`.

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

## QR code

For games: set `qrUrl` and a QR code appears to the right of the clock,
fetched again every `qrSeconds`. The URL can return:

- an image (`image/png`, `image/svg+xml`, ...), shown as is;
- text, such as the link the code should open, which is turned into a QR
  code on the sign (`vendor/qrcode.mjs`, qrcode-generator, MIT);
- JSON: a string, or an object with a `qr`, `url`, `text`, `data` or `value`
  field holding text, a `data:image/...` URL or SVG.

Text and JSON need the server to send CORS headers
(`Access-Control-Allow-Origin: *`); an image works without them. The code
cross-fades when it changes. The last good code is kept in `localStorage`, so
it stays up when the URL can't be reached (failed fetches retry after 5 s,
10 s, 20 s ... up to `qrSeconds`). Clearing `qrUrl` slides the frame away.
`refresh` also fetches the QR code.

## OGraf

Real-time only, one step. `playAction` fades the frame in and slides the
header and cards up (about 1.4 s); `stopAction` fades them out (about
0.7 s), so a layer can animate one graphic out and the next in.
`updateAction` takes new settings and cross-fades. Inside the graphic,
changes (a session ending, the next page) cross-fade the part that changed.
Custom action `refresh` fetches the schedule (and the QR code) now.

## Packaging

The theme art in `assets/` is not in git (the repo is public and the art
belongs to the MAGFest theme team). Keep a copy locally, from the asset
pack, or unzip a released package. Without it, use `"theme": "plain"`.
The `assets/` folder is git-ignored. The zip built by CI has no art, so upload the
one built locally.


`scripts/package-ograf.sh` writes `dist/ograf/magfest-schedule-<version>.zip`
for the dashboard's Packages page. Bump `version` in the manifest for each
upload (versions are immutable on the dashboard). The image also bakes the
package into `/usr/share/signage/packages/`, so the demo host can preview it:
`http://127.0.0.1:8080/host/?graphic=/packages/magfest-schedule/magfest-schedule.ograf.json&hold=600000`.
