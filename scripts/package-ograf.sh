#!/bin/bash
# packages/ is local-only and git-ignored: keep graphics there and upload
# the zips by hand.
# Zip each OGraf graphic in packages/ for upload on the dashboard's Packages
# page: dist/ograf/<id>-<version>.zip, with the manifest at the zip's root.
#   scripts/package-ograf.sh                 # every package
#   scripts/package-ograf.sh magfest-schedule
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/ograf
mkdir -p "$out"
dirs=("$@")
[[ ${#dirs[@]} -gt 0 ]] || dirs=($(cd packages && ls -d */ | tr -d /))
for d in "${dirs[@]}"; do
    src=packages/$d
    manifest=$(cd "$src" && ls *.ograf.json | head -n1)
    [[ -n $manifest ]] || { echo "$src: no *.ograf.json" >&2; exit 1; }
    read -r id version < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["id"], m.get("version","0"))' "$src/$manifest")
    zip="$PWD/$out/$id-$version.zip"
    rm -f "$zip"
    (cd "$src" && zip -qrX "$zip" . -x '.*' -x '*/.*' -x 'README.md')
    echo "$zip"
done
