#!/usr/bin/env bash
set -euo pipefail

API_URL="${PUBLIC_API_URL:-https://api.daytradingbot.net}"
APP_ROOT="${DAYTRADINGBOT_APP_ROOT:-daytradingbot-api}"
SELECTOR_BIN="${DAYTRADINGBOT_SELECTOR_BIN:-/usr/sbin/cloudlinux-selector}"

healthy() {
  /usr/bin/curl --fail --silent --show-error --max-time 15 "$API_URL/healthz" >/dev/null 2>&1
}

ready() {
  /usr/bin/curl --fail --silent --show-error --max-time 15 "$API_URL/readyz" >/dev/null 2>&1
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

# This script only restores the API process and checks database readiness.
# It never connects to a brokerage, runs a strategy, or submits an order.
ready
