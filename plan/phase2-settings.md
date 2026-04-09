# Phase 2: User Settings & Configuration

**Status**: Done

## Task 2.1: User Settings UI Component (React)
**Description**: Build UI component for users to configure app (WhatsApp channels, sync times, Google Calendar).

**Dependencies**: Task 1.1, Task 1.3

**What needs to be done**:
- Create React component `SettingsPage.tsx` with sections:
  - **WhatsApp Connection**: Connection status indicator, QR code modal for authentication, Reconnect button
  - **Google Accounts**: Two separate sign-in cards (Gmail for email scanning, Calendar for family calendar) — each shows connected email and disconnect option
  - **Children**: Per-child configuration cards (name, WhatsApp channels as chip inputs, teacher emails, calendar color picker with 11 Google Calendar colors). Add/edit/delete children. Last scan time display. See Phase 8 for details.
  - **OpenRouter**: API key input and model text input (e.g., `trinity-large-preview:free`)
  - **Google OAuth**: Client ID, Client Secret, Redirect URI inputs
  - **Sync Schedule**: Hour picker grid (0–23) with multi-select, shift+click range selection, All/None buttons, selected count display
  - **Event Approval**: Approval channel name input (WhatsApp group for event approval)
  - Save button, Reset button (restore last saved settings)
  - Status messages (idle/loading/saving/success/error)
- Add form validation (required fields, valid formats)
- Fetch current settings from API on mount
- Display loading states while saving
- **Note**: WhatsApp channels and teacher emails are managed per-child (not as global settings). Email address is shown in Google Accounts section. Calendar ID is implicitly set by the connected Google Calendar account.

**Success Criteria**:
- [x] Component renders without console errors
- [x] All input fields functional
- [x] Form validation shows error messages
- [x] Settings loaded from API on page load
- [x] Save button sends data to backend

**Testing**:
- React component unit tests (React Testing Library)
- Test form inputs and validation
- Mock API calls
- Test loading/success/error states

**Acceptance**: Settings UI functional and integrated with API

---

## Task 2.1b: UI/UX Improvement for Settings Page
**Description**: Improve the Settings page UI/UX using the `ui-ux-pro-max` skill for professional-grade design, typography, colors, and interaction patterns.

**Dependencies**: Task 2.1

**Reference**: See `.agents/skills/ui-ux-pro-max/SKILL.md` — use design system, typography, color palette, and UX guidelines data.

**What needs to be done**:
- Run `ui-ux-pro-max` skill to analyze and improve `SettingsPage.tsx`
- Apply design system recommendations (spacing, layout, visual hierarchy)
- Improve typography (font selection, sizing, weight hierarchy)
- Apply color palette (primary, secondary, accent, semantic colors for success/error/warning)
- Enhance form UX:
  - Better input field styling (focus states, hover effects, validation indicators)
  - Improved button styles (primary/secondary hierarchy, loading states)
  - Clear visual grouping of related settings (sections with headers)
  - Smooth transitions and micro-animations
- Add visual feedback for user actions (save confirmation, validation errors)
- Ensure consistent spacing and alignment

**Success Criteria**:
- [x] Settings page follows a cohesive design system
- [x] Typography hierarchy is clear and readable
- [x] Color palette applied consistently
- [x] Form inputs have proper focus/hover/error states
- [x] Visual grouping of related settings
- [x] Looks polished and professional

**Acceptance**: Settings page visually improved with professional UI/UX patterns

---

## Task 2.2: Settings Backend API & Persistence (NestJS SettingsModule)
**Description**: Implement NestJS SettingsModule with controller, service, DTOs, and repository.

**Dependencies**: Task 1.3, Task 2.1

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-feature-modules`, `api-use-dto-serialization`, `security-validate-all-input`, `api-use-pipes`.

**What needs to be done**:
- **Create SettingsModule** with NestJS CLI (`nest g resource settings`):
  - `SettingsController`: REST endpoints with Swagger decorators
    - `GET /api/settings` — retrieve current settings
    - `POST /api/settings` — save settings
    - `PUT /api/settings` — update settings
    - `DELETE /api/settings/:key` — delete specific setting
  - `SettingsService`: Business logic (injected via constructor — `di-prefer-constructor-injection`)
  - `SettingsRepository`: Database access via TypeORM (`arch-use-repository-pattern`)
- **Create DTOs with class-validator** (`security-validate-all-input`, `api-use-dto-serialization`):
  - `CreateSettingDto` — `@IsString()`, `@IsNotEmpty()` decorators
  - `UpdateSettingDto` — `PartialType(CreateSettingDto)`
  - Response serialized via `class-transformer` (`@Exclude()`, `@Expose()`)
- **Use NestJS pipes** for input transformation (`api-use-pipes`)
- **Error handling**: Throw `NotFoundException`, `BadRequestException` etc. (`error-throw-http-exceptions`)
- **Rate limiting** on endpoints via `@Throttle()` decorator (`security-rate-limiting`)

**Success Criteria**:
- [x] SettingsModule registered in AppModule
- [x] Controller endpoints functional with Swagger docs
- [x] DTOs validated via ValidationPipe (invalid data → 400)
- [x] Service uses repository via DI (injection token)
- [x] Proper NestJS HTTP exceptions returned
- [x] Rate limiting active

**Testing**:
- Unit tests for SettingsService using `Test.createTestingModule()` (`test-use-testing-module`)
- Mock repository in unit tests (`test-mock-external-services`)
- E2E tests with Supertest (`test-e2e-supertest`)
- Test all endpoints (GET, POST, PUT, DELETE)
- Test validation (invalid DTOs → 400)

**Acceptance**: SettingsModule working with proper NestJS patterns (DI, DTOs, guards, pipes)
