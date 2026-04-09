# Phase 10: Build & Package

**Status**: Done

## Overview
ParentSync is a private-use desktop app. There is no separate dev/prod environment — the app is compiled into a standalone executable that runs directly on the user's machine. No server hosting, no Docker, no monitoring infrastructure.

## Task 10.1: Build Standalone Executable
**Description**: Compile the full app (backend + frontend + Electron) into a single self-contained executable for Linux. Cross-platform builds for Windows and macOS are also supported via electron-builder.

**Dependencies**: All development tasks complete

**What needs to be done**:
- **Build all components**:
  - `npm run build:all` — compiles backend (TypeScript → dist/), frontend (Vite production build), and Electron main process
  - Rebuild native modules for Electron: `npm run rebuild:native`
- **Package for Linux (primary target)**:
  - `npm run package:linux` — produces `.AppImage` (portable, no install needed) and `.deb` (Debian/Ubuntu)
  - Output goes to `release/` directory
  - AppImage is a single file: make executable with `chmod +x` and run directly
- **Cross-platform packaging** (if needed):
  - `npm run package:win` — Windows `.exe` installer (NSIS)
  - `npm run package:mac` — macOS `.dmg`
  - `npm run package` — build for all platforms
- **Versioning**:
  - Set version in root `package.json`
  - Tag release in git

**Success Criteria**:
- [x] `npm run package:linux` produces a working `.AppImage` (174MB) and `.deb` (126MB)
- [x] AppImage is a valid ELF 64-bit executable
- [x] All features packaged (WhatsApp sync, calendar, settings)
- [x] SQLite database stored in `~/.config/ParentSync/`
- [x] Installer size reasonable (AppImage 174MB, deb 126MB)

**Acceptance**: A standalone executable that can be copied to any Linux machine and run without any external dependencies or setup beyond the app itself.
