#!/usr/bin/env bash
# Install the Mac-side Hermes image bridge as a LaunchAgent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/hermes-image-bridge.py"
PYTHON="${HERMES_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}"
ENV_FILE="$HOME/.hermes/image-bridge.env"
PLIST="$HOME/Library/LaunchAgents/com.creator-inbox.hermes-image.plist"
LABEL="com.creator-inbox.hermes-image"
LOG="$HOME/Library/Logs/creator-inbox-hermes-image.log"

if [[ ! -x "$PYTHON" ]]; then
  echo "Hermes python not found: $PYTHON" >&2
  exit 1
fi
if [[ ! -f "$SCRIPT" ]]; then
  echo "bridge script missing: $SCRIPT" >&2
  exit 1
fi

mkdir -p "$HOME/.hermes" "$(dirname "$PLIST")" "$(dirname "$LOG")"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  echo "HERMES_IMAGE_TOKEN=$(openssl rand -hex 24)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON}</string>
    <string>${SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>HERMES_IMAGE_HOST</key>
    <string>0.0.0.0</string>
    <key>HERMES_IMAGE_PORT</key>
    <string>8879</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
echo "loaded $LABEL"
echo "health: curl -sS -H \"Authorization: Bearer \$(sed -n 's/^HERMES_IMAGE_TOKEN=//p' $ENV_FILE)\" http://127.0.0.1:8879/health"
