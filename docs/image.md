# The OS image

One mkosi image (Debian trixie, x86_64) does two jobs.

**Install stick.** Flash `signage_<version>.raw` to a USB stick. It holds:

| Partition | What |
|---|---|
| ESP (FAT, 512M) | shim, systemd-boot, MokManager, the signed UKI and our MOK certificates ([secure-boot.md](secure-boot.md)) |
| `signage_usr_<v>` (erofs) + `signage_verity_<v>` | read-only `/usr`, checked by dm-verity (`usrhash=` is on the UKI's command line) |
| `root` (ext4, 1G) | `/etc` from the image, empty `/var` |
| `SIGNCFG` (FAT32, 256M) | `config.toml` and a README; edit it on any computer |

Booted from the stick, `signage-mode` sees a `SIGNCFG` partition on the boot
disk and `signage-install.service` takes over tty1: it checks `config.toml`,
picks the internal disk, counts down (any key cancels), then writes:

| Partition | What |
|---|---|
| ESP 512M | copied from the stick |
| usr A 4G + verity A 128M | copied from the stick, same UUIDs (usrhash finds `/usr` by UUID) |
| usr B 4G + verity B 128M | empty (`_empty`), for systemd-sysupdate |
| root (ext4, rest of disk) | `/etc` from `/usr/share/factory/etc`, `config.toml` in `/var/lib/signage/` |

It queues our Secure Boot certificates with `mokutil` (confirmed in
MokManager on the next boot), adds a "Signage" firmware boot entry pointing
at shim, makes it first and the next boot, and reboots. The stick can be pulled at any point after that.

**Installed player.** `signage-config.service` reads
`/var/lib/signage/config.toml` (plus `overrides.toml`, which the dashboard
will write), sets the hostname, time zone, NetworkManager profiles (wired
DHCP at route metric 100, each WiFi network at 600, so wired wins when
plugged in) and chrony sources, and writes `/run/signage/display.json`.
`signage-player.service` runs cage on tty1 as the `signage` user; `kiosk`
applies resolution/rotation with `wlr-randr` and starts Firefox ESR in kiosk
mode on `http://127.0.0.1:8080/player/`, the player page (served by
`signage-web.service`, since Firefox won't import ES modules over
`file://`). It plays the program the dashboard assigned, from
`/var/lib/signage/content.json`, and shows a status screen when there is
nothing to play. See [player.md](player.md).

**Demo graphic.** With `[player] demo = true` in `config.toml`, the player
plays the demo lower third (`mkosi.extra/usr/share/signage/packages/demo-lower-third/`,
installed at `/usr/share/signage/packages/`) instead of the status screen while no
program is assigned. `/usr/share/signage/host/` is a minimal OGraf preview
page: it loads the manifest named by `?graphic=` and loops play (hold 6 s),
stop, pause 2 s, with the device status in a corner overlay.

**Updates.** `systemd-sysupdate` (from `systemd-container`) with `/usr/lib/sysupdate.d/` pulls new `/usr` + verity + UKI from the
latest GitHub release into the B slot; the UKI gets 3 boot tries before
systemd-boot falls back. Tested end to end in QEMU (A → B, see
[player.md](player.md) for the on-screen progress bar).

## Building

```bash
scripts/build.sh                    # mkosi.output/signage_<version>.raw
scripts/build.sh --profile=debug    # + serial console, root shell on tty2/ttyS0
scripts/qemu-test.sh                # QEMU: image as USB stick + empty NVMe
scripts/qemu-test.sh --boot-disk    # boot the installed NVMe disk again
scripts/qemu-test.sh --secure-boot  # OVMF with Secure Boot on and Microsoft keys
scripts/utm-test.sh                 # same in UTM (AppleScript; less tested)
```

`qemu-test.sh` gives a serial console on stdio (the debug build logs root in
there) and the screen on VNC display :1; `--headless` puts the console and the
QEMU monitor on unix sockets instead, for scripted runs. On macOS it runs in
the `signage-build` OrbStack machine, so x86_64 is emulated (TCG): the stick
reaches the installer in about 45 s and Firefox in about a minute.

CI (`.github/workflows/image.yml`) builds a release image on every push.
Pushing a tag `vX.Y.Z` publishes a GitHub release with the compressed stick
image, the `/usr` and verity partitions and the UKI, which is what
`/usr/lib/sysupdate.d/` pulls from.

On macOS the build runs in an x86_64 OrbStack machine (`signage-build`).

## Size

`/usr` is erofs, lzma level 6 in 256 KiB clusters (`mkosi.repart/10-usr.conf`),
and `scripts/trim-image.py` drops what players never use: kernel modules for
capture cards, InfiniBand, other GPUs, SoC audio, IIO, ISDN/CAN, staging and
non-Intel/Realtek WiFi (keeping anything a kept module depends on), older
iwlwifi firmware versions, Intel Bluetooth firmware, non-English
translations and Firefox's crash reporter. Debian's `/boot/vmlinuz` copy is
removed so it doesn't sit on the ESP.

| | Before | After |
|---|---|---|
| `/usr` partition | 1.3 GB (1217 MiB of files, uncompressed) | 369 MiB (1087 MiB of files) |
| Stick image, allocated | ~1.4 GB | 434 MB |
| ESP | 69 MB | 58 MB |
| `raw.xz` download | 425 MB | 411 MiB |
| `usr…raw.xz` (update; was `.zst`) | 365 MB | ~352 MiB |

zstd decompresses faster than lzma, but compressed data doesn't recompress,
so zstd in erofs made the downloads about 60 MiB bigger; lzma is smaller on
disk and in the release.

## Known gaps

- `/etc` is written once at install. A `/usr` update that changes a file in
  `/etc` doesn't reach installed players (new system users do, through the
  generated `sysusers.d/00-image.conf`). Our own settings live in `/usr` or
  are generated at boot, so this only matters for Debian package defaults.
- With the stick still plugged in, the stick and the disk carry identical
  `/usr` partitions (same UUIDs). Both have the same content, so it works,
  but pull the stick after installing.
