#!/usr/bin/python3
"""Drop parts of /usr that a signage player never uses. Runs inside the image
from mkosi.postinst.chroot, before mkosi runs depmod.

- Kernel modules for hardware we don't have (capture cards, InfiniBand,
  other GPUs, SoC audio, IIO sensors, ISDN/CAN, WiFi other than Intel,
  Realtek, Atheros/Qualcomm, MediaTek and Broadcom,
  staging). A module stays if anything we keep depends on it: amdgpu needs
  drivers/media/cec and rc-core, for example.
- iwlwifi firmware: only the newest API version of each chip. The kernel
  tries versions from its maximum downwards, so the newest file Debian ships
  is the one that loads; the older ones are for older kernels.
- Intel Bluetooth firmware (no Bluetooth on players).
- Translations other than English (the kiosk UI is English; Firefox's own
  strings live in omni.ja).
- Firefox's crash reporter and telemetry ping sender.
- Console fonts other than the two Terminus sizes signage-banner uses.
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "/")
removed_bytes = 0


def size(p: Path) -> int:
    if p.is_symlink() or p.is_file():
        return p.lstat().st_size
    return sum(f.lstat().st_size for f in p.rglob("*") if f.is_file() and not f.is_symlink())


def remove(p: Path) -> None:
    global removed_bytes
    if not (p.exists() or p.is_symlink()):
        return
    removed_bytes += size(p)
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    else:
        p.unlink()


def mib(n: int) -> str:
    return f"{n / 1048576:.1f} MiB"


# ---------------------------------------------------------------- modules

DROP_DIRS = [
    "drivers/media",
    "drivers/infiniband",
    "drivers/staging",
    "drivers/gpu/drm/i915",
    "drivers/gpu/drm/xe",
    "drivers/gpu/drm/nouveau",
    "drivers/gpu/drm/radeon",
    "sound/soc",
    "drivers/iio",
    "drivers/isdn",
    "drivers/net/can",
    "net/can",
]
KEEP_WIRELESS = {"intel", "realtek", "ath", "mediatek", "broadcom"}

for kdir in sorted((ROOT / "usr/lib/modules").glob("*/kernel")):
    base = kdir.parent
    deps: dict[str, list[str]] = {}
    for line in (base / "modules.dep").read_text().splitlines():
        mod, _, rest = line.partition(":")
        deps[mod] = rest.split()

    drop_prefixes = [f"kernel/{d}/" for d in DROP_DIRS]
    wireless = kdir / "drivers/net/wireless"
    if wireless.is_dir():
        drop_prefixes += [f"kernel/drivers/net/wireless/{d.name}"
                          + ("/" if d.is_dir() else "")
                          for d in wireless.iterdir() if d.name not in KEEP_WIRELESS]

    candidates = {m for m in deps if any(m.startswith(p) for p in drop_prefixes)}
    kept = set(deps) - candidates
    needed = set()
    for m in kept:
        needed.update(d for d in deps[m] if d in candidates)
    drop = candidates - needed

    before = removed_bytes
    for m in sorted(drop):
        remove(base / m)
    # Empty directories left behind.
    for d in sorted((p for p in kdir.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if not any(d.iterdir()):
            d.rmdir()
    print(f"trim: {base.name}: removed {len(drop)} modules ({mib(removed_bytes - before)}), "
          f"kept {len(needed)} that others depend on: "
          + ", ".join(sorted(Path(n).name.split('.')[0] for n in needed)))

# ---------------------------------------------------------------- firmware

fw = ROOT / "usr/lib/firmware"
before = removed_bytes
by_chip: dict[str, list[tuple[int, Path]]] = {}
for f in fw.glob("iwlwifi-*.ucode*"):
    m = re.fullmatch(r"(iwlwifi-.+)-(\d+)\.ucode(\.\w+)?", f.name)
    if m:
        by_chip.setdefault(m.group(1), []).append((int(m.group(2)), f))
for chip, files in by_chip.items():
    files.sort()
    for _, f in files[:-1]:
        remove(f)
print(f"trim: iwlwifi: kept the newest of {len(by_chip)} chips, removed {mib(removed_bytes - before)}")

before = removed_bytes
for f in (fw / "intel").glob("ibt-*"):
    remove(f)
print(f"trim: intel Bluetooth firmware: removed {mib(removed_bytes - before)}")

# ---------------------------------------------------------------- locales

before = removed_bytes
for d in (ROOT / "usr/share/locale").iterdir():
    if d.is_dir() and not (d.name == "C" or d.name.startswith(("C.", "en"))):
        remove(d)
print(f"trim: translations: removed {mib(removed_bytes - before)}")

# ---------------------------------------------------------------- console fonts

# console-setup-linux is only here for signage-banner's Terminus fonts.
before = removed_bytes
KEEP_FONTS = {"Uni3-Terminus24x12.psf.gz", "Uni3-Terminus32x16.psf.gz"}
fonts = ROOT / "usr/share/consolefonts"
if fonts.is_dir():
    for f in fonts.iterdir():
        if f.name not in KEEP_FONTS:
            remove(f)
print(f"trim: console fonts: removed {mib(removed_bytes - before)}")

# ---------------------------------------------------------------- firefox

before = removed_bytes
ff = ROOT / "usr/lib/firefox-esr"
for name in ("crashreporter", "crashhelper", "pingsender", "minidump-analyzer"):
    remove(ff / name)
print(f"trim: firefox crash reporter: removed {mib(removed_bytes - before)}")

print(f"trim: total {mib(removed_bytes)}")
