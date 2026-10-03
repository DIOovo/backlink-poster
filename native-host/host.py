#!/usr/bin/env python3
"""Native messaging host for Batch Backlink Poster.

Writes PNG screenshots and results.csv directly to the local filesystem,
strictly confined to a single configured outputRoot. It never runs shell
commands and never writes outside outputRoot.

Protocol: Chrome native messaging (4-byte little-endian length prefix + UTF-8
JSON on stdin/stdout).

Actions:
  ping           -> {ok:true, version, outputRoot}
  writeScreenshot-> {ok:true, path} | {ok:false, error}
  writeCsv       -> {ok:true, path} | {ok:false, error}
"""

import base64
import json
import os
import re
import struct
import sys

HOST_VERSION = "1.0.0"
DEFAULT_OUTPUT_ROOT = os.path.expanduser("~/Downloads/backlink-results")

# Config lives next to this script; install.sh writes it once.
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# One path segment: no separators, no "..", no leading dot, printable US-ASCII only.
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,255}$")


def load_output_root():
    root = ""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            root = json.load(fh).get("outputRoot", "")
    except (OSError, ValueError):
        root = ""
    root = os.path.expanduser((root or "").strip())
    if not root:
        root = DEFAULT_OUTPUT_ROOT
    return os.path.abspath(root)


OUTPUT_ROOT = load_output_root()


def sanitize_segment(value, label):
    value = (value or "").strip()
    if SEGMENT_RE.match(value) and ".." not in value:
        return value
    raise ValueError("Invalid %s." % label)


def resolve_target(segments):
    """Resolve path components under OUTPUT_ROOT, refusing any escape."""
    root = os.path.realpath(OUTPUT_ROOT)
    try:
        os.makedirs(root, exist_ok=True)
    except OSError as exc:
        raise ValueError("Cannot create output root: %s" % exc)
    target = os.path.abspath(os.path.join(root, *segments))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Path escapes output root.")
    return target


def send(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) != 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length <= 0 or length > 64 * 1024 * 1024:
        raise ValueError("Invalid message length.")
    return sys.stdin.buffer.read(length)


def write_file(batch_id, filename, payload, expect_ext, decode_b64):
    batch = sanitize_segment(batch_id, "batchId")
    name = sanitize_segment(filename, "filename")
    if not name.endswith(expect_ext):
        raise ValueError("Filename must end with %s." % expect_ext)
    parent = resolve_target([batch, os.path.dirname(name) or ""])
    os.makedirs(parent, exist_ok=True)
    path = os.path.join(parent, os.path.basename(name))
    data = base64.b64decode(payload) if decode_b64 else payload.encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(data)
    return os.path.abspath(path)


def handle(message):
    action = message.get("action")
    if action == "ping":
        return {"ok": True, "version": HOST_VERSION, "outputRoot": OUTPUT_ROOT}
    if action == "writeScreenshot":
        path = write_file(
            message.get("batchId"), message.get("filename"),
            message.get("data", ""), ".png", decode_b64=True,
        )
        return {"ok": True, "path": path}
    if action == "writeCsv":
        if message.get("filename") != "results.csv":
            raise ValueError("writeCsv only accepts filename results.csv.")
        path = write_file(
            message.get("batchId"), "results.csv",
            message.get("data", ""), ".csv", decode_b64=False,
        )
        return {"ok": True, "path": path}
    raise ValueError("Unknown action: %s" % (action or "(none)"))


def main():
    while True:
        raw = read_message()
        if raw is None:
            break
        try:
            message = json.loads(raw.decode("utf-8"))
            response = handle(message)
        except Exception as exc:  # noqa: BLE001 - any host error is reported back.
            response = {"ok": False, "error": str(exc)}
        try:
            send(response)
        except (BrokenPipeError, OSError):
            break


if __name__ == "__main__":
    main()