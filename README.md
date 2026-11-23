# signage-player

Immutable Linux signage players for MAGFest: OGraf graphics on a schedule
from schedule.magfest.net, managed from a central dashboard.

- [`docs/image.md`](docs/image.md): the OS image, install stick and config file
- [`docs/install-walkthrough.md`](docs/install-walkthrough.md): screenshots and timeline
  of an install, from the stick to the first boot and the demo graphic
- [`docs/secure-boot.md`](docs/secure-boot.md): Secure Boot chain, keys, per-machine setup ([test run](docs/secure-boot-test.md))
- `mkosi.conf`, `mkosi.repart/`, `mkosi.extra/`: the image
- `scripts/build.sh`: build locally (macOS: in an OrbStack machine)
- `scripts/qemu-test.sh`: boot the image in QEMU as a USB stick with an empty
  NVMe disk, the way a player sees it (`scripts/utm-test.sh` does the same in UTM)
- `packages/`: local-only, git-ignored folder for OGraf graphics you
  zip with `scripts/package-ograf.sh` and upload on the dashboard. The
  image's built-in demo lower third lives in
  `mkosi.extra/usr/share/signage/packages/demo-lower-third/`
- `.github/workflows/image.yml`: CI build; tags `v*` become GitHub releases

Status: step 1 (OS image and installer) in progress. Player and dashboard
(AWS Lambda + DynamoDB) to follow.
