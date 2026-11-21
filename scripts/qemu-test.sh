#!/bin/bash
# Boot the built image in QEMU the way a player sees it: UEFI (OVMF), the
# image attached as a USB stick, and an empty 32 GB NVMe disk to install to.
# On macOS this runs inside the OrbStack machine that build.sh uses.
#
#   scripts/qemu-test.sh [options] [image.raw]
#
#   --boot-disk     boot the NVMe disk from the last run (no stick, no reset)
#   --headless      run in the background; serial console and QEMU monitor on
#                   unix sockets in $WORK (default: serial console on stdio,
#                   Ctrl-A X quits, Ctrl-A C toggles the monitor)
#
# The screen is always on VNC display :1 (port 5901). From a Mac, connect to
# vnc://signage-build.orb.local:5901. x86_64 runs under TCG emulation, so
# expect it to be several times slower than real hardware.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $(uname) == Darwin ]]; then
    M=signage-build
    orb list | awk '{print $1}' | grep -qx "$M" || { echo "Run scripts/build.sh first (it creates the $M machine)." >&2; exit 1; }
    PKGS="qemu-system-x86 qemu-utils ovmf socat"
    orb -m "$M" -u root bash -c "dpkg -s $PKGS >/dev/null 2>&1 || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS; }"
    exec orb -m "$M" -u root bash "$PWD/scripts/qemu-test.sh" "$@"
fi

WORK=${WORK:-/var/tmp/signage-qemu}
BOOT_DISK= HEADLESS=
while [[ $# -gt 0 ]]; do
    case $1 in
        --boot-disk) BOOT_DISK=1 ;;
        --headless) HEADLESS=1 ;;
        -*) echo "unknown option $1" >&2; exit 2 ;;
        *) break ;;
    esac
    shift
done

OVMF_CODE=/usr/share/OVMF/OVMF_CODE_4M.fd
OVMF_VARS=/usr/share/OVMF/OVMF_VARS_4M.fd
[[ -f $OVMF_CODE ]] || { echo "Install OVMF (apt install ovmf)." >&2; exit 1; }
mkdir -p "$WORK"

if [[ -z $BOOT_DISK ]]; then
    # The full disk image is signage_<version>.raw; the split partitions next
    # to it have an extra suffix (.usr-x86-64.raw, .esp.raw, ...).
    IMG=${1:-$(ls -t mkosi.output/signage_*.raw 2>/dev/null | grep -E '/signage_[0-9.]+[0-9]\.raw$' | head -n1)}
    [[ -f $IMG ]] || { echo "No image found; run scripts/build.sh first." >&2; exit 1; }
    echo "Stick: $IMG"
    cp --sparse=always "$IMG" "$WORK/stick.raw"
    rm -f "$WORK/nvme.qcow2"
    qemu-img create -q -f qcow2 "$WORK/nvme.qcow2" 32G
    cp "$OVMF_VARS" "$WORK/vars.fd"
    STICK=(-drive "if=none,id=stick,file=$WORK/stick.raw,format=raw"
           -device usb-storage,bus=xhci.0,drive=stick,removable=on)
else
    [[ -f $WORK/nvme.qcow2 ]] || { echo "No NVMe disk from an earlier run in $WORK." >&2; exit 1; }
    STICK=()
fi

ARGS=(
    -machine q35 -accel tcg,thread=multi -cpu max -smp 4 -m 4096
    -drive "if=pflash,format=raw,readonly=on,file=$OVMF_CODE"
    -drive "if=pflash,format=raw,file=$WORK/vars.fd"
    -device qemu-xhci,id=xhci "${STICK[@]}"
    -device usb-kbd,bus=xhci.0
    -drive "if=none,id=nvm,file=$WORK/nvme.qcow2,format=qcow2" -device nvme,drive=nvm,serial=signage0
    -nic user,model=virtio-net-pci
    -device virtio-vga -display none -vnc :1
)

if [[ -n $HEADLESS ]]; then
    rm -f "$WORK/serial.sock" "$WORK/monitor.sock"
    qemu-system-x86_64 "${ARGS[@]}" \
        -serial "unix:$WORK/serial.sock,server,nowait" \
        -monitor "unix:$WORK/monitor.sock,server,nowait" \
        -pidfile "$WORK/qemu.pid" -daemonize
    cat <<EOF
QEMU is running (pid $(cat "$WORK/qemu.pid")).
  serial console:  socat -,raw,echo=0 UNIX-CONNECT:$WORK/serial.sock
  QEMU monitor:    socat - UNIX-CONNECT:$WORK/monitor.sock
                   (screendump /tmp/screen.png -f png, quit)
EOF
else
    exec qemu-system-x86_64 "${ARGS[@]}" -serial mon:stdio
fi
