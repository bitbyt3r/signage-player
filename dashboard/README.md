# Signage dashboard

The central dashboard for the signage players: devices check in, you change
their settings, assign OGraf graphics to layers, schedule how they rotate,
take screenshots, open a root terminal in the browser, manage OGraf package
versions, and download pre-configured install images.

It runs entirely on AWS serverless pieces, so there is no server to look
after:

```
 browser ──HTTPS──▶ API Gateway (HTTP API) ──▶ Lambda  app.py ──▶ DynamoDB (one table)
 player  ──HTTPS──▶        same URL          ─┘          │      └▶ S3 (packages, screenshots, images)
 browser ◀──WSS──▶ API Gateway (WebSocket) ──▶ Lambda  ws.py      (terminal relay)
 player  ◀──WSS──▶        same URL          ─┘
                                               Lambda  mirror.py  (copies a GitHub release's image to S3)
```

The web UI is plain HTML/JS served by the same Lambda, so there is one URL
and no build step.

## Deploy

You need an AWS account and, on your Mac:

```bash
brew install awscli aws-sam-cli
aws configure          # or aws sso login; any credentials that can create stacks
```

Then, from this directory:

```bash
cd dashboard
sam deploy --guided
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `signage-dashboard` |
| AWS Region | the one closest to the venue, e.g. `us-east-1` |
| Parameter AdminPassword | the dashboard password (12+ characters) |
| Parameter EnrollToken | a long random string, e.g. the output of `openssl rand -hex 24`. It goes onto install sticks; anyone with it can enroll a device. |
| Parameter GitHubRepo | `bitbyt3r/signage-player` (enables the Install images page) |
| Parameter GitHubToken | a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for that repo with **Contents: Read-only**. Needed because the repo is private. |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| ApiFunction has no authentication. Is this okay? | `y` (the app checks the password and device tokens itself) |
| Save arguments to configuration file | `y` |

It takes about two minutes. The last lines print the outputs:

```
Key     DashboardUrl
Value   https://abc123.execute-api.us-east-1.amazonaws.com
```

Open `DashboardUrl` and log in with the AdminPassword.

**Later deploys** (after pulling changes): `sam deploy` in this directory. It
reuses the answers saved in `samconfig.toml`. That file holds your secrets,
so it is git-ignored; keep a copy somewhere safe or pass them again with
`sam deploy --parameter-overrides AdminPassword=... EnrollToken=... GitHubToken=...`.

**Changing the password or tokens:** `sam deploy --guided` again and type new
values. Changing EnrollToken doesn't affect enrolled players (they hold
their own device token), only new sticks.

**Removing it:** `sam delete`. The DynamoDB table and S3 bucket are kept on
purpose (`DeletionPolicy: Retain`); delete them in the console if you really
want the data gone.

### Getting players onto it

Either:

- **Install images page** (easiest): pick a release, click *Copy to
  dashboard* once per release (it streams the image from GitHub into S3,
  about a minute), fill in WiFi and display settings, and click *Download
  pre-configured image*. The `.img` has `config.toml` (with this dashboard's
  URL and the enroll token) already in its FAT32 partition. Flash it with
  balenaEtcher, Raspberry Pi Imager or `dd`. The download is built in your
  browser chunk by chunk and written straight to disk, so it never sits in
  memory. Chrome and Edge ask where to save it; Firefox and Safari save it as
  a normal download.
- **By hand**: flash a release image, open the `SIGNCFG` drive on any
  computer, and set in `config.toml`:

  ```toml
  [dashboard]
  url = "https://abc123.execute-api.us-east-1.amazonaws.com"
  enroll_token = "the EnrollToken you deployed with"
  ```

Players enroll on first boot after install and show up on the Devices page.

### Custom domain (optional)

In API Gateway, add a custom domain (with an ACM certificate) mapped to the
HTTP API, and point a DNS name at it. Use that name in `config.toml`. The
terminal WebSocket keeps its own `execute-api` URL; that's fine.

### Cost

Pay-per-use only. Each player checks in every 15 seconds (every 3 while
someone has its page open). At that rate a player costs roughly $0.50 a
month in API Gateway, Lambda and DynamoDB while powered on, and nothing while
off. Install images take S3 storage (a few cents per release per month) and
data transfer when downloaded. The interval is `POLL` in `src/app.py`.

## Using it

- **Devices**: everything that has checked in. Green dot = checked in within
  a minute. *Clock* is the device clock minus the dashboard's, measured at
  check-in (so it includes network latency); the device page also shows
  chrony's own offset and source. Select several to assign a program or
  reboot them together.
- **Device page**: screenshot, terminal, restart player, re-sync content, OS
  update, reboot; settings; status; command history. Settings left blank
  keep the stick's `config.toml` value. Saved settings are checked with the
  same rules as the device's `signage-config`, and the device checks them
  again before applying. If a network change means the device can't reach
  the dashboard for 5 minutes, it restores the previous settings and says so
  on its page.
- **Programs**: a program is a stack of layers. Each layer plays its
  graphics in order for their duration (0 = stay until replaced), animating
  the current one out before the next one in. Graphics can be limited to
  days of the week, a time of day window, and a date range. *Graphic data* is
  passed to the OGraf graphic; *Fill defaults from schema* uses the defaults
  in the graphic's manifest.
- **Packages**: upload an OGraf graphic as a zip (its `*.ograf.json` manifest
  plus files). Versions are immutable. Programs use the package's *active*
  version unless an item pins one, so *Make active* rolls a version out to
  every device, and switching back rolls it back. Versions that are active
  or pinned can't be deleted.
- **Terminal**: a root shell on the device, in the browser. The device opens
  the connection when asked (within a few seconds while you have its page
  open), so it works behind NAT. Close it with *Close* or `exit`.

## Development

```bash
pip install boto3 "moto[server,dynamodb,s3]" pytest websockets
pytest tests/                                  # API, agent end to end, release mirror
python3 scripts/dev_server.py                  # http://127.0.0.1:8000, password dev-password-123
python3 scripts/dev_server.py --fake-release some-disk.raw   # also offer it on Install images
```

The dev server runs the real Lambda code against moto (fake DynamoDB and
S3). The terminal relay isn't emulated locally. `tests/test_agent_e2e.py`
runs the real device agent against it and checks its overrides with the
image's own `signage-config --check`.

## The device side

`agent/signage-agent` (Python, standard library only) and
`agent/signage-agent.service` are built into the OS image. The agent runs as
root and:

1. Reads `[dashboard] url` and `enroll_token` from
   `/var/lib/signage/config.toml`, enrolls (`POST /device/enroll`, keyed by
   the wired MAC, so a reinstalled player keeps its settings), and keeps its
   device token in `/var/lib/signage/agent/identity.json`.
2. Checks in (`POST /device/checkin`) with its status and the results of
   commands it ran, and gets back settings, content and commands.
3. Writes dashboard settings to `/var/lib/signage/overrides.toml` (after
   `signage-config --check` on the merged config), runs
   `signage-config --reload`, and restarts the player when display settings
   changed.
4. Downloads OGraf packages (checking SHA-256), unpacks them to
   `/var/lib/signage/packages/<id>/<version>/`, then atomically writes
   `/var/lib/signage/content.json`. Unused versions are removed. Everything
   the player needs is local, so playback continues through network loss.
5. Runs commands: `reboot`, `restart-player`, `screenshot` (grim, uploaded
   straight to S3), `terminal` (a PTY over the WebSocket relay), `os-update`
   (`systemd-sysupdate update [version]`, then reboot), `resync`.

### content.json (what the player reads)

```jsonc
{
  "rev": "2ef57421b35e1421",        // changes whenever anything below changes
  "generation": 4,                  // increments on every write
  "written": 1795409430.8,
  "program": {"id": "b1961037e6", "name": "Main Stage"},   // null if none assigned
  "layers": [
    {
      "name": "Lower thirds",
      "layer": 20,                  // higher is in front
      "items": [                    // play in order, then loop
        {
          "package": "magfest-lower-third",
          "version": "1.1.0",
          "path": "/var/lib/signage/packages/magfest-lower-third/1.1.0",
          "url": "/packages/magfest-lower-third/1.1.0/",   // as served by signage-web
          "manifest": "lower-third.ograf.json",            // relative to path/url
          "main": "lower-third.mjs",                       // the graphic's module, relative
          "duration": 15,           // seconds; 0 = stay until replaced
          "data": {"name": "Welcome"},                     // for the graphic's load/updateAction
          "label": "Welcome",       // optional
          "days": [4, 5, 6],        // optional, 0 = Monday
          "start": "10:00",         // optional, local time of day
          "end": "22:00",           // optional
          "from": "2027-01-08T00:00",  // optional, local date and time
          "until": "2027-01-11T18:00"  // optional
        }
      ]
    }
  ],
  "packages": [{"id": "...", "version": "...", "sha256": "...", "size": 1234, "root": "lt/"}],
  "warnings": []                    // e.g. a program item whose package was deleted
}
```

An item is eligible when today is in `days` (or `days` is empty), the time
of day is within `start`–`end` (an `end` before `start` wraps past
midnight), and now is within `from`–`until`. A layer with no eligible items
shows nothing.

## Security notes

- One shared admin password; sessions are signed tokens valid for 12 hours.
  Anyone with it gets a root shell on every player, so make it long.
- Device tokens are random per device and stored hashed. Removing a device
  invalidates its token; it re-enrolls with the enroll token if it is still
  running.
- Screenshots, packages and images are in a private bucket and reached
  through short-lived presigned URLs.
