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
| Backup MOK, CN "MAGFest Signage MOK backup" | nothing yet; enrolled by hand on players so we can rotate without touching them | offline only |
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
   partition (see below), installs, and sets shim's `MokTimeout` to 60 s
   (`mokutil --timeout`) so any later MokManager prompt on that machine
   waits a minute instead of 10 s. It queues keys with `mokutil --import`
   only when the machine trusts none of ours, which with Secure Boot on
   can't happen (the stick wouldn't have booted). So normally it queues
   nothing and says `Secure Boot is on and our signing key is enrolled: nothing to
   enroll.`, or `Secure Boot is off: no keys to enroll.` Enrolled MOKs live
   in the firmware and survive a re-image, so re-imaging a player never
   brings up MokManager.
4. **Backup key (optional, when convenient).** Not queued by the installer,
   because every queued key means a MokManager confirmation at the next
   boot. To add it, on the player run
   `mokutil --import /usr/share/signage/mok/magfest-signage-mok-backup.cer`
   (password of your choice), reboot with someone at the screen, and in
   MokManager pick **Enroll MOK** → **Continue** → **Yes** → password →
   **Reboot**. It only matters at the next key rotation.

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
every setting with its current and possible values, as they were before the
install. Booting the stick and pressing a key to cancel the countdown still
writes the report.

### BIOS settings

Once the disk is written, the installer runs `/usr/lib/signage/signage-bios`,
which sets these through `think-lmi` (unless `install.bios_settings = false`
in `config.toml`):

| Setting | Value | Why |
|---|---|---|
| After Power Loss | Power On | starts again by itself when the power comes back |
| Enhanced Power Saving Mode | Disabled | ErP mode stops power-on after a power cut and wake on LAN |
| Wake on LAN | Primary | wake on LAN on, booting the normal sequence (Automatic tries the network first) |
| UMA Frame Buffer Size | 512MB | the most GPU memory this BIOS offers |
| CPB Mode | Auto | turbo left to the CPU |
| ICE Performance Modes | Better Thermal Performance | fans favour cooling; Full Speed is constant noise and wear |
| Configuration Change Detection, Chassis Intrusion Detection, Dust Shield Alert | Disabled | each can stop the boot at a prompt |

The names and values are the M715q's (BIOS M1XKT45A). Each one is skipped,
with a line saying so, when the machine has no such setting, the BIOS doesn't
offer the value, or the write is refused; nothing is set on a machine without
`think-lmi` or with a BIOS supervisor password. What it did is on screen and
appended to `bios-<serial>.txt` under "set by the installer". Changes apply at
the next boot (the installer reboots anyway).

It leaves Secure Boot, the boot sequences, USB ports and passwords alone: a
wrong value there can leave a sign that needs a keyboard to recover. Those
stay the by-hand step above.

On a running player: `signage-bios --dry-run` shows what it would change,
`signage-bios` changes it.

## Troubleshooting

**"Verification failed: (0x1A) Security Violation" on a black/text screen,
then an OK box.** That's shim. The firmware accepted shim (Microsoft-signed)
and shim refused systemd-boot because our signing key isn't enrolled on this
machine yet. Expected on the first boot of every new machine and for any
build signed with a key the machine doesn't trust (a dev build on a player
enrolled with the production key, for example). Press Enter on **OK**, then
press a key at "Press any key to perform MOK management" and do the
[step 2](#setting-up-a-player) enrollment. Pick the certificate that matches
the build: `magfest-signage-mok-2026.cer` for CI/release builds,
`build-signing.cer` for a local or pull-request build. On a machine our
installer hasn't run on, that prompt lasts 10 s (shim's default); if it
goes past, the firmware moves on to the next boot option. Power off and try
again.

**A firmware screen instead (Lenovo: "Secure Boot Violation", "Invalid
signature detected. Check Secure Boot Policy in Setup", or the stick just
doesn't appear as bootable).** That's the BIOS rejecting shim itself, before
any of our code runs. Causes and fixes, most likely first:

- The firmware doesn't trust the Microsoft *third-party* UEFI CA (the one
  that signs Linux shims, separate from the Windows CA). Some Lenovo models
  have an "Allow Microsoft 3rd Party UEFI CA" option under Security → Secure
  Boot; turn it on. Older ThinkCentres like the M715q trust it by default.
- Custom keys: someone replaced the factory db (Secure Boot mode "Custom")
  with one lacking the third-party CA. "Restore Factory Keys" under Secure
  Boot puts the Microsoft keys back.
- Revocation: not expected. Our shim (Debian 16.1, SBAT `shim,4`) is
  current for Microsoft's DBX/SBAT revocations and carries signatures from
  both the 2011 and the 2023 Microsoft UEFI CA, so firmware trusting either
  accepts it. If a BIOS still refuses it, update the BIOS.

To tell them apart: shim's message is plain text with `(0x1A)` and its own
OK box; Lenovo's is a full-screen firmware dialog that names Secure Boot
policy or setup. As a last resort, turn Secure Boot off, install, and turn
it back on afterwards; the installed system then shows shim's screen and the
same enrollment works from the disk's ESP.

**MokManager shows after a re-image.** Images from before 0.1.2 queued our
certificates on every install, even ones the firmware already had. Press a
key and pick **Continue boot** (or let it time out): nothing is lost, the
enrolled keys stay. Current installers queue nothing when the signing key
is already enrolled.

**A queued request was skipped.** shim offers a queued request once; if
nobody pressed a key it's gone and the player boots on the keys it already
has. Run the `mokutil --import` again and reboot with someone at the screen.

## Rotating to the backup MOK

Once the backup certificate is enrolled on a player (step 4 above), a
rotation needs no visit there as long as the updated UKI and systemd-boot
are signed with a key the machine already trusts.

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
- **No TPM use yet.** Nothing is sealed to the boot state and the disk isn't
  encrypted, so pulling the disk gives full read access. The TPM plumbing
  works (tss2 libraries in the image and initrd; tpm_crb/tpm_tis are built
  into the kernel), so systemd measures the boot phases into PCR 11. The
  `systemd-pcrlock-*` units are masked: mkosi applies presets and Debian's
  preset file has no `disable *`, so they came enabled, and they fail
  without a pcrlock policy. A sealed root later will use signed PCR
  policies, not pcrlock.
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
