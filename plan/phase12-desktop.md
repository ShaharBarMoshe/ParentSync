# Phase 12: Desktop App (Electron + Chrome)

**Status**: Done

## Overview
Package ParentSync as a standalone desktop application that launches with a single click. Uses Electron to wrap the existing frontend and backend into a native executable. WhatsApp Web integration is handled by whatsapp-web.js (which internally uses Puppeteer) — no separate Chrome detection or launch is needed.

**Key Assumptions**:
- Target platforms: Linux (primary), Windows, macOS
- Backend runs as a child process (fork) from Electron's main process
- SQLite remains the database (no external DB needed)
- Database file stored in the OS user-data directory (`app.getPath('userData')`) — e.g. `%APPDATA%/ParentSync/` on Windows, `~/Library/Application Support/ParentSync/` on macOS, `~/.config/ParentSync/` on Linux

---

## Task 12.1: Electron Shell Setup
**Description**: Set up Electron to wrap the existing React frontend and embedded NestJS backend.

**Dependencies**: Phase 6 (Frontend UI)

**What needs to be done**:
- **Initialize Electron project**:
  - Add `electron`, `electron-builder` as dev dependencies
  - Create `electron/main.ts` — Electron main process entry point
  - Create `electron/preload.ts` — secure bridge between renderer and main process
- **Embed NestJS backend**:
  - Start NestJS backend as a child process via `fork()` (not in-process `NestFactory.create()`)
  - Auto-find available port starting from 3000
  - Wait for "listening on" or "successfully started" log message (with 8-second timeout fallback)
  - Pass the chosen port to the renderer via IPC handler (`get-backend-url` returns `http://127.0.0.1:PORT/api`)
- **Local data storage**:
  - Use Electron's `app.getPath('userData')` as the root for all persistent data
  - Store SQLite database file at `<userData>/parentsync.db`
  - Store Chrome user-data-dir for WhatsApp sessions at `<userData>/chrome-profile/`
  - Store OAuth tokens at `<userData>/tokens/` (encrypted)
  - Ensure directories are created on first launch
  - Pass the resolved DB path to NestJS TypeORM config via environment or programmatic config
- **Load React frontend**:
  - In development: load from Vite dev server (`http://localhost:5173`)
  - In production: serve the built `frontend/dist/` via `file://` protocol or embedded static server
- **Window configuration**:
  - Set app title, icon, default window size (1280x800)
  - Full native menus (File, Edit, View, Help) — see Task 12.5
  - Enable DevTools only in development mode
- **IPC handlers**:
  - `get-backend-url` — returns backend API URL
  - `get-app-info` — returns version, userData path, dbPath, isFirstRun
  - `set-first-run-done` — marks onboarding complete
  - `show-notification` — native desktop notifications
  - `open-external` — opens URLs in system browser

**Success Criteria**:
- [x] `npm run electron:dev` launches a desktop window showing the React frontend
- [x] Backend API is accessible from the renderer process
- [x] Window has proper title and icon
- [x] No external network ports exposed (localhost only)

---

## Task 12.2: WhatsApp Web Integration (In-App)
**Description**: WhatsApp Web connection with in-app QR code display, using whatsapp-web.js.

**Dependencies**: Task 12.1, Phase 3 (Messages)

**What needs to be done**:
- **WhatsApp via whatsapp-web.js** (no separate Chrome detection/launch needed):
  - whatsapp-web.js internally manages its own Puppeteer/Chromium instance
  - `LocalAuth` strategy persists session in `<userData>/whatsapp-session/`
  - No need to detect or launch user's Chrome — whatsapp-web.js handles this
- **WhatsApp QR authentication (in-app)**:
  - whatsapp-web.js emits QR code as a string on the `qr` event
  - Backend emits QR via `EventEmitter2` ('whatsapp.qr' event)
  - Frontend receives QR via SSE stream (`GET /api/whatsapp/events`)
  - QR displayed in a `WhatsAppQRModal` component inside the Electron app UI
  - Connection status indicators: "Waiting for QR scan...", "Connected", "Session expired"
  - Trigger QR flow on: first launch, session expired, or user clicks "Reconnect WhatsApp" in Settings
  - Session persists via `LocalAuth` (no re-login needed between app restarts)
