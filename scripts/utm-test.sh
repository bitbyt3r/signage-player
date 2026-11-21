#!/bin/bash
# Create a UTM VM that boots the freshly built image as a USB stick, with an
# empty 32 GB NVMe disk to install onto. x86_64 is emulated on Apple
# Silicon, so expect the first boot to take a few minutes.
#
#   scripts/utm-test.sh [image.raw]
set -euo pipefail
cd "$(dirname "$0")/.."

# The full disk image is signage_<version>.raw; the split partitions next to
# it (signage_<version>.usr-x86-64.raw, .esp.raw, ...) have an extra suffix.
IMG=${1:-$(ls -t mkosi.output/signage_*.raw 2>/dev/null | grep -E '/signage_[0-9.]+[0-9]\.raw$' | head -n1)}
[[ -f $IMG ]] || { echo "No image found; run scripts/build.sh first." >&2; exit 1; }
IMG=$(cd "$(dirname "$IMG")" && pwd)/$(basename "$IMG")
NAME=${NAME:-signage-test}

osascript - "$IMG" "$NAME" <<'APPLESCRIPT'
on run argv
    set img to POSIX file (item 1 of argv)
    set vmName to item 2 of argv
    tell application "UTM"
        try
            set old to virtual machine named vmName
            if status of old is not stopped then stop old by force
            delete old
        end try
        set vm to make new virtual machine with properties {backend:qemu, configuration:{name:vmName, architecture:"x86_64", memory:4096, cpu cores:4, hypervisor:false, uefi:true, drives:{{interface:USB, source:img, raw:true}, {interface:NVMe, guest size:32768}}, network interfaces:{{mode:shared}}, serial ports:{{interface:ptty}}}}
        start vm
        delay 2
        repeat with p in serial ports of vm
            log "Serial console: " & (address of p)
        end repeat
    end tell
end run
APPLESCRIPT
echo "Started UTM VM '$NAME' from $IMG"
