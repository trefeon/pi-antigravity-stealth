#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun run "$SCRIPT_DIR/antigravity-stealth-launcher.ts" "$@"
