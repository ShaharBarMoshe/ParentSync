# ParentSync Web App - Implementation Plan

## Project Overview
**Goal**: Build a private-use desktop application that aggregates WhatsApp channels (via WhatsApp Web) and emails into a unified task manager, automatically parsing discussion content and creating calendar events on the family Google Calendar. Compiled into a standalone executable — no server deployment, no dev/prod split.

**Key Assumptions**:
- User has a family Google account on their computer with Calendar access
- WhatsApp Web integration handled by whatsapp-web.js (manages its own Chromium instance — no separate Chrome installation required)
- Single-user app — no app-level authentication, no dev/prod distinction
- Desktop app via Electron, packaged as a standalone executable (Linux primary, Windows/macOS supported)
- Also works in the browser during development

**Key Features**:
- WhatsApp channel monitoring at user-selected hours (configurable hour picker, 0–23)
- Email integration (via Gmail API)
- LLM-powered content parsing (OpenRouter)
- Automatic Google Calendar event creation
- **WhatsApp approval channel** — events sent to a WhatsApp group with ICS file; react 👍 to approve or 😢 to reject (any order, any time)
- User settings management
- Desktop app with system tray, native notifications, and one-click install
- In-app WhatsApp QR code authentication
- Local SQLite database (no external DB needed)

## Phases

| Phase | Description | Status |
|-------|-------------|--------|
| [Phase 1](phase1-foundation.md) | Foundation & Infrastructure | Done |
| [Phase 2](phase2-settings.md) | User Settings & Configuration | Done |
| [Phase 3](phase3-messages.md) | Message Acquisition | Done |
| [Phase 4](phase4-llm.md) | LLM Integration | Done |
| [Phase 5](phase5-calendar.md) | Calendar Event Management | Done |
| [Phase 6](phase6-frontend.md) | Frontend UI & Dashboard | Done |
| [Phase 7](phase7-dual-google-auth.md) | Dual Google Account Authentication | Done |
| [Phase 8](phase8-child-settings.md) | Child-Based Settings & Per-Child Scanning | Done |
| [Phase 9](phase9-testing.md) | Testing & Polish | Done |
| [Phase 10](phase10-deployment.md) | Build & Package (standalone executable) | Done |
| [Phase 11](phase11-monitor.md) | Monitor Tab — Analytics & Graphs | Done |
| [Phase 12](phase12-desktop.md) | Desktop App (Electron + Chrome) | Done |
| Phase 13 | WhatsApp Approval Channel (👍/😢 reactions) | Done |
| [Phase 14](phase14-api-security.md) | API Security Hardening (14 findings) | Done |
| [Phase 15](phase15-qa-test-plan.md) | QA Test Plan Execution (91 test cases) | Done |
| [Phase 16](phase16-google-tasks.md) | Google Tasks Integration (date-only → Tasks, timed → Events) | Done |
| [Phase 17](phase17-batch-llm.md) | Batch LLM Parsing (all groups in single API call) | Done |

## Architecture

See [architecture.md](architecture.md) for the full architecture overview.

## Success Criteria Summary

- **Desktop app launches** with a single click (Electron) on Windows, macOS, and Linux
- **Frontend and backend** both running locally with no console errors
- **WhatsApp QR code** displayed in-app for authentication (no separate browser window)
- **Settings persist** in local SQLite database across app restarts
- **Messages sync** at user-defined times via backend cron
- **Events are created** from parsed messages (>=80% accuracy)
- **Events sync** to Google Calendar (directly or after WhatsApp approval)
- **Dashboard shows** recent messages and upcoming events
- **Calendar view** displays all synced events with filtering
- **System tray** — app minimizes to tray, continues syncing in background
- **Native notifications** for new calendar events
- **Data stored locally** in OS user-data directory
- **Unit test coverage** >= 80% (backend and frontend)
- **Integration/E2E tests** covering main user flows
- **Packaging** — standalone executable for Linux (.AppImage primary, .deb); Windows (.exe) and macOS (.dmg) also supported
