# Onboarding Guide

Get ParentSync running on your machine step by step.

## Prerequisites

- **Node.js** v18+ (`node --version`)
- **npm** (`npm --version`)
- **Google Chrome** (for WhatsApp Web — whatsapp-web.js uses Chromium internally)
- **libfuse2** (Linux only, for running AppImage): `sudo apt install libfuse2`

## Quick Start — pre-built download

Most users want a binary, not a build:

| Platform | Direct download |
|---|---|
| 🍎 macOS — Apple Silicon | [ParentSync-1.0.2-arm64.dmg](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2-arm64.dmg) |
| 🍎 macOS — Intel | [ParentSync-1.0.2.dmg](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2.dmg) |
| 🪟 Windows 10/11 | [ParentSync-Setup-1.0.2.exe](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-Setup-1.0.2.exe) |
| 🐧 Linux (any distro) | [ParentSync-1.0.2.AppImage](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/ParentSync-1.0.2.AppImage) |
| 🐧 Debian / Ubuntu | [parentsync_1.0.2_amd64.deb](https://github.com/ShaharBarMoshe/ParentSync/releases/download/v1.0.2/parentsync_1.0.2_amd64.deb) |

Or browse all assets on the [Releases page](https://github.com/ShaharBarMoshe/ParentSync/releases/latest).

## Quick Start — build from source

```bash
# 1. Clone and setup
git clone https://github.com/ShaharBarMoshe/ParentSync.git && cd ParentSync
./setup.sh

# 2. Package the app
npm run package:linux  # or :mac / :win

# 3. Run it
chmod +x release/ParentSync-*.AppImage
./release/ParentSync-*.AppImage
```

## First Launch Walkthrough

### Step 1: Configure Google OAuth

You need Google Cloud credentials to connect Gmail and Calendar. Prefer to follow along with a video? 📺 [Create OAuth 2.0 Client ID in Google Console (YouTube)](https://www.youtube.com/watch?v=-G6ak4E2rBg).

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select an existing one)
3. Enable **Gmail API** and **Google Calendar API** under APIs & Services > Enabled APIs
4. Go to **APIs & Services > OAuth consent screen**:
   - Choose "External" user type
   - Fill in the app name (e.g., "ParentSync")
   - Add your email to **Test users** (or click **Publish App** for unrestricted access)
5. Go to **APIs & Services > Credentials > Create Credentials > OAuth Client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:41932/api/auth/google/callback`
   - Copy the **Client ID** and **Client Secret**

> **Tip**: switch the OAuth consent screen from "Testing" to "In production" once you're done. Tokens issued in Testing mode expire after 7 days, which means sync will silently fail with `invalid_grant` until you re-authenticate. You don't need formal verification for personal use.

In the ParentSync Settings page:
- Paste the **Client ID** and **Client Secret** under "Google OAuth"
- Click **Save Settings**

### Step 2: Connect Google Accounts

Under "Google Accounts" in Settings:
- Click **Sign in with Google** for "Email Scanning" (Gmail)
- Click **Sign in with Google** for "Calendar" (can be same or different account)
- The browser opens Google's consent screen — authorize and you'll be redirected back to the app

**If you see "Error 403: access_denied"**: Go back to Google Cloud Console > OAuth consent screen and either add your email to the Test users list, or click Publish App.

### Step 3: Connect WhatsApp

1. Click **Connect WhatsApp** in Settings
2. A QR code appears in the app
3. On your phone: WhatsApp > Settings > Linked Devices > Link a Device
4. Scan the QR code
5. Status changes to "Connected"

The session persists across app restarts — you only need to scan once.

### Step 4: Add Children

Under "Children" in Settings:
1. Click **Add Child**
2. Set the child's name
3. Add WhatsApp channel names (the group names to monitor)
4. Optionally add teacher email addresses
5. Pick a calendar color
6. Click **Save**

### Step 5: Configure Sync Schedule

Under "Sync Schedule":
- Select the hours when the app should check for new messages (click hours, shift+click for ranges)
- Click **Save Settings**

### Step 6: Set Up the LLM provider

ParentSync uses **Gemini** by default, with **OpenRouter** as an alternative provider you can also configure.

**Option A — Gemini (default):**
1. Get an API key from [Google AI Studio](https://aistudio.google.com/apikey) — 📺 [video walkthrough](https://www.youtube.com/watch?v=GHzAxsXn24I)
2. Paste it under "Gemini AI" > "API Key" in Settings
3. The default model (`gemini-2.5-flash-lite`) is fast and cheap; change it only if you want a different model
4. Click **Save Settings**

**Option B — OpenRouter:**
1. Get an API key from [OpenRouter](https://openrouter.ai/keys) — 📺 [video walkthrough](https://www.youtube.com/watch?v=JYw6yFzVi44)
2. Paste it under "OpenRouter" > "API Key" in Settings
3. Pick a model
4. Click **Save Settings**

### Step 7: Test It

1. Go to the **Dashboard**
2. Click **Sync Now**
3. Watch the sync status — it should scan your configured WhatsApp channels and emails
4. Check the **Calendar** page for any created events

## Troubleshooting

### "dlopen(): error loading libfuse.so.2"
Install FUSE: `sudo apt install libfuse2`

Or extract and run without FUSE:
```bash
./release/ParentSync-*.AppImage --appimage-extract
./squashfs-root/parentsync
```

### "Error 403: access_denied" on Google sign-in
Your OAuth app is in Testing mode. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
- Go to OAuth consent screen
- Either add your email to Test users, or click **Publish App**

### "Google OAuth not configured"
You haven't entered the Client ID and Client Secret in Settings yet. See Step 1 above.

### WhatsApp QR code not appearing
- Click **Connect WhatsApp** in Settings
- If it shows an error, click **Back to Settings** and try again
- Make sure Google Chrome is installed (whatsapp-web.js needs Chromium)

### App doesn't close when clicking X
The app quits when you close the window. If it's still running, right-click the system tray icon and select **Quit**.

### Where is my data stored?

| What | Path (Linux) |
|------|------|
| Database | `~/.config/ParentSync/parentsync.db` |
| WhatsApp session | `~/.config/ParentSync/whatsapp-session/` |
| Logs | `~/.config/ParentSync/logs/app.log` |
| Encryption key | `~/.config/ParentSync/.encryption_key` |
| Window settings | `~/.config/ParentSync/app-config.json` |

## Creating a New Version

```bash
# Bump version (creates git tag)
npm version patch   # 1.0.1 → 1.0.2
npm version minor   # 1.0.2 → 1.1.0
npm version major   # 1.1.0 → 2.0.0

# Package
npm run package:linux

# Run
./release/ParentSync-*.AppImage
```

## Development Mode

For development with hot-reload (no packaging needed):

```bash
# Full desktop experience
npm run electron:dev

# Or browser-only (two terminals)
cd backend && npm run start:dev    # Terminal 1
cd frontend && npm run dev         # Terminal 2
# Open http://localhost:5173
```

## Running Tests

```bash
npm run test:backend     # 298 backend unit tests
npm run test:frontend    # 47 frontend tests
npm run test             # All tests + report
```
