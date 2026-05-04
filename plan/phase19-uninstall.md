# Phase 19: One-Click Uninstall From Settings

**Status**: Planned

## Overview

Today removing ParentSync requires the user to know about systemd unit files, AppImage symlinks, the user-data directory, and the WhatsApp Web session — all of which live in different places on each OS. This phase adds a single **"Uninstall ParentSync"** button to Settings that wipes the app and (optionally) the user data on macOS, Windows, and Linux.

The feature is small in concept but the actual file paths and ownership models are very different between platforms, so the bulk of the plan is per-OS specifics, plus the "be careful, this is destructive" UX scaffolding.

### Scope

- ✅ A Settings → Danger Zone section with the button.
- ✅ Two-step confirmation (modal asking the user to type `UNINSTALL` to confirm).
- ✅ Two options: (a) remove the app only, keep user data; (b) remove everything including database, OAuth tokens, WhatsApp session, logs.
- ✅ Backend endpoint that writes a small platform-specific cleanup script and triggers Electron quit; the script runs after Electron has exited and removes everything we can't remove from inside a running process.
- ✅ Final state: no leftover binaries, no daemon, no autostart entry. The user's WhatsApp account is left **un-linked** (we tell WhatsApp Web to log out so the user's phone reflects it).
- ❌ *Not in scope:* a polished progress UI for the cleanup script — it runs detached. We just print where the log lives so the user can sanity-check.

### Why a button instead of "just delete the app"

`Applications → drag to Trash` (mac) and `Settings → Apps → Uninstall` (Windows) handle the binary fine but do not touch:
- The user-data directory (database, OAuth tokens at rest, WhatsApp Web session, logs)
- The systemd user unit on Linux that auto-starts the app
- The Electron app config (`app-config.json`)
- The encryption key (which protects OAuth tokens — leftover with no app to use it is meaningless but a privacy hygiene concern)

A button means "I want this gone" reliably reaches all of the above.

---

## Per-platform cleanup matrix

What needs to be removed on each OS:

