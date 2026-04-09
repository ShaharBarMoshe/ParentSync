# Phase 8: Child-Based Settings & Per-Child Scanning

**Status**: Done

## Task 8.1: Child Entity & Settings Redesign (Backend)

**Description**: Redesign the settings data model to be child-centric. Replace the flat settings form with a list of children, each with their own WhatsApp channels, teacher emails, and calendar color. Update the backend SettingsModule, entities, DTOs, and repository.

**Dependencies**: Task 2.2 (SettingsModule), Task 7.1 (Dual Google Auth)

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-feature-modules`, `arch-use-repository-pattern`, `api-use-dto-serialization`, `security-validate-all-input`. See `.agents/skills/architecture-patterns/SKILL.md` for Clean Architecture entity design.

**What needs to be done**:
- **Create `Child` TypeORM entity**:
  - `id` (UUID, primary key)
  - `name` (string, required) — child's display name
  - `channelNames` (string, nullable) — comma-separated WhatsApp channel names to monitor for this child (can be empty)
  - `teacherEmails` (string, nullable) — comma-separated teacher email addresses to filter Gmail messages (can be empty)
  - `calendarColor` (string, nullable) — Google Calendar color ID (from Google's supported palette); uses default if not set
  - `lastScanAt` (datetime, nullable) — timestamp of last successful scan for this child's channels
  - `createdAt`, `updatedAt` timestamps
  - `order` (integer) — display order in the UI
- **Create DTOs with class-validator**:
  - `CreateChildDto` — `@IsString() @IsNotEmpty() name`, `@IsOptional() @IsString() channelNames`, `@IsOptional() @IsString() teacherEmails`, `@IsOptional() @IsString() calendarColor`
  - `UpdateChildDto` — `PartialType(CreateChildDto)`
  - `ReorderChildrenDto` — `@IsArray() ids: string[]`
  - Validate `calendarColor` against Google Calendar's supported color IDs
- **Create `ChildRepository`** with injection token `CHILD_REPOSITORY` → `IChildRepository`
- **Create `ChildService`** in SettingsModule (or a new `ChildModule`):
  - CRUD operations for children
  - `getChildrenWithScanStatus()` — returns children with their last scan time
  - `reorderChildren(ids: string[])` — update display order
- **Create `ChildController`** REST endpoints:
  - `GET /api/children` — list all children (ordered)
  - `POST /api/children` — add a child
  - `PUT /api/children/:id` — update a child
  - `DELETE /api/children/:id` — remove a child
  - `PUT /api/children/reorder` — reorder children
- **Update existing Settings entity**: remove flat channel/email fields that are now per-child
- **Database migration**: migrate existing settings data to child entities if applicable

**Success Criteria**:
- [x] Child entity stored in database with all fields
- [x] CRUD endpoints functional with proper validation
- [x] Invalid calendar color IDs rejected (400)
- [x] Reordering works correctly
- [x] Empty channels/emails allowed (nullable)
- [x] Existing settings data migrated

**Testing**:
- Unit tests for ChildService (CRUD, reorder)
- Unit tests for DTO validation (valid/invalid colors, empty strings)
- Integration tests for ChildController endpoints
- Test migration from old settings format

**Acceptance**: Child entity and API fully functional with proper validation

---

## Task 8.2: Child-Based Settings Form (Frontend)

**Description**: Redesign the Settings page form to manage a dynamic list of children. Each child entry has fields for name, WhatsApp channels, teacher emails, and calendar color. Children can be added, removed, and reordered.

**Dependencies**: Task 8.1, Task 2.1b (Settings UI/UX), Task 7.2 (Dual Login UI)

**Reference**: See `.agents/skills/ui-ux-pro-max/SKILL.md` for design system, form patterns, and interaction guidelines. See `.agents/skills/scss-best-practices/SKILL.md` for styling.

**What needs to be done**:
- **Remove the "Integrations" section** from the Settings page:
  - The old integration fields (WhatsApp channels, email address, Google Calendar ID) are replaced by the per-child configuration below and the dual Google login from Phase 7
  - Delete the corresponding React components/sections
  - Remove any unused API calls or state related to the old integration fields
- **Create `ChildList` component**:
  - Renders a list of `ChildCard` components
  - "Add Child" button at the bottom (with + icon)
  - Empty state when no children: "Add your first child to get started"
  - Drag-to-reorder support (or up/down arrow buttons)
- **Create `ChildCard` component**:
  - Expandable/collapsible card for each child
  - Fields:
    - **Child Name** (text input, required) — prominent, used as event title prefix
    - **WhatsApp Channels** (text input) — comma-separated channel names, placeholder: "e.g., Grade 3A Parents, School Updates" (can be left empty)
    - **Teacher Emails** (text input) — comma-separated emails, placeholder: "e.g., teacher@school.edu" (can be left empty)
    - **Calendar Color** (color picker) — dropdown or color swatch grid showing only Google Calendar supported colors, with color name labels; default color pre-selected if none chosen
  - Delete button (with confirmation dialog: "Remove {name}?")
  - Visual indicator of last scan time ("Last scanned: 2 hours ago" or "Never scanned")
- **Google Calendar color picker**:
  - Show the 11 Google Calendar event colors as swatches
  - Colors: Tomato, Flamingo, Tangerine, Banana, Sage, Basil, Peacock, Blueberry, Lavender, Grape, Graphite
  - Selected color highlighted with checkmark
  - "Default" option for no specific color
- **Form validation**:
  - Child name required (inline error if empty)
  - Email format validation for teacher emails (warn on invalid format)
  - At least one child required before saving (or allow empty list)
- **API integration**:
  - Fetch children list on mount (`GET /api/children`)
  - Auto-save on blur or explicit save button per child
  - Optimistic UI updates with rollback on error
  - Loading states during save operations
- **Follow UI/UX skill guidelines**:
  - Card-based layout with consistent spacing
  - Smooth add/remove animations
  - Responsive: full-width cards on mobile, comfortable width on desktop
  - Accessible: proper labels, ARIA roles for dynamic list, keyboard navigation

**Success Criteria**:
- [x] Dynamic list of children renders correctly
- [x] Add/remove children works with smooth animations
- [x] All fields editable with proper validation
- [x] Google Calendar color picker shows supported colors
- [x] Form saves to backend successfully
- [x] Responsive and accessible
- [x] Empty state handled gracefully

**Testing**:
- Component unit tests (ChildList, ChildCard, color picker)
- Test add/remove/reorder interactions
- Test form validation (empty name, invalid emails)
- Test API integration (mock fetch/save)
- Test responsive layout
- Manual test with real data

**Acceptance**: Child-based settings form functional, visually polished, and integrated with backend

---

## Task 8.3: Per-Child Scanning Logic

**Description**: Update the message scanning and event creation logic to work per-child. Each child's WhatsApp channels and teacher emails are scanned independently, with per-child time tracking. Events are colored and prefixed with the child's name.

**Dependencies**: Task 8.1, Task 3.1 (WhatsApp scraping), Task 3.2 (Gmail), Task 5.3 (Event Sync)

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `arch-use-events`, `db-use-transactions`, `error-handle-async-errors`. See `.agents/skills/architecture-patterns/SKILL.md` for domain logic patterns.

**What needs to be done**:
- **Update SyncService** to iterate per-child:
  - `GET /api/children` → for each child:
    1. **Determine scan window**:
       - If `child.lastScanAt` is null (never scanned) → scan last 24 hours
       - If `child.lastScanAt` is older than 72 hours → scan last 24 hours
       - Otherwise → scan from `child.lastScanAt` to now
    2. **Scan WhatsApp channels**:
       - Parse `child.channelNames` (comma-separated) into individual channel names
       - For each channel, fetch messages within the scan window
       - Skip if `channelNames` is empty
    3. **Scan Gmail**:
       - Use the Gmail OAuth account (from Phase 7)
       - Filter emails where sender matches any of `child.teacherEmails`
       - Fetch emails within the scan window
       - Skip if `teacherEmails` is empty
    4. **Parse messages with LLM** (per-child context):
       - Send messages to LLM with child's name as context
       - LLM extracts events from messages
    5. **Create calendar events**:
       - Event title prefixed with child name: `"{childName}: {eventTitle}"`
       - Event color set to `child.calendarColor` (use Google Calendar API's `colorId` field)
       - If no color chosen, use Google Calendar's default event color
       - Sync to Calendar OAuth account (from Phase 7)
    6. **Update `child.lastScanAt`** to current timestamp after successful scan
- **Update CalendarEvent entity**:
  - Add `childId` field (foreign key to Child entity)
  - Add `calendarColorId` field (Google Calendar color ID)
- **Update GoogleCalendarService**:
  - Accept `colorId` parameter in `createEvent()` method
  - Pass `colorId` to Google Calendar API when creating/updating events
- **Update EventSyncService**:
  - Accept child context when creating events
  - Prefix event title with child name
  - Set event color from child settings
- **Error handling**:
  - If scanning one child fails, continue with next child (partial success)
  - Log per-child scan results
  - Don't update `lastScanAt` on failure

**Success Criteria**:
- [x] Each child's channels scanned independently
- [x] Scan window logic works correctly (24h fallback for new/stale scans)
- [x] Gmail filtered by child's teacher emails
- [x] Event titles prefixed with child name (e.g., "Yoni: Field Trip March 25")
- [x] Event colors match child's chosen Google Calendar color
- [x] Default color used when none specified
- [x] `lastScanAt` updated per-child after successful scan
- [x] One child's scan failure doesn't block others
- [x] Empty channels/emails gracefully skipped

**Testing**:
- Unit tests for scan window calculation (never scanned, stale, recent)
- Unit tests for per-child channel parsing
- Unit tests for email filtering by teacher emails
- Unit tests for event title prefixing and color assignment
- Integration test: full per-child scan flow (mock WhatsApp + Gmail + LLM)
- Test partial failure (child 1 fails, child 2 succeeds)
- Test empty channels/emails (no scan attempted)
- Test with multiple children with overlapping channels

**Acceptance**: Per-child scanning, event creation with name prefix and color coding, all working end-to-end
