#!/usr/bin/env bash
set -euo pipefail

BROWSER="${1:-}"
HOST_NAME="com.backlinkposter.native"

if [[ -z "$BROWSER" ]]; then
  echo "Usage: $0 <chrome|chromium|edge|brave|ego|absolute-NativeMessagingHosts-dir>"
  exit 1
fi

# These paths must stay identical to install.sh. ego(lite) 0.5.1.13 reads
# native-host manifests from Chrome's user-level directory on macOS.
case "$BROWSER" in
  /*) HOSTS_DIR="$BROWSER" ;;
  chrome|google-chrome) HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  chromium)            HOSTS_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
  edge)                HOSTS_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  brave)               HOSTS_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
  ego)                 HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  *) echo "Unknown BROWSER '$BROWSER'. Use chrome/chromium/edge/brave/ego or an absolute path."; exit 1 ;;
esac

MANIFEST_PATH="$HOSTS_DIR/$HOST_NAME.json"
if [[ -e "$MANIFEST_PATH" ]]; then
  rm -- "$MANIFEST_PATH"
  echo "Removed native host manifest:"
  echo "  $MANIFEST_PATH"
else
  echo "Native host manifest is already absent:"
  echo "  $MANIFEST_PATH"
fi

echo "The host script and output files were left unchanged."
