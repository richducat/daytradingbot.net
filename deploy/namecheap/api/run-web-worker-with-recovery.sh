#!/usr/bin/env bash
set -euo pipefail

API_URL="${PUBLIC_API_URL:-https://api.daytradingbot.net}"
APP_ROOT="${DAYTRADINGBOT_APP_ROOT:-daytradingbot-api}"
APP_DIR="${DAYTRADINGBOT_APP_DIR:-$HOME/$APP_ROOT}"
NODE_BIN="${DAYTRADINGBOT_NODE_BIN:-/opt/alt/alt-nodejs22/root/usr/bin/node}"
SELECTOR_BIN="${DAYTRADINGBOT_SELECTOR_BIN:-/usr/sbin/cloudlinux-selector}"
WORKER_SECRET_PATH="${WORKER_SECRET_FILE:-$HOME/.daytradingbot-secrets/web-worker-secret}"

healthy() {
  /usr/bin/curl --fail --silent --show-error --max-time 15 "$API_URL/healthz" >/dev/null 2>&1
}

wait_for_health() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if healthy; then return 0; fi
    /bin/sleep 2
  done
  return 1
}

if ! healthy; then
  "$SELECTOR_BIN" start --json --interpreter nodejs --app-root "$APP_ROOT" >/dev/null 2>&1 || true
  if ! wait_for_health; then
    "$SELECTOR_BIN" restart --json --interpreter nodejs --app-root "$APP_ROOT" >/dev/null 2>&1 || true
    wait_for_health
  fi
fi

test -x "$NODE_BIN"
test -r "$APP_DIR/dist/run-worker.js"
test -r "$WORKER_SECRET_PATH"

exec /usr/bin/env \
  PUBLIC_API_URL="$API_URL" \
  WORKER_SECRET_FILE="$WORKER_SECRET_PATH" \
  "$NODE_BIN" "$APP_DIR/dist/run-worker.js"
