#!/bin/sh
# Container entrypoint: update this app (and Archipelago) to the newest
# version on boot, install dependencies, then start the bridge.
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

AP_DIR="${AP_DIR:-/opt/Archipelago}"
AP_REPO_URL="${AP_REPO_URL:-https://github.com/ArchipelagoMW/Archipelago.git}"
AP_BRANCH="${AP_BRANCH:-main}"
AP_UPDATE="${AP_UPDATE:-true}"

if [ ! -d "$AP_DIR" ] || [ "$AP_UPDATE" = "true" ]; then
  echo "[entrypoint] updating Archipelago from $AP_REPO_URL branch $AP_BRANCH into $AP_DIR"
  if [ -d "$AP_DIR/.git" ]; then
    git -C "$AP_DIR" fetch --depth 1 origin "$AP_BRANCH"
    git -C "$AP_DIR" reset --hard FETCH_HEAD
  else
    rm -rf "$AP_DIR"
    git clone --depth 1 --branch "$AP_BRANCH" "$AP_REPO_URL" "$AP_DIR"
  fi
fi

AP_VENV="${AP_VENV:-/opt/ap-venv}"
if [ ! -x "$AP_VENV/bin/python" ]; then
  python3 -m venv "$AP_VENV"
fi
"$AP_VENV/bin/pip" install --quiet --upgrade pip
"$AP_VENV/bin/pip" install --quiet --no-cache-dir -r "$APP_RUN_DIR/docker/requirements-ap.txt"

export AP_DIR
export AP_PYTHON="$AP_VENV/bin/python"
export DATA_DIR="${DATA_DIR:-/data}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$DATA_DIR/xdg}"
export SKIP_REQUIREMENTS_UPDATE=1
mkdir -p "$DATA_DIR"

echo "[entrypoint] starting archipelago-discord-bridge from $APP_RUN_DIR"
cd "$APP_RUN_DIR"
exec node src/index.js
