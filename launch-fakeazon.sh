#!/usr/bin/env bash
# Open Amazon in the dedicated, signed-out "Fakeazon" Firefox profile.
# If the signed extension isn't installed yet, also open about:debugging so the
# temporary add-on can be loaded (pick manifest.json in this folder).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$(awk -F= '/^\[/{p=""} /^Name=Fakeazon$/{p=1} p&&/^Path=/{print $2}' ~/.mozilla/firefox/profiles.ini | head -1)"
URLS=("https://www.amazon.com/")
if [[ -z "$PROFILE_DIR" ]]; then
  echo "No Fakeazon Firefox profile. Create it with: firefox -CreateProfile Fakeazon" >&2
  exit 1
fi
if [[ ! -f "$HOME/.mozilla/firefox/$PROFILE_DIR/extensions/fakeazon@robbiemed.org.xpi" ]]; then
  URLS+=("about:debugging#/runtime/this-firefox")
  echo "Fakeazon extension not installed permanently: load $HERE/manifest.json via 'Load Temporary Add-on…'."
fi
exec firefox -P Fakeazon --no-remote "${URLS[@]}"
