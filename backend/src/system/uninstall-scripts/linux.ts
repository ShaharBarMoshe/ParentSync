import { GeneratedScript, UninstallScriptInput } from './types';

/**
 * Builds the Linux cleanup script. Idempotent — every step tolerates the
 * target already being absent. Logs each action to `logPath` so the user can
 * verify after the app has quit.
 */
export function generateLinuxScript(input: UninstallScriptInput): GeneratedScript {
  const { removeUserData, homeDir, logPath } = input;

  const purgeBlock = removeUserData
    ? `
log "Removing user data (database, OAuth tokens, WhatsApp session, logs)..."
rm -rf "${homeDir}/.config/parentsync"
`
    : `
log "Skipping user data removal (kept by user choice)."
`;

  const content = `#!/usr/bin/env bash
# ParentSync uninstall script — generated at runtime.
# Idempotent; safe to re-run.

LOG="${logPath}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG"
}

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
log "ParentSync uninstall starting (removeUserData=${removeUserData})"

# 1. Give the API response time to reach the browser, then make sure the app
#    is fully stopped before we start removing files.
#
# IMPORTANT: pkill patterns must NOT match this script itself (its path
# contains "parentsync"). We anchor on the AppImage filename and the
# inner Electron process's --no-sandbox flag.
sleep 2
log "Stopping running ParentSync processes..."
systemctl --user stop parentsync.service 2>/dev/null || true
pkill -f 'ParentSync\\.AppImage' 2>/dev/null || true
pkill -f 'parentsync --no-sandbox' 2>/dev/null || true
sleep 1

# 2. Disable + remove the systemd user unit.
log "Disabling systemd user unit..."
systemctl --user disable parentsync.service 2>/dev/null || true
rm -f "${homeDir}/.config/systemd/user/parentsync.service"
systemctl --user daemon-reload 2>/dev/null || true

# 3. Remove the AppImage symlink, versioned copies, desktop entry, icons.
log "Removing app binary, versioned copies, desktop entry..."
rm -f  "${homeDir}/.local/bin/ParentSync.AppImage"
rm -rf "${homeDir}/.local/share/parentsync"
rm -f  "${homeDir}/.local/share/applications/parentsync.desktop"
rm -f  "${homeDir}/Desktop/ParentSync.desktop"
# Icons that install-local.sh copied into hicolor
find "${homeDir}/.local/share/icons/hicolor" -name 'parentsync.png' -delete 2>/dev/null || true

# 4. .deb removal (best-effort, requires sudo). If polkit is around, prompt
#    the user; otherwise just tell them to run it manually.
if command -v dpkg >/dev/null 2>&1 && dpkg -l parentsync 2>/dev/null | grep -q '^ii'; then
  log "ParentSync .deb is installed — attempting pkexec dpkg -r"
  if command -v pkexec >/dev/null 2>&1; then
    pkexec dpkg -r parentsync >> "$LOG" 2>&1 || log "pkexec dpkg -r failed; run 'sudo apt remove parentsync' manually."
  else
    log "pkexec not available — run 'sudo apt remove parentsync' manually."
  fi
fi
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
