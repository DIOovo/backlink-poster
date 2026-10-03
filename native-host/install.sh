#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="${1:-}"
SECOND_ARG="${2:-}"
THIRD_ARG="${3:-}"
if [[ -z "$THIRD_ARG" && "$SECOND_ARG" =~ ^(chrome|google-chrome|chromium|edge|brave|ego)$ ]]; then
  OUTPUT_ROOT_ARG=""
  BROWSER="$SECOND_ARG"
else
  OUTPUT_ROOT_ARG="$SECOND_ARG"
  BROWSER="${THIRD_ARG:-${BROWSER:-chrome}}"
fi
OUTPUT_ROOT="${OUTPUT_ROOT_ARG:-$HOME/Downloads/backlink-results}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Usage: $0 <EXTENSION_ID> [BROWSER]"
  echo "   or: $0 <EXTENSION_ID> [OUTPUT_ROOT] [BROWSER]"
  echo "  EXTENSION_ID  the Chrome/ego extension id (letters a-p only)"
  echo "  OUTPUT_ROOT   absolute output directory (default: \$HOME/Downloads/backlink-results)"
  echo "  BROWSER       chrome|chromium|edge|brave|ego, or an absolute NativeMessagingHosts dir (default: chrome)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.backlinkposter.native"

# Resolve the browser's NativeMessagingHosts directory on macOS.
case "$BROWSER" in
  /*) HOSTS_DIR="$BROWSER" ;;
  chrome|google-chrome) HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  chromium)            HOSTS_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
  edge)                HOSTS_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  brave)               HOSTS_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
  # ego(lite) 0.5.1.13 uses Chromium's Google Chrome native-host lookup path
  # on macOS even though its profile lives under Citro Labs/ego lite.
  # Verified on 2026-10-03; keep this aligned with uninstall.sh.
  ego)                 HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  *) echo "Unknown BROWSER '$BROWSER'. Use chrome/chromium/edge/brave/ego or an absolute path."; exit 1 ;;
esac

chmod +x "$SCRIPT_DIR/host.py"

python3 - "$HOST_NAME" "$SCRIPT_DIR/host.py" "$EXTENSION_ID" "$OUTPUT_ROOT" "$HOSTS_DIR" "${OUTPUT_ROOT_ARG:+yes}" <<'PY'
import json, os, sys
name, host_path, ext_id, output_root, hosts_dir, overwrite = sys.argv[1:7]
host_path = os.path.abspath(host_path)
output_root = os.path.abspath(os.path.expanduser(output_root))

os.makedirs(hosts_dir, exist_ok=True)
manifest_path = os.path.join(hosts_dir, name + ".json")
with open(manifest_path, "w") as f:
    json.dump({
        "name": name,
        "description": "Local file writer for Batch Backlink Poster (writes screenshots and results.csv)",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % ext_id],
    }, f, indent=2)
    f.write("\n")

config_path = os.path.join(os.path.dirname(host_path), "config.json")
final_root = output_root
if os.path.exists(config_path) and not overwrite:
    try:
        with open(config_path) as f:
            final_root = json.load(f).get("outputRoot") or output_root
    except Exception:
        final_root = output_root
else:
    with open(config_path, "w") as f:
        json.dump({"outputRoot": output_root}, f, indent=2)
        f.write("\n")

print("Installed native host manifest:")
print("  " + manifest_path)
print("Native host:")
print("  " + host_path)
print("Output root:")
print("  " + final_root)
print("allowed_origins: chrome-extension://%s/" % ext_id)
PY

echo "Done. Reload the extension (or restart the browser) for nativeMessaging to take effect."
