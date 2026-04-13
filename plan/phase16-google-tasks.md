# Phase 16: Google Tasks Integration (Date-Only Events as Tasks)

**Status**: Planned

## Overview

When the LLM parses a message and extracts an event with a clear date but no specific time, create a **Google Task** (to-do item) instead of an all-day Google Calendar event. Tasks appear in Google Calendar's task list, can be checked off, and are better suited for "things to do on a day" rather than "things happening at a time". Each task is colored per child via the task list it's assigned to (one task list per child).

**Key difference**:
- **Has time** → Google Calendar Event (existing flow, unchanged)
- **No time, date only** → Google Task (new flow)

---

## Task 16.1: Google Tasks API Setup & OAuth Scope

**Description**: Enable the Google Tasks API and add the required OAuth scope to the existing Calendar OAuth flow.

**Dependencies**: Phase 7 (Dual Google Auth)

**Skills**: `oauth2` (PKCE flow, scope management, token storage), `nestjs-best-practices` (`security-validate-config`, `error-handle-async-errors`), `api-security-best-practices` (token handling, scope validation)

**What needs to be done**:
- **Enable Google Tasks API** in Google Cloud Console (same project as Calendar)
- **Add Tasks OAuth scope** to the calendar OAuth flow:
  - Add `https://www.googleapis.com/auth/tasks` to the calendar OAuth scopes
  - Tasks and Calendar share the same Google account, so reuse the `calendar` purpose tokens
- **Update OAuthService** to include the new scope in the calendar authorization URL
- **Note**: Existing users will need to re-authorize to grant the Tasks scope. Handle gracefully — if Tasks API returns 403, log a warning and fall back to creating an all-day calendar event instead.

**Success Criteria**:
- [ ] Google Tasks API enabled in Cloud Console
- [ ] OAuth scope includes `tasks`
- [ ] Re-authorization flow works cleanly
- [ ] Fallback to all-day event if Tasks scope not granted

**Testing**:
- Test OAuth flow includes new scope
- Test fallback when scope not granted

---

## Task 16.2: GoogleTasksService (Backend)

**Description**: Create a new service to interact with the Google Tasks API.

**Dependencies**: Task 16.1

**Skills**: `nestjs-best-practices` (`arch-feature-modules`, `di-use-interfaces-tokens`, `error-handle-async-errors`, `perf-optimize-database`), `architecture-patterns` (Ports & Adapters — interface + injection token + adapter), `api-security-best-practices` (input validation, error sanitization)

**What needs to be done**:
- **Create `GoogleTasksService`** in `CalendarModule`:
  - Inject `OAuthService` (reuse calendar tokens)
  - Method: `createTask(title: string, notes: string | undefined, dueDate: string, taskListId: string): Promise<string>` — returns Google Task ID
  - Method: `deleteTask(taskId: string, taskListId: string): Promise<boolean>`
  - Method: `getTaskLists(): Promise<{ id: string; title: string }[]>`
  - Method: `createTaskList(title: string): Promise<string>` — returns list ID
  - Method: `findOrCreateChildTaskList(childName: string): Promise<string>` — finds existing task list named after child, or creates one
- **Use injection token** `GOOGLE_TASKS_SERVICE` → `IGoogleTasksService` interface
- **Retry logic**: same pattern as GoogleCalendarService (3 retries, exponential backoff)
- **Error handling**: 
  - 403 (scope not granted) → throw typed error so caller can fall back
  - 404 (task list deleted) → recreate and retry

**Success Criteria**:
- [ ] Tasks created in Google Tasks via API
- [ ] Task lists created per child
- [ ] Task lists cached to avoid redundant API calls
- [ ] Retry logic works
- [ ] Errors handled gracefully

**Testing**:
- Unit tests with mock Google Tasks API
- Test task creation with due date
- Test task list creation and caching
- Test error scenarios (403, 404, network failure)

---

## Task 16.3: Update EventSyncService to Route Events vs Tasks

**Description**: Modify the event sync flow to create Google Tasks for date-only items and Google Calendar Events for timed items.

**Dependencies**: Task 16.2

**Skills**: `nestjs-best-practices` (`arch-use-events`, `db-use-transactions`, `error-handle-async-errors`, `devops-use-logging`), `architecture-patterns` (Clean Architecture — domain logic in service layer, no framework leakage)

**What needs to be done**:
- **Update `EventSyncService.syncEvents()`**:
  - After parsing, check if `parsedEvent.time` exists:
    - **Has time** → existing flow: create `CalendarEventEntity`, sync to Google Calendar
    - **No time** → new flow: create `CalendarEventEntity` (with `syncType: 'task'`), sync to Google Tasks
  - For tasks, call `googleTasksService.findOrCreateChildTaskList(childName)` to get the target task list
  - Call `googleTasksService.createTask(title, description, date, taskListId)`
  - Store the Google Task ID in `googleEventId` field (reuse existing field)
  - Mark `syncedToGoogle: true`
- **Add `syncType` column** to `CalendarEventEntity`:
  - Type: `enum('event', 'task')`, default `'event'`
  - Used to distinguish between Calendar Events and Tasks in the UI and for deletion
- **Update delete/update logic**: use `syncType` to call the correct API (Calendar vs Tasks)
- **Fallback**: if Google Tasks API returns 403, fall back to creating an all-day calendar event (existing flow)

**Success Criteria**:
- [ ] Timed events → Google Calendar Events (unchanged)
- [ ] Date-only events → Google Tasks
- [ ] `syncType` persisted and used correctly
- [ ] Fallback to all-day event works
- [ ] Child task lists created automatically