- **Preload bridge**:
  - `onWhatsAppQR(callback)` — event listener for QR code display
  - `onWhatsAppStatus(callback)` — event listener for connection status
  - `onTriggerSync(callback)` — sync trigger from tray menu
- **Lifecycle management**:
  - whatsapp-web.js client initialized on module start, destroyed on module shutdown
  - Stale lock file cleanup prevents stuck Chrome processes
  - 90-second initialization timeout

**Success Criteria**:
- [x] QR code displayed inside the app UI (no separate browser window)
- [x] Successful scan transitions to "Connected" state
- [x] Session expired triggers automatic re-scan prompt in-app
- [x] WhatsApp Web session persists across app restarts
- [x] Graceful cleanup on app exit

---

## Task 12.3: System Tray & Background Operation
**Description**: Allow the app to minimize to system tray and continue syncing in the background.

**Dependencies**: Task 12.1

**What needs to be done**:
- **System tray icon**:
  - Add tray icon with context menu (Open, Sync Now, Quit)
  - Minimize to tray on window close (instead of quitting)
  - Double-click tray icon to restore window
- **Background sync**:
  - NestJS cron jobs continue running when window is minimized/hidden
  - Show native OS notifications for new events created (via Electron `Notification` API)
- **Auto-start (optional)**:
  - Add option in settings to start app on system login
  - Use `electron-auto-launch` or OS-native autostart mechanisms

**Success Criteria**:
- [x] App minimizes to tray instead of closing
- [x] Sync continues in background
- [x] Native notifications shown for new calendar events
- [x] Tray menu works correctly

---

## Task 12.4: Packaging & Distribution
**Description**: Package the Electron app into installable executables for each platform.

**Dependencies**: Tasks 12.1–12.3

**What needs to be done**:
- **electron-builder configuration**:
  - Configure `electron-builder` in `package.json` or `electron-builder.yml`
  - Set app ID, product name, description, icons (multiple sizes)
  - Include compiled backend (`backend/dist/`) and frontend (`frontend/dist/`) in the package
  - Include `node_modules` production dependencies
- **Platform-specific builds**:
  - **Windows**: NSIS installer (`.exe`) — one-click install, desktop shortcut, Start Menu entry
  - **macOS**: `.dmg` with drag-to-Applications
  - **Linux**: `.AppImage` (portable) and `.deb` (Debian/Ubuntu)
- **Build scripts**:
  - `npm run build:desktop` — compile backend + frontend + Electron
  - `npm run package:win` / `package:mac` / `package:linux`
- **Code signing** (optional but recommended):
  - Windows: sign with code signing certificate to avoid SmartScreen warnings
  - macOS: sign and notarize for Gatekeeper
- **Auto-update** (optional):
  - Use `electron-updater` with GitHub Releases as update source
  - Check for updates on app start, prompt user to install

**Success Criteria**:
- [x] Windows `.exe` installer works — installs, creates shortcut, launches correctly
- [x] macOS `.dmg` works — drag to Applications, launches correctly
- [x] Linux `.AppImage` works — download, make executable, launches correctly
- [x] Installer size reasonable (< 150MB)
- [x] App launches with a single click after installation
- [x] All features work in packaged app (sync, calendar, settings)

---

## Task 12.5: Desktop-Specific UX Polish
**Description**: Adjust the UI and behavior for a native desktop feel.

**Dependencies**: Task 12.1, Phase 6 (Frontend UI)

**What needs to be done**:
- **Splash screen**: Show a branded loading screen while backend initializes
- **Native menus**: File > Quit, Help > About, Edit > Copy/Paste (keyboard shortcuts)
- **Window state persistence**: Remember window size and position across restarts
- **Error handling**: Show user-friendly dialogs (not browser alerts) for critical errors (e.g., Chrome not found, Google auth failed)
- **First-run detection**: `isFirstRun` flag stored in app config (IPC handler available), but no guided wizard UI implemented yet

**Success Criteria**:
- [x] Splash screen shown during startup
- [x] Window position/size remembered
- [ ] First-run experience guides new users (**not implemented** — infrastructure exists via `isFirstRun` flag but no UI flow)
- [x] App feels native, not like a browser window
