# Secure Boot

Players run with UEFI Secure Boot on, trusting our own key through shim's
Machine Owner Key (MOK) list. This is basic hardening for machines left in
public: someone with a USB stick can't boot their own OS or change the kernel
command line, and the read-only `/usr` is checked block by block. It is not a
high-security setup (see [What isn't protected](#what-isnt-protected)).

## The chain

```
firmware (Microsoft UEFI CA in db)
  └─ EFI/BOOT/BOOTX64.EFI   shim, Debian's shim-signed, signed by Microsoft
       └─ EFI/BOOT/grubx64.EFI   systemd-boot, signed with our MOK
            └─ EFI/Linux/signage_<v>.efi   UKI, signed with our MOK
                 ├─ kernel + initrd + command line (with usrhash=), one signed file
                 └─ /usr: erofs + dm-verity, root hash from usrhash=
                      └─ kernel modules: signed by Debian, checked by the kernel
                         (lockdown is on whenever Secure Boot is)
```

- shim verifies systemd-boot against the firmware's db, its built-in Debian
  certificate and the MOK list. systemd-boot then asks shim to verify the UKI.
  `EFI/BOOT/mmx64.efi` is MokManager, which shim starts when there's an
  enrollment request or when verification fails.
- The UKI's command line is part of the signed file, and `loader.conf` has
  `editor no`, so `init=/bin/sh` and similar can't be typed in at boot.
- The ESP also carries `signage-mok/*.cer` (the public certificates) so
  MokManager can "Enroll key from disk" on a machine that has never seen our
  key.
- Updates (`systemd-sysupdate`) only accept a release whose `SHA256SUMS` has a
  valid `SHA256SUMS.gpg` from our release key
  (`/usr/lib/systemd/import-pubring.gpg`, `Verify=yes` in
  `/usr/lib/sysupdate.d/*.transfer`).

## Keys

Kept offline in `~/signage-keys/` on the build Mac (see the README there),
never in the repo.

| Key | Used for | Where the private part lives |
|---|---|---|
| Production MOK, CN "MAGFest Signage MOK 2026", RSA 2048, to 2036 | signs systemd-boot and the UKI | GitHub `release` environment: `MOK_KEY`, `MOK_CERT` |
| Backup MOK, CN "MAGFest Signage MOK backup" | nothing yet; enrolled on every player so we can rotate without touching machines | offline only |
| Release GPG key, "MAGFest Signage releases", ed25519 | signs `SHA256SUMS` for sysupdate | GitHub `release` environment: `RELEASE_GPG_KEY` |

Public parts in the repo:
`mkosi.extra/usr/share/signage/mok/magfest-signage-mok-{2026,backup}.{cer,crt}`,
the same `.cer` files under `mkosi.extra/efi/signage-mok/` (the ESP), and
`mkosi.extra/usr/lib/systemd/import-pubring.gpg`.

**Builds.** mkosi signs with `mkosi.key`/`mkosi.crt` in the checkout (both
gitignored). CI writes them from the `release` environment's secrets and
deletes the key after the build. Pull requests don't get that environment
and sign with a throwaway key. `scripts/build.sh` creates a dev key with
`mkosi genkey` the first time ("Signage dev key (not for production)"). A
build signed with any key other than the two committed ones also ships that
certificate (`build-signing.cer`) on the ESP and in `/usr/share/signage/mok/`,
so dev builds install and boot the same way, just with one more certificate
enrolled.

## Setting up a player

Per machine, once. On the M715q the BIOS is F1 at power-on.

1. **BIOS:** leave Secure Boot as it ships (on, with the Microsoft keys) or
   turn it on. Don't clear the keys or enter setup mode. Set a BIOS
   supervisor password and put USB boot after the internal disk once
   installed (we'll decide on scripting this from the BIOS report below).
2. **Boot the stick.** On a machine that hasn't seen our key, shim refuses
   systemd-boot:
   - "Verification failed: (0x1A) Security Violation" → **OK**
   - "Press any key to perform MOK management" → press a key within 10 s
     (if you miss it, power off and try again)
   - **Enroll key from disk** → **ESP** → **signage-mok/** →
     **magfest-signage-mok-2026.cer** (or `build-signing.cer` for a dev build)
   - **Continue** → **Yes** → **Reboot**

   The stick now boots into the installer.
3. **Installer.** It writes `bios-<serial>.txt` to the stick's SIGNCFG
   partition (see below), installs, and runs `mokutil --import` for any of
   our certificates the machine doesn't trust yet (normally the backup, plus
   the production one if Secure Boot was off). The password is
   `install.mok_password` in `config.toml` (default `signage`). It then
   reboots after 30 s instead of 10 and says so on screen.
4. **First boot from the disk.** MokManager shows again because of that
   request:
   - "Press any key to perform MOK management" → press a key within 10 s
   - **Enroll MOK** → (View key 0/1 to check) **Continue** → **Yes** → type
     the password → **Reboot**

   If nobody presses a key, shim drops the request and boots on. That's
   harmless while the production key is already enrolled (step 2); only the
   backup key is missing, which matters at the next rotation (run
   `mokutil --import /usr/share/signage/mok/*.cer` again then).

If Secure Boot was off during install and is turned on later without the
key enrolled, the player shows the step-2 screens; the installed ESP has the
same `signage-mok/` folder.

Check on a running player: `mokutil --sb-state` (want `SecureBoot enabled`),
`mokutil --list-enrolled | grep CN=`.

### BIOS report

The installer loads `think-lmi` (Lenovo's WMI BIOS settings driver). If
`/sys/class/firmware-attributes/thinklmi` exists, it writes
`bios-<serial>.txt` to the stick's SIGNCFG partition: model, BIOS version,
the password state (`authentication/*`: is_enabled, role, mechanism) and
every setting with its current and possible values. It changes nothing; the
report is for deciding which settings to script later. Booting the stick and
pressing a key to cancel the countdown still writes the report.

## Rotating to the backup MOK

The backup certificate is enrolled on every player at install, so a rotation
needs no visit as long as the updated UKI and systemd-boot are signed with a
key the machine already trusts.

1. Move `mok-backup.key`/`.crt` into the `MOK_KEY`/`MOK_CERT` secrets. Release.
   sysupdate installs the new UKI. **systemd-boot isn't updated by sysupdate
   yet**, so for now that also needs a fresh install or a `bootctl update` on
   each player before the old key can go. (Follow-up: ship systemd-boot in
   the sysupdate transfers.)
2. Make a new backup key, commit its certificate, and have players queue it
   (`mokutil --import`, which needs a MokManager confirmation at the
   console). Until we automate that, this is a visit per machine.
3. To revoke the old key, `mokutil --delete old.cer` (also confirmed in
   MokManager), or push it into MOKX (`mokutil --mokx --import`).

If the release GPG key changes, ship the new public key in
`import-pubring.gpg` in a release signed with the old one first.

## What isn't protected

- **`/etc` and `/var`** live on the writable ext4 root, unencrypted and not
  verified. Someone with the disk out of the machine (or a root shell) can
  change `/etc` (units, PAM, sudoers, NetworkManager profiles) and that
  persists. `config.toml` with the WiFi passwords is in `/var/lib/signage/`
  in plain text.
- **The SIGNCFG partition** on the install stick is plain FAT.
- **No TPM.** Nothing is sealed to the boot state and the disk isn't
  encrypted, so pulling the disk gives full read access.
- **The firmware.** A BIOS without a supervisor password lets anyone turn
  Secure Boot off or boot USB first; that's the per-machine BIOS step.
- **Other signed media.** The firmware still trusts everything Microsoft
  signed (Windows, other distributions' shims), and our shim trusts Debian's
  key, so a stock Windows or Linux USB stick still boots if the BIOS allows
  USB boot. The BIOS boot order and password are what stop that. Locking it
  out in firmware means our own PK/KEK/db instead of shim, which is more
  setup per machine than this aims for.
- **The debug profile** has root autologin on the serial console and tty2.
  Never deploy it.

## Testing in QEMU

`scripts/qemu-test.sh --secure-boot` uses OVMF's Secure Boot firmware
(`OVMF_CODE_4M.secboot.fd`, SMM on) with Microsoft's keys enrolled
(`OVMF_VARS_4M.ms.fd`), like a stock PC. Results and screenshots:
[secure-boot-test.md](secure-boot-test.md).