| Item | Linux | macOS | Windows |
|---|---|---|---|
| App binary | `~/.local/bin/ParentSync.AppImage`, `~/.local/share/parentsync/versions/` | `/Applications/ParentSync.app` | NSIS uninstaller (`%LOCALAPPDATA%\Programs\ParentSync\uninstall.exe`) |
| `.deb` (if installed that way) | `dpkg -r parentsync` | — | — |
| Auto-start entry | `~/.config/systemd/user/parentsync.service` (stop, disable, rm) | `~/Library/LaunchAgents/com.parentsync.app.plist` | `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run\ParentSync` |
| Desktop entry | `~/.local/share/applications/parentsync.desktop` | (Launchpad — handled by .app removal) | Start menu shortcut (handled by NSIS) |
| User data | `~/.config/parentsync/` | `~/Library/Application Support/ParentSync/` | `%APPDATA%\ParentSync\` |
| Logs | `~/.config/parentsync/logs/` (subset of above) | `~/Library/Logs/ParentSync/` | `%APPDATA%\ParentSync\logs\` |
| Encryption key | `~/.config/parentsync/.encryption_key` | inside Application Support dir | inside `%APPDATA%\ParentSync` |
| WhatsApp Web session | `~/.config/parentsync/whatsapp-session/` | inside Application Support | inside `%APPDATA%\ParentSync` |
| OS Preferences plist | — | `~/Library/Preferences/com.parentsync.app.plist`, saved-state | Registry keys under `HKCU\Software\ParentSync` |

---

## Task 19.1: Backend orchestrator

**Description**: Add `POST /api/system/uninstall` that prepares the cleanup and triggers Electron to quit.

**What needs to happen**:
- New `SystemController` in `SharedModule` (or a new `SystemModule`).
- DTO with one boolean: `removeUserData`.
- The handler:
  1. Tries to log out of WhatsApp Web cleanly (`client.logout()`) so the user's phone shows the device as unlinked.
  2. Closes any open file handles to the SQLite DB (TypeORM `dataSource.destroy()`).
  3. Writes a small per-platform shell script (or `.bat` on Windows) to a temp location that:
     - Sleeps a few seconds (so Electron has actually exited).
     - Removes everything from the matrix above.
     - On Linux only: stops + disables the systemd unit before removing it.
     - On Windows: runs the NSIS uninstaller silently (`/S` flag) — that handles binary + Start menu + uninstall registry; only user data needs separate removal.
   4. Spawns the script detached (`subprocess.spawn(..., { detached: true, stdio: 'ignore' }).unref()`).
  5. Sends an IPC `app:quit` message that Electron uses to call `app.quit()` cleanly.

**Files to touch**:
- `backend/src/system/system.controller.ts` (new)
- `backend/src/system/system.service.ts` (new)
- `backend/src/system/uninstall-scripts/{linux,mac,windows}.ts` (new — generators that produce the per-OS cleanup script as a string)
- `backend/src/app.module.ts`
- `electron/main.ts` (handle `app:quit` IPC)

**Acceptance**:
- Calling the endpoint with `removeUserData: false` leaves the user-data dir alone, removes the binary + autostart.
- Calling it with `removeUserData: true` removes everything in the matrix.
- The cleanup script is idempotent — safe to run twice.
- Script logs to `~/parentsync-uninstall.log` (or platform equivalent) so the user can verify.

---

## Task 19.2: Frontend "Danger Zone"

**Description**: New section at the bottom of Settings.

**Layout**:

```
┌─ Danger Zone ──────────────────────────────────┐
│                                                │
│  Uninstall ParentSync                          │
│  This removes the app, the auto-start entry,   │
│  and (optionally) all of your data.            │
│                                                │
│  ☐ Also remove my data (database, OAuth        │
│    tokens, WhatsApp session, logs)             │
│                                                │
│  [ Uninstall ParentSync ]                      │
│                                                │
└────────────────────────────────────────────────┘
```

Clicking the button opens a confirmation modal that asks the user to type the literal string `UNINSTALL`. Only when the input matches is the **Confirm** button enabled. The modal also tells the user the destination of the cleanup log so they can verify after relaunch.

**Files to touch**:
- `frontend/src/components/UninstallModal.tsx` (new)
- `frontend/src/pages/SettingsPage.tsx` (mount + button)
- `frontend/src/services/api.ts` (`systemApi.uninstall(removeUserData)`)
- `frontend/src/scss/components/_uninstall.scss` (new — red-tinted card)
- `frontend/src/scss/main.scss` (import)

**Acceptance**:
- Button is visually distinct (red border, red icon).
- Confirmation modal can't be bypassed by Enter — must type the word.
- After click → endpoint call → app quits within ~2 seconds.

---

## Task 19.3: Per-platform cleanup scripts

**Description**: The actual scripts the orchestrator writes out.

### 19.3a Linux (`scripts/uninstall-linux.sh`)
```bash
#!/usr/bin/env bash
sleep 2

# Stop + disable the systemd user service if present
systemctl --user stop parentsync.service 2>/dev/null || true
systemctl --user disable parentsync.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/parentsync.service"
systemctl --user daemon-reload

# Binary + versions
rm -f  "$HOME/.local/bin/ParentSync.AppImage"
rm -rf "$HOME/.local/share/parentsync"
rm -f  "$HOME/.local/share/applications/parentsync.desktop"
rm -f  "$HOME/Desktop/ParentSync.desktop"

# .deb if installed that way (best-effort, requires sudo — only attempted
# when the user already auth'd a polkit prompt; otherwise the user is told
# to run apt remove themselves)
if command -v dpkg >/dev/null && dpkg -l parentsync 2>/dev/null | grep -q '^ii'; then
  pkexec dpkg -r parentsync 2>/dev/null || true
fi

