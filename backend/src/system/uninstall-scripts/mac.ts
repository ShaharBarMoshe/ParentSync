import { GeneratedScript, UninstallScriptInput } from './types';

export function generateMacScript(input: UninstallScriptInput): GeneratedScript {
  const { removeUserData, homeDir, logPath } = input;

  const purgeBlock = removeUserData
    ? `
log "Removing user data..."
rm -rf "${homeDir}/Library/Application Support/ParentSync"
rm -rf "${homeDir}/Library/Logs/ParentSync"
rm -rf "${homeDir}/Library/Caches/com.parentsync.app"
rm -f  "${homeDir}/Library/Preferences/com.parentsync.app.plist"
rm -rf "${homeDir}/Library/Saved Application State/com.parentsync.app.savedState"
`
    : `
log "Skipping user data removal (kept by user choice)."
`;

  const content = `#!/usr/bin/env bash
# ParentSync uninstall script — macOS — generated at runtime. Idempotent.

LOG="${logPath}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG"
}

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
log "ParentSync uninstall starting (removeUserData=${removeUserData})"

sleep 2
log "Quitting any running ParentSync instance..."
osascript -e 'quit app "ParentSync"' 2>/dev/null || true
sleep 1
killall -9 ParentSync 2>/dev/null || true
sleep 1

log "Removing application bundle..."
rm -rf "/Applications/ParentSync.app"

log "Removing LaunchAgent (if any)..."
launchctl unload "${homeDir}/Library/LaunchAgents/com.parentsync.app.plist" 2>/dev/null || true
rm -f "${homeDir}/Library/LaunchAgents/com.parentsync.app.plist"
${purgeBlock}
log "ParentSync uninstall complete."
exit 0
`;

  return {
    filename: 'parentsync-uninstall.sh',
    content,
    interpreter: 'bash',
  };
}
