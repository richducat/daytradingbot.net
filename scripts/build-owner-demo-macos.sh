#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "owner demo builds require macOS"
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

keychain_service="net.daytradingbot.owner-demo"
keychain_account="activation-code"
signing_identity="${DAYTRADINGBOT_OWNER_SIGNING_IDENTITY:-F9C5A2C0C0536C90002057AA77C5750A3D3AE0D4}"

if ! security find-identity -v -p codesigning | grep -Fq "$signing_identity"; then
  print -u2 "owner demo signing identity is unavailable"
  exit 1
fi

owner_code="$(security find-generic-password -a "$keychain_account" -s "$keychain_service" -w)"
owner_hash="$(printf '%s' "$owner_code" | shasum -a 256 | awk '{print $1}')"
unset owner_code

export APPLE_SIGNING_IDENTITY="$signing_identity"
export DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256="$owner_hash"

pnpm --filter @daytradingbot/desktop tauri build \
  --debug \
  --bundles app dmg \
  --features owner-demo-license \
  --config src-tauri/tauri.owner-demo.conf.json

app_path="target/debug/bundle/macos/DayTradingBot Owner Demo.app"
dmg_path="target/debug/bundle/dmg/DayTradingBot Owner Demo_0.1.0_aarch64.dmg"

codesign --verify --deep --strict "$app_path"
requirement="$(codesign -d -r- "$app_path" 2>&1)"
if [[ "$requirement" != *'identifier "net.daytradingbot.desktop.owner-demo" and anchor apple generic'* \
  || "$requirement" != *'certificate leaf[subject.CN] = "Apple Development: Richard Ducat (8693ZX8668)"'* ]]; then
  print -u2 "owner demo build does not have the required stable Apple signature"
  exit 1
fi

mkdir -p outputs
cp -f "$dmg_path" outputs/DayTradingBot-private-owner-demo-0.1.0-arm64-debug.dmg
print "owner demo app: $app_path"
print "owner demo dmg: outputs/DayTradingBot-private-owner-demo-0.1.0-arm64-debug.dmg"