# User data (only when removeUserData=true)
if [[ "$1" == "--purge" ]]; then
  rm -rf "$HOME/.config/parentsync"
fi
```

### 19.3b macOS (`scripts/uninstall-mac.sh`)
```bash
#!/usr/bin/env bash
sleep 2

# Wait for the running app to actually quit (Electron sends SIGTERM via app:quit)
# then remove the bundle.
osascript -e 'quit app "ParentSync"' 2>/dev/null || true
sleep 1
rm -rf "/Applications/ParentSync.app"

# LaunchAgent if any
launchctl unload "$HOME/Library/LaunchAgents/com.parentsync.app.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.parentsync.app.plist"

# Saved-state
rm -rf "$HOME/Library/Saved Application State/com.parentsync.app.savedState"
rm -f  "$HOME/Library/Preferences/com.parentsync.app.plist"

# User data
if [[ "$1" == "--purge" ]]; then
  rm -rf "$HOME/Library/Application Support/ParentSync"
  rm -rf "$HOME/Library/Logs/ParentSync"
  rm -rf "$HOME/Library/Caches/com.parentsync.app"
fi
```

### 19.3c Windows (`scripts/uninstall-windows.ps1`)
```powershell
Start-Sleep -Seconds 2

# Run the NSIS uninstaller silently (/S flag)
$uninstaller = "$env:LOCALAPPDATA\Programs\ParentSync\Uninstall ParentSync.exe"
if (Test-Path $uninstaller) {
  Start-Process $uninstaller -ArgumentList "/S" -Wait
}

# Run-on-login
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "ParentSync" -ErrorAction SilentlyContinue

# User data
if ($args[0] -eq "--purge") {
  Remove-Item -Recurse -Force "$env:APPDATA\ParentSync" -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ParentSync" -ErrorAction SilentlyContinue
}
```

**Acceptance per script**:
- Idempotent — runs cleanly when targets are already absent.
- Logs to a known file (`~/parentsync-uninstall.log` on \*nix, `%TEMP%\parentsync-uninstall.log` on Windows).
- Returns clean exit code.

---

## Task 19.4: Tests

- Unit test for the script generators (each platform's generator returns a string that contains the expected `rm` / `Remove-Item` lines).
- Manual QA (one-off per platform):
  - Run a fresh install, configure something (e.g. add a child), click Uninstall with "remove my data" checked. Verify nothing is left behind.
  - Repeat without the checkbox — verify user-data dir is preserved and a re-install picks up where it left off.

---

## Task 19.5: Docs

- New "Uninstalling" section in `docs/USER-GUIDE.md` covering the in-app button (when shipped) and the manual steps for users who'd rather not run it.
- New slide in the presentation deck.

---

## Risks & Open Questions

- **WhatsApp Web logout**: `client.logout()` requires the WhatsApp client to be initialised. If the app is in a broken state where the client never came up, we should still remove the local session files.
- **AppImage running a script that removes itself**: works on Linux because of how the AppImage mounts; the cleanup script just needs to run *after* the AppImage exits. On macOS removing a running `.app` is fine; just the running process keeps its inode.
- **Permission escalation on Linux for .deb removal**: `pkexec` requires polkit. If unavailable (e.g. headless), we tell the user to run `sudo apt remove parentsync` manually. The script logs which path applies.
- **Windows Defender** may flag the silent uninstall — we use the standard NSIS uninstaller invocation, which is the common pattern, so this should be fine in practice.
- **Re-install after uninstall**: if `removeUserData=false`, a future install needs to find the existing user-data dir — that's the default Electron behaviour anyway.

---

## Sequencing

1. 19.3 first (write the scripts) — verifiable in isolation.
2. 19.1 (backend orchestrator) — wires the scripts.
3. 19.2 (frontend) — UX layer.
4. 19.4 + 19.5 — tests + docs.

Estimated total: ~1 focused dev session for Linux end-to-end, plus ~half a day per OS for the platform-specific QA.
