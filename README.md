# ParentSync

A private-use desktop application that aggregates WhatsApp channels and Gmail emails into a unified task manager, using LLM-powered parsing to automatically create events on a family Google Calendar.

Events can optionally go through a **WhatsApp approval channel** before syncing to Google Calendar — react 👍 to approve or 😢 to reject. Reactions can arrive in any order and at any time.

Runs as a standalone desktop app via Electron. Also works in the browser during development.

### Platform Support

| Platform | Format | Status |
|----------|--------|--------|
| **Linux** | `.AppImage` (portable) / `.deb` | Primary target |
| Windows | `.exe` (NSIS installer) | Supported via electron-builder |
| macOS | `.dmg` | Supported via electron-builder |

## Prerequisites

- Node.js (v18+)
- npm
- Google Chrome (for WhatsApp Web integration)

## Setup

Run the setup script — it handles everything automatically:

```bash
./setup.sh
```

The script is idempotent (safe to run multiple times). It will:

1. **Check prerequisites** — Node.js v18+, npm, Google Chrome
2. **Install dependencies** — root, backend, and frontend (skips if already up to date)
3. **Configure environment** — creates `backend/.env` from template if missing
4. **Build the project** — backend, frontend, and Electron (skips if already up to date)

After the script finishes, you may need to configure:

| What | How |
|------|-----|
| **OpenRouter API key** (required) | Configure via Settings UI or `POST /api/settings` with key `openrouter_api_key` ([get one here](https://openrouter.ai/keys)) |
| **Google OAuth** (for Gmail & Calendar) | Configure `google_client_id` and `google_client_secret` via Settings UI ([get credentials from Google Cloud Console](https://console.cloud.google.com/apis/credentials)) |

## Building & Running

### Build the Standalone Executable

```bash
# Build and package for Linux (produces .AppImage + .deb in release/)
npm run package:linux
```

The `.AppImage` is a single portable file — no installation needed:

```bash
chmod +x release/ParentSync-*.AppImage
./release/ParentSync-*.AppImage
```

For other platforms:

```bash
npm run package:win    # Windows .exe installer
npm run package:mac    # macOS .dmg
npm run package        # All platforms
```

### Development Mode

For development with hot-reload:

```bash
# Desktop (Electron + hot-reload frontend + backend)
npm run electron:dev

# Or browser mode (two terminals):
cd backend && npm run start:dev    # Terminal 1 — backend (localhost:3000)
cd frontend && npm run dev         # Terminal 2 — frontend (localhost:5173)
```

### What the App Does

- Starts the NestJS backend embedded in the Electron main process
- Serves the React frontend from built files
- Stores the SQLite database in the OS user-data directory
- System tray icon with quick actions (Sync Now, Quit)
- Shows WhatsApp QR code in-app for authentication

## Project Structure

```
parentsync/
  electron/          # Electron main process (main.ts, preload.ts)
  backend/           # NestJS API server
  frontend/          # React + Vite frontend
  assets/            # App icons
  plan/              # Implementation plan
  package.json       # Root: Electron deps + build scripts
```

## Data Storage

In desktop mode, all data is stored locally in the OS user-data directory:

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%/ParentSync/` |
| macOS    | `~/Library/Application Support/ParentSync/` |
| Linux    | `~/.config/ParentSync/` |

This includes the SQLite database, WhatsApp session, and OAuth tokens.

## Event Approval

When an **Approval Channel** is configured in Settings (a WhatsApp group name), newly parsed events are sent to that group with an ICS file attachment instead of syncing directly to Google Calendar.

- React **👍** on the message to approve — the event syncs to Google Calendar
- React **😢** to reject — the event is marked as rejected and not synced
- Reactions can be given in any order, at any time, independently per event
- If no approval channel is configured, events sync automatically

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/docs` — Swagger API documentation
- `GET /api/whatsapp/status` — WhatsApp connection status
- `POST /api/whatsapp/reconnect` — Reconnect WhatsApp (triggers QR)
- `GET /api/whatsapp/events` — SSE stream for WhatsApp QR and status events

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the system is designed, data flow, key decisions
- [Onboarding Guide](docs/ONBOARDING.md) — step-by-step setup, first launch, troubleshooting
- [User Guide](docs/USER-GUIDE.md) — how to use every feature in the app

## Testing

```bash
# Backend unit tests
cd backend && npm test

# Backend e2e tests
cd backend && npm run test:e2e
```
