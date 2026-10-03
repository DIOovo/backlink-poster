#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/project/native-host" "$SANDBOX/home"
cp "$PROJECT_ROOT/native-host/install.sh" "$PROJECT_ROOT/native-host/uninstall.sh" "$PROJECT_ROOT/native-host/host.py" "$SANDBOX/project/native-host/"
chmod +x "$SANDBOX/project/native-host/"*.sh "$SANDBOX/project/native-host/host.py"

EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"
CHROME_HOSTS="$SANDBOX/home/Library/Application Support/Google/Chrome/NativeMessagingHosts"
OLD_EGO_HOSTS="$SANDBOX/home/Library/Application Support/Ego/NativeMessagingHosts"
MANIFEST="$CHROME_HOSTS/com.backlinkposter.native.json"

HOME="$SANDBOX/home" "$SANDBOX/project/native-host/install.sh" "$EXTENSION_ID" ego >/dev/null
test -f "$MANIFEST"
test ! -e "$OLD_EGO_HOSTS/com.backlinkposter.native.json"
python3 - "$MANIFEST" "$SANDBOX/project/native-host/host.py" "$EXTENSION_ID" <<'PY'
import json, os, sys
manifest_path, expected_host, extension_id = sys.argv[1:4]
with open(manifest_path, encoding="utf-8") as fh:
    manifest = json.load(fh)
assert manifest["name"] == "com.backlinkposter.native"
assert manifest["type"] == "stdio"
assert manifest["path"] == os.path.abspath(expected_host)
assert manifest["allowed_origins"] == [f"chrome-extension://{extension_id}/"]
PY

HOME="$SANDBOX/home" "$SANDBOX/project/native-host/uninstall.sh" ego >/dev/null
test ! -e "$MANIFEST"

HOME="$SANDBOX/home" "$SANDBOX/project/native-host/install.sh" "$EXTENSION_ID" chrome >/dev/null
test -f "$MANIFEST"
HOME="$SANDBOX/home" "$SANDBOX/project/native-host/uninstall.sh" chrome >/dev/null
test ! -e "$MANIFEST"

echo "  ✓ native host ego/chrome install and uninstall paths match"
