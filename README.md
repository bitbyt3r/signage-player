# signage-player

Immutable Linux signage players for MAGFest: OGraf graphics on a schedule
from schedule.magfest.net, managed from a central dashboard.

- [`docs/image.md`](docs/image.md): the OS image, install stick and config file
- `mkosi.conf`, `mkosi.repart/`, `mkosi.extra/`: the image
- `scripts/build.sh`: build locally (macOS: in an OrbStack machine)
- `scripts/qemu-test.sh`: boot the image in QEMU as a USB stick with an empty
  NVMe disk, the way a player sees it (`scripts/utm-test.sh` does the same in UTM)
- `packages/`: OGraf graphics baked into the image (a demo lower third)
- `.github/workflows/image.yml`: CI build; tags `v*` become GitHub releases

Status: step 1 (OS image and installer) in progress. Player and dashboard
(AWS Lambda + DynamoDB) to follow.