**Testing**:
- Unit tests for routing logic (time vs no-time)
- Integration test: message with time → Calendar Event
- Integration test: message without time → Google Task
- Test fallback on 403
- Test duplicate prevention for tasks

---

## Task 16.4: Update LLM System Prompt

**Description**: Update the LLM parser prompt to better guide event extraction for the tasks vs events distinction.

**Dependencies**: None (can be done in parallel)

**Skills**: `nestjs-best-practices` (`security-validate-all-input` — validate LLM output format), `architecture-patterns` (domain logic encapsulation — parsing rules in service layer)

**What needs to be done**:
- **Update `SYSTEM_PROMPT`** in `message-parser.service.ts`:
  - Reinforce that events WITHOUT a specific time should still be extracted — they will become tasks
  - Add guidance: "If a message mentions an activity on a specific day but no exact time, create the event with the date but WITHOUT the time field. These will be created as calendar tasks."
  - Add more Hebrew examples of date-only events:
    - "הזכרה: להביא תחפושת ביום שלישי" → `[{"title":"להביא תחפושת","date":"..."}]`
    - "מבחן במתמטיקה ביום ראשון" → `[{"title":"מבחן במתמטיקה","date":"..."}]`
    - "טיול שנתי ב-15 לחודש" → `[{"title":"טיול שנתי","date":"..."}]`
  - **Action items** (payments, forms, documents) are extracted as tasks:
    - Payment requests → title with "תשלום", description includes amount + link
    - Form/doc requests → title with action, description includes link + instructions
    - If no deadline date, use current date
    - ~~Already implemented in current prompt~~ (done ahead of schedule)
  - Keep existing examples for timed events unchanged

**Success Criteria**:
- [ ] Prompt clearly distinguishes time vs no-time events
- [ ] New Hebrew examples cover common school/family scenarios
- [ ] Existing timed-event extraction unaffected

**Testing**:
- Manual testing with sample messages (Hebrew)
- Verify timed events still get time field
- Verify date-only messages produce events without time

---

## Task 16.5: Frontend Updates

**Description**: Update the frontend to display Tasks and Events distinctly.

**Dependencies**: Task 16.3

**Skills**: `ui-ux-pro-max` (design system, icons, visual hierarchy, React patterns), `scss-best-practices` (BEM naming, component styles, variables), `better-icons` (icon selection for task vs event distinction)

**What needs to be done**:
- **Dashboard**: show task/event icon next to each item
  - Calendar icon for events, checkbox icon for tasks
- **Calendar page**: tasks appear with a distinct style (e.g., dashed border or checkbox icon)
- **API types**: add `syncType: 'event' | 'task'` to `CalendarEvent` interface in `api.ts`
- **No new pages needed** — tasks appear alongside events in existing views

**Success Criteria**:
- [ ] Tasks visually distinct from events in Dashboard and Calendar views
- [ ] `syncType` field available in frontend types
- [ ] No breaking changes to existing event display

**Testing**:
- Visual test: events and tasks render correctly
- Test with mix of events and tasks

---

## Task 16.6: Documentation & Testing

**Description**: Update docs and add comprehensive tests.

**Dependencies**: Tasks 16.1–16.5

**Skills**: `documentation` (docs structure and standards), `qa-expert` (test plan, E2E coverage, edge cases), `nestjs-best-practices` (`test-mock-external-services`, `test-use-testing-module`)

**What needs to be done**:
- **Update `docs/`** with Google Tasks integration docs
- **Add E2E test**: message without time → parsed → Task created in Google Tasks
- **Add E2E test**: message with time → parsed → Event created in Google Calendar
- **Update existing tests** to account for `syncType` field
- **Task scenario test coverage** — ensure the following task types are covered end-to-end (message → LLM parse → task creation → Google Tasks sync → reminder):
  - Payment request with link and amount (e.g., "נא להעביר תשלום 120 ש״ח https://pay.school.co.il")
  - Form/document to fill with link (e.g., "נא למלא שאלון בריאות https://forms.google.com/abc")
  - Document to return with deadline (e.g., "יש להחזיר טופס הרשאה חתום עד יום רביעי")
  - Dress code / specific clothing (e.g., "יום לבן — נא להלביש בלבן")
  - Items to bring (e.g., "להביא ביגוד ספורטיבי ונעלי ספורט")
  - School supplies to bring (e.g., "להביא מחברת מתמטיקה ומספריים")
  - Activity with date but no time (e.g., "טיול שנתי ביום חמישי")
  - Mixed batch: timed events and date-only tasks in the same sync cycle
- **Reminder tests for tasks** — verify:
  - Task reminders use task-specific header ("📋 Reminder: task due tomorrow")
  - Event reminders use event-specific header ("⏰ Reminder: event in ~24 hours")
  - Task reminders include full description (links, amounts, items to bring)
  - Task reminders do NOT show a "Time:" line
  - Mixed batch: both event and task reminders sent correctly in same run

**Success Criteria**:
- [ ] Documentation updated
- [ ] E2E tests pass for all task scenarios listed above
- [ ] Reminder tests pass for both tasks and events
- [ ] Existing tests unbroken
- [ ] Coverage maintained >= 80%

**Acceptance**: Date-only events create Google Tasks (with child-specific task lists), timed events create Google Calendar Events. All task scenarios (payments, forms, dress code, items to bring) are tested end-to-end including reminders. Users see both in the app with clear visual distinction.
