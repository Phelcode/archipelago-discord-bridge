#!/bin/sh
# Container entrypoint: self-update this app on boot, clone/update
# Archipelago, then start the bridge.
set -e

APP_RUN_DIR="${APP_RUN_DIR:-/opt/app}"
REPO_URL="${REPO_URL:-https://github.com/Phelcode/archipelago-discord-bridge.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SELF_UPDATE="${SELF_UPDATE:-true}"

if [ "$SELF_UPDATE" = "true" ] && [ -n "$REPO_URL" ]; then
  LIVE_DIR="${APP_LIVE_DIR:-/opt/app-live}"
  echo "[entrypoint] self-update: syncing $REPO_URL branch $REPO_BRANCH into $LIVE_DIR"
  if [ -d "$LIVE_DIR/.git" ]; then
    git -C "$LIVE_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$LIVE_DIR" reset --hard FETCH_HEAD
  else
    rm -rf "$LIVE_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$LIVE_DIR"
  fi
  cd "$LIVE_DIR"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
  APP_RUN_DIR="$LIVE_DIR"
fi

# Archipelago: clone it on first boot and update it on every boot
# (AP_UPDATE=false keeps the existing copy).
AP_DIR="${AP_DIR:-/opt/Archipelago}"
AP_REPO_URL="${AP_REPO_URL:-https://github.com/ArchipelagoMW/Archipelago.git}"
# Default to the newest stable release tag, not main: generated seeds embed the
# generator's version/data-file format, and players run released clients/mods,
# so a seed rolled from main can be rejected by every released mod (e.g. the
# Minecraft mod's "APMC data file wrong version"). Set AP_BRANCH=main for
# bleeding edge.
AP_BRANCH="${AP_BRANCH:-}"
if [ -z "$AP_BRANCH" ]; then
  AP_BRANCH="$(git ls-remote --tags "$AP_REPO_URL" | sed -n 's|^.*refs/tags/\([0-9][0-9.]*\)$|\1|p' | sort -V | tail -1)"
  [ -n "$AP_BRANCH" ] || AP_BRANCH=main
  echo "[entrypoint] AP_BRANCH not set; defaulting to latest stable release tag: $AP_BRANCH"
fi
AP_UPDATE="${AP_UPDATE:-true}"

if [ ! -d "$AP_DIR" ] || [ "$AP_UPDATE" = "true" ]; then
  echo "[entrypoint] syncing Archipelago from $AP_REPO_URL branch $AP_BRANCH into $AP_DIR"
  if [ -d "$AP_DIR/.git" ]; then
    git -C "$AP_DIR" fetch --depth 1 origin "$AP_BRANCH"
    git -C "$AP_DIR" reset --hard FETCH_HEAD
  else
    rm -rf "$AP_DIR"
    git clone --depth 1 --branch "$AP_BRANCH" "$AP_REPO_URL" "$AP_DIR"
  fi
fi

# Export the synced AP version so the bridge's probe speaks the matching
# protocol version (an explicit AP_VERSION env var still wins).
AP_SYNCED_VERSION="$(sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$AP_DIR/Utils.py" | head -1)"
if [ -n "$AP_SYNCED_VERSION" ]; then
  echo "[entrypoint] Archipelago $AP_SYNCED_VERSION ($AP_BRANCH) at $AP_DIR"
  if [ -z "${AP_VERSION:-}" ]; then
    export AP_VERSION="$AP_SYNCED_VERSION"
  fi
fi

# Python environment for Archipelago (created at image build time; recreate
# only if missing, e.g. when running the entrypoint outside the image).
AP_VENV="${AP_VENV:-/opt/ap-venv}"
if [ ! -x "$AP_VENV/bin/python" ]; then
  python3 -m venv "$AP_VENV"
  "$AP_VENV/bin/pip" install --quiet --upgrade pip
  "$AP_VENV/bin/pip" install --quiet --no-cache-dir -r "$APP_RUN_DIR/docker/requirements-ap.txt"
fi

# Sanity check: Archipelago rejects unsupported Python versions at import time
# (ModuleUpdate raises RuntimeError), so verify the venv can import AP and warn
# clearly here. AP requires Python 3.12-3.13; rebuild the image
# (docker compose up -d --build) so the venv gets a supported Python.
if ! (cd "$AP_DIR" && SKIP_REQUIREMENTS_UPDATE=1 "$AP_VENV/bin/python" -c 'import ModuleUpdate' >/dev/null 2>&1); then
  echo "[entrypoint] WARNING: $AP_VENV/bin/python ($("$AP_VENV/bin/python" --version 2>&1)) cannot import Archipelago from $AP_DIR — AP requires Python 3.12-3.13. Rebuild the image (docker compose up -d --build) so /opt/ap-venv uses a supported Python."
fi

export AP_DIR
export AP_PYTHON="$AP_VENV/bin/python"
export DATA_DIR="${DATA_DIR:-/data}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$DATA_DIR/xdg}"
export SKIP_REQUIREMENTS_UPDATE=1
mkdir -p "$DATA_DIR"

echo "[entrypoint] starting archipelago-discord-bridge from $APP_RUN_DIR (AP from $AP_DIR)"
cd "$APP_RUN_DIR"
exec node src/index.js
