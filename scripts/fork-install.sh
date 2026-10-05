#!/bin/bash
# Builds this fork's macOS app, signs it with a local identity, and installs it
# over /Applications/T3 Code (Alpha).app.
#
#   scripts/fork-install.sh
#
# If the app is open, the script waits for it to quit before swapping the new
# build in, so a running copy is never replaced underneath itself.
#
# Signing uses a self-signed certificate kept in its own keychain. Every build
# then has the same designated requirement, so macOS keeps honouring "Always
# Allow" on the app's keychain item instead of asking again after each rebuild.
# The "-preview." version keeps the upstream updater away from the install.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="T3 Code (Alpha).app"
INSTALLED="/Applications/$APP_NAME"
EXECUTABLE="$INSTALLED/Contents/MacOS/T3 Code (Alpha)"
WORK="$HOME/Library/Caches/t3code-fork-build"
CONFIG="$HOME/.config/t3code-fork"
KEYCHAIN="$HOME/Library/Keychains/t3code-fork-signing.keychain-db"
KEYCHAIN_PASSWORD_FILE="$CONFIG/signing-keychain-password"
IDENTITY="T3 Code Fork Local Signing"
RUST_TARGET="aarch64-apple-darwin"
MONITOR="$REPO/native/resource-monitor/target/$RUST_TARGET/release/t3-resource-monitor"

log() { printf '[fork-install] %s\n' "$*"; }

ensure_identity() {
  if [[ ! -f "$KEYCHAIN" || ! -f "$KEYCHAIN_PASSWORD_FILE" ]]; then
    log "creating the local signing identity"
    mkdir -p "$CONFIG"
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
    local password scratch
    password="$(/usr/bin/openssl rand -hex 24)"
    scratch="$(mktemp -d)"
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$scratch/key.pem" -out "$scratch/cert.pem" -subj "/CN=$IDENTITY" \
      -extensions v3_cs -config <(printf '%s\n' \
        '[req]' 'distinguished_name=dn' '[dn]' '[v3_cs]' \
        'basicConstraints=critical,CA:FALSE' \
        'keyUsage=critical,digitalSignature' \
        'extendedKeyUsage=critical,codeSigning') 2>/dev/null
    /usr/bin/openssl pkcs12 -export -inkey "$scratch/key.pem" -in "$scratch/cert.pem" \
      -out "$scratch/identity.p12" -passout "pass:$password" -name "$IDENTITY"
    (umask 077 && printf '%s' "$password" >"$KEYCHAIN_PASSWORD_FILE")
    security create-keychain -p "$password" "$KEYCHAIN"
    security set-keychain-settings "$KEYCHAIN"
    security unlock-keychain -p "$password" "$KEYCHAIN"
    security import "$scratch/identity.p12" -k "$KEYCHAIN" -P "$password" -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$KEYCHAIN" >/dev/null
    rm -rf "$scratch"
  fi
  security unlock-keychain -p "$(cat "$KEYCHAIN_PASSWORD_FILE")" "$KEYCHAIN"
}

# The resource monitor is a Rust helper. Without a Rust toolchain, reuse the
# binary from the installed app; the build accepts a prebuilt one.
ensure_resource_monitor() {
  if [[ -x "$MONITOR" ]]; then return; fi
  local installed_monitor="$INSTALLED/Contents/Resources/resource-monitor/t3-resource-monitor"
  if [[ ! -x "$installed_monitor" ]]; then
    log "no resource monitor to reuse; install Rust or a release build first"
    exit 1
  fi
  mkdir -p "$(dirname "$MONITOR")"
  cp "$installed_monitor" "$MONITOR"
}

app_is_running() {
  # No pipe: under pipefail an early-exiting grep would report "not running".
  local processes
  processes="$(ps -axo comm=)"
  [[ "$processes" == *"$EXECUTABLE"* ]]
}

installed_version() {
  defaults read "$INSTALLED/Contents/Info" CFBundleShortVersionString 2>/dev/null || true
}

base_version="$(node -p "require('$REPO/apps/desktop/package.json').version.split('-')[0]")"
next_version="$(node -p "const [a, b, c] = '$base_version'.split('.').map(Number); [a, b, c + 1].join('.')")"
version="$next_version-preview.$(date +%Y%m%d).$(date +%H%M)"

ensure_identity
ensure_resource_monitor

log "building $version"
rm -rf "$WORK/out" "$WORK/stage"
mkdir -p "$WORK/out" "$WORK/stage"
PATH="$REPO/node_modules/.bin:$PATH" \
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  T3CODE_DESKTOP_REUSE_CAPTURE_HELPERS=true \
  node "$REPO/scripts/build-desktop-artifact.ts" \
  --platform mac --target zip --arch arm64 \
  --build-version "$version" --output-dir "$WORK/out" >"$WORK/build.log" 2>&1 || {
  tail -40 "$WORK/build.log"
  log "build failed; full log at $WORK/build.log"
  exit 1
}

ditto -x -k "$WORK/out/T3-Code-$version-arm64.zip" "$WORK/stage"
staged="$WORK/stage/$APP_NAME"

log "signing"
codesign --force --deep --keychain "$KEYCHAIN" --sign "$IDENTITY" "$staged" 2>"$WORK/codesign.log" || {
  cat "$WORK/codesign.log"
  log "signing failed"
  exit 1
}
codesign --verify --deep --strict "$staged"

if app_is_running; then
  log "built and signed; waiting for T3 Code to quit before installing"
  while app_is_running; do sleep 0.5; done
fi

previous="$(installed_version)"
if [[ -d "$INSTALLED" ]]; then
  if [[ "$previous" == *-preview.* ]]; then
    # An earlier build of this fork: reproducible, so not worth keeping.
    rm -rf "$INSTALLED"
  else
    mv "$INSTALLED" "$HOME/.Trash/T3 Code (Alpha) $previous $(date +%H%M%S).app"
  fi
fi
mv "$staged" "$INSTALLED"
rm -rf "$WORK/out" "$WORK/stage"

codesign --verify --deep --strict "$INSTALLED"
log "installed $(installed_version) (was ${previous:-nothing})"
