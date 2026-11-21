#!/bin/bash
# Build the image. On Linux, runs mkosi directly (needs root). On macOS,
# runs it in a Debian trixie OrbStack machine called signage-build. The machine
# uses the Mac's native architecture: mkosi's sandbox needs mount_setattr(),
# which Rosetta doesn't implement, so an amd64 machine can't run mkosi. mkosi
# still builds an x86-64 image; foreign binaries in the image's postinst run
# through OrbStack's Rosetta binfmt handler.
#
#   scripts/build.sh              # release-style build
#   scripts/build.sh --profile=debug   # serial console + root shell on tty2
#
# Output: mkosi.output/signage_<version>.raw (flash this to USB) plus the
# split /usr, verity and UKI files that updates use.
set -euo pipefail
cd "$(dirname "$0")/.."

# GPT labels max out at 36 characters ("signage_verity_" + version), so keep
# the version short.
VERSION=${VERSION:-$(cat mkosi.version).$(date -u +%y%m%d%H%M)}
ARGS=(--image-version="$VERSION" --workspace-dir=/var/tmp/mkosi-ws --cache-dir=/var/cache/mkosi "$@" -f build)

if [[ $(uname) == Darwin ]]; then
    command -v orb >/dev/null || { echo "Install OrbStack (https://orbstack.dev) first." >&2; exit 1; }
    M=signage-build
    if ! orb list | awk '{print $1}' | grep -qx "$M"; then
        orb create debian:trixie "$M"
    fi
    # mkosi 25.3's default tools tree asks for grub-pc-bin, which doesn't
    # exist on arm64, so use the machine's own tools instead.
    TOOLS="mkosi apt dpkg debian-archive-keyring erofs-utils mtools dosfstools e2fsprogs"
    TOOLS+=" systemd-repart systemd-ukify python3-pefile cryptsetup-bin zstd"
    orb -m "$M" -u root bash -c "dpkg -s $TOOLS >/dev/null 2>&1 || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y $TOOLS; }"
    ARGS=(--tools-tree= "${ARGS[@]}")
    orb -m "$M" -u root mkdir -p /var/tmp/mkosi-ws /var/cache/mkosi
    # macOS ships bash 3.2, which has no ${var@Q}; quote with printf %q.
    exec orb -m "$M" -u root bash -c "cd $(printf %q "$PWD") && mkosi $(printf '%q ' "${ARGS[@]}")"
fi

sudo mkdir -p /var/tmp/mkosi-ws /var/cache/mkosi
exec sudo mkosi "${ARGS[@]}"
