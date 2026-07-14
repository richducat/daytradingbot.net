#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "commercial Mac builds require macOS"
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

apple_team_id="${DAYTRADINGBOT_APPLE_TEAM_ID:-WN3K69XEP4}"
notary_profile="${DAYTRADINGBOT_NOTARY_PROFILE:-daytradingbot-notary}"
signing_line="$(security find-identity -v -p codesigning | grep 'Developer ID Application:' | grep "($apple_team_id)" | head -n 1 || true)"
signing_identity="${signing_line%% \"Developer ID Application:*}"
signing_identity="${signing_line#*\"}"
signing_identity="${signing_identity%\"*}"

if [[ -z "$signing_line" || -z "$signing_identity" ]]; then
  print -u2 "Developer ID Application certificate for Apple team $apple_team_id is unavailable."
  print -u2 "The Apple Account Holder must create and install it before a public web-download build can be signed."
  exit 1
fi

if ! xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null 2>&1; then
  print -u2 "Apple notarization profile '$notary_profile' is unavailable."
  print -u2 "Store the Account Holder-approved notary credentials in Keychain before release."
  exit 1
fi

export APPLE_SIGNING_IDENTITY="$signing_identity"

pnpm --filter @daytradingbot/desktop tauri build \
  --target universal-apple-darwin \
  --bundles app dmg

app_path="target/universal-apple-darwin/release/bundle/macos/DayTradingBot.app"
dmg_path="target/universal-apple-darwin/release/bundle/dmg/DayTradingBot_0.1.0_universal.dmg"

codesign --verify --deep --strict "$app_path"
team_identifier="$(codesign -dvv "$app_path" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}')"
if [[ "$team_identifier" != "$apple_team_id" ]]; then
  print -u2 "release signature used Apple team '$team_identifier', expected '$apple_team_id'"
  exit 1
fi

xcrun notarytool submit "$dmg_path" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$app_path"
xcrun stapler staple "$dmg_path"
xcrun stapler validate "$dmg_path"
spctl --assess --type open --context context:primary-signature -vv "$dmg_path"

mkdir -p outputs
cp -f "$dmg_path" outputs/DayTradingBot-0.1.0-macos-universal.dmg
shasum -a 256 outputs/DayTradingBot-0.1.0-macos-universal.dmg \
  > outputs/DayTradingBot-0.1.0-macos-universal.dmg.sha256

print "commercial Mac dmg: outputs/DayTradingBot-0.1.0-macos-universal.dmg"
