#!/usr/bin/env bash
set -euo pipefail

REPO="trefeon/pi-antigravity-stealth"
PACKAGE_NAME="pi-antigravity-stealth"
INSTALL_DIR="${PI_ANTIGRAVITY_INSTALL_DIR:-$HOME/.pi-antigravity-stealth}"
TARGET_VERSION="${PI_ANTIGRAVITY_VERSION:-}"
UNINSTALL=0

usage() {
  cat <<'EOF'
pi-antigravity-stealth installer (Linux / macOS, no npm required)

Usage:
  install.sh [--version <tag>] [--dir <path>] [--uninstall]

Options:
  --version <tag>   Install a specific GitHub release tag (e.g. v1.1.0)
  --dir <path>      Target install directory (default: ~/.pi-antigravity-stealth)
  --uninstall       Unlink from OMP/Pi and remove the installed directory
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ -z "${2:-}" ]]; then echo "Error: --version requires a value." >&2; exit 1; fi
      TARGET_VERSION="$2"
      shift 2
      ;;
    --dir)
      if [[ -z "${2:-}" ]]; then echo "Error: --dir requires a value." >&2; exit 1; fi
      INSTALL_DIR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

have() {
  command -v "$1" >/dev/null 2>&1
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  echo "Uninstalling $PACKAGE_NAME..."
  if have omp; then
    omp plugin uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true
  fi
  if have pi; then
    pi remove "$INSTALL_DIR" >/dev/null 2>&1 || true
    pi remove "npm:$PACKAGE_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$HOME/.omp/plugins/node_modules/$PACKAGE_NAME"
  if [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
    rm -rf "$INSTALL_DIR"
    echo "Removed $INSTALL_DIR"
  elif [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "Kept git checkout at $INSTALL_DIR (unlinked only)."
  fi
  echo "Done. Saved credentials in ~/.omp/agent/agent.db were left untouched."
  exit 0
fi

if ! have tar; then
  echo "Error: 'tar' is required to extract release archives." >&2
  exit 1
fi

if ! have curl && ! have wget; then
  echo "Error: 'curl' or 'wget' is required." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Error: Refusing to overwrite git repository at $INSTALL_DIR." >&2
  echo "Run 'git pull' inside $INSTALL_DIR or choose another --dir." >&2
  exit 1
fi

resolve_latest_tag() {
  local latest_url="https://github.com/$REPO/releases/latest"
  local location=""
  if have curl; then
    location="$(curl -fsSI "$latest_url" 2>/dev/null | tr -d '\r' | sed -n 's/^[Ll]ocation: *\([^ ]*\).*/\1/p' | head -n 1 || true)"
  else
    location="$(wget --max-redirect=0 "$latest_url" 2>&1 | tr -d '\r' | sed -n 's/^[Ll]ocation: *\([^ ]*\).*/\1/p' | head -n 1 || true)"
  fi
  if [[ "$location" == *"/releases/tag/"* ]]; then
    local tag="${location##*/releases/tag/}"
    tag="${tag%%[?#]*}"
    tag="${tag%/}"
    if [[ -n "$tag" ]]; then
      echo "$tag"
      return 0
    fi
  fi
  return 1
}

download_file() {
  local url="$1"
  local dest="$2"
  if have curl; then
    curl -fsSL "$url" > "$dest"
  else
    wget -qO- "$url" > "$dest"
  fi
}

TAG=""
REF_TYPE="tag"
if [[ -n "$TARGET_VERSION" ]]; then
  if [[ "$TARGET_VERSION" == v* ]]; then
    TAG="$TARGET_VERSION"
  else
    TAG="v$TARGET_VERSION"
  fi
else
  if TAG="$(resolve_latest_tag)"; then
    REF_TYPE="tag"
  else
    echo "No GitHub release redirect found; falling back to main branch archive."
    TAG="main"
    REF_TYPE="branch"
  fi
fi

TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t pi-ag-stealth)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ARCHIVE="$TMP_ROOT/archive.tar.gz"
EXTRACT_DIR="$TMP_ROOT/extract"
mkdir -p "$EXTRACT_DIR"

if [[ "$REF_TYPE" == "tag" ]]; then
  ASSET_URL="https://github.com/$REPO/releases/download/$TAG/$PACKAGE_NAME-$TAG.tar.gz"
  FALLBACK_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
  echo "Downloading $PACKAGE_NAME $TAG from GitHub Releases..."
  if ! download_file "$ASSET_URL" "$ARCHIVE" 2>/dev/null; then
    echo "Release asset unavailable, fetching source archive for $TAG..."
    download_file "$FALLBACK_URL" "$ARCHIVE"
  fi
else
  echo "Downloading $PACKAGE_NAME (main) from GitHub..."
  download_file "https://github.com/$REPO/archive/refs/heads/main.tar.gz" "$ARCHIVE"
fi

tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"

SRC_ROOT=""
if [[ -f "$EXTRACT_DIR/package.json" && -f "$EXTRACT_DIR/src/index.ts" ]]; then
  SRC_ROOT="$EXTRACT_DIR"
else
  for d in "$EXTRACT_DIR"/*; do
    if [[ -d "$d" && -f "$d/package.json" && -f "$d/src/index.ts" ]]; then
      SRC_ROOT="$d"
      break
    fi
  done
fi

if [[ -z "$SRC_ROOT" ]]; then
  echo "Error: Downloaded archive does not contain a valid $PACKAGE_NAME package." >&2
  exit 1
fi

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC_ROOT/package.json" | head -n 1)"
VERSION="${VERSION:-0.0.0}"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$SRC_ROOT"/. "$INSTALL_DIR"/

cat >"$INSTALL_DIR/.pi-antigravity-install.json" <<EOF
{
  "source": "github-release",
  "repo": "$REPO",
  "version": "$VERSION",
  "tag": "$TAG",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
}
EOF

echo "Installed $PACKAGE_NAME v$VERSION to $INSTALL_DIR"

WIRED=0
if have omp; then
  PLUGINS_PKG="$HOME/.omp/plugins/package.json"
  if [[ -f "$PLUGINS_PKG" ]] && grep -q "\"$PACKAGE_NAME\"" "$PLUGINS_PKG" 2>/dev/null; then
    omp plugin uninstall "$PACKAGE_NAME" >/dev/null 2>&1 || true
  fi
  (cd "$INSTALL_DIR" && omp plugin link .)
  WIRED=1
  echo "Linked $PACKAGE_NAME into OMP."
fi

if have pi; then
  pi remove "npm:$PACKAGE_NAME" >/dev/null 2>&1 || true
  pi install "$INSTALL_DIR"
  WIRED=1
  echo "Installed $PACKAGE_NAME into Pi."
fi

if [[ "$WIRED" -eq 0 ]]; then
  echo "Neither 'omp' nor 'pi' was found on PATH."
  echo "Link manually after installing your agent CLI:"
  echo "  cd \"$INSTALL_DIR\" && omp plugin link ."
  echo "  pi install \"$INSTALL_DIR\""
fi

echo ""
echo "Verify inside OMP/Pi:"
echo "  omp models google-antigravity"
echo "  /agy status"
echo "  /agy update   # check/apply future GitHub releases"
