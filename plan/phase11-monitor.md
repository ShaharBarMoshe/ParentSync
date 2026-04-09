# Phase 11: Monitor Tab

**Status**: Done

## Task 11.1: Monitor Backend — Aggregation Endpoints
**Description**: Create backend endpoints that aggregate sync logs, message counts, and event data into time-series and summary formats suitable for chart rendering.

**Dependencies**: Task 1.1, Task 3.1, Task 5.1, Phase 8

**What needs to be done**:
- Create `MonitorModule` with controller and service
- Add aggregation endpoints:
  - `GET /monitor/messages-over-time` — message counts grouped by day/week, filterable by source (WhatsApp/Email) and child
  - `GET /monitor/events-per-channel` — event counts grouped by channel name
  - `GET /monitor/sync-history` — sync log timeline with start/end times, status, duration, and per-channel details
  - `GET /monitor/summary` — totals and averages: total messages, total events, avg messages per sync, avg sync duration, success/failure rate
  - `GET /monitor/channels-activity` — per-channel message volume over time (heatmap data)
- Query parameters: `from`, `to` (date range), `childId` (optional filter), `groupBy` (`day` | `week` | `month`)
- Use raw SQL or TypeORM QueryBuilder for efficient aggregation queries
- Return data in a chart-friendly format: `{ labels: string[], datasets: { label, data }[] }`

**Success Criteria**:
- [ ] All endpoints return correct aggregated data
- [ ] Date range filtering works
- [ ] Child filtering works
- [ ] Grouping by day/week/month works
- [ ] Responses are performant (< 200ms for typical data volumes)

**Testing**:
- Unit tests for aggregation service with seeded test data
- Test date range boundary conditions
- Test empty data scenarios
- Test grouping accuracy

**Acceptance**: All monitor endpoints return correct, chart-ready aggregated data

---

## Task 11.2: Monitor Page — Layout & Navigation
**Description**: Create the Monitor page shell and add it to the app navigation.

**Dependencies**: Task 6.3, Task 11.1

**What needs to be done**:
- Create `MonitorPage.tsx` component with:
  - Page header with title and description
  - Date range picker (last 7 days, 30 days, 90 days, custom)
  - Child filter dropdown (all children / specific child)
  - Grid layout for chart cards
- Add `/monitor` route to React Router
- Add "Monitor" tab to navigation bar
- Add loading and empty states

**Success Criteria**:
- [ ] Monitor page accessible via navigation
- [ ] Date range picker updates all charts
- [ ] Child filter updates all charts
- [ ] Responsive layout on desktop and mobile
- [ ] Loading spinners while data fetches

**Testing**:
- Component unit tests
- Test filter state management
- Test responsive layout

**Acceptance**: Monitor page shell functional with working filters and navigation

---

## Task 11.3: Messages Over Time Chart
**Description**: Line/bar chart showing scanned message counts over time, split by source.

**Dependencies**: Task 11.1, Task 11.2

**What needs to be done**:
- Install charting library (Chart.js with react-chartjs-2 or Recharts)
- Create `MessagesOverTimeChart` component:
  - Line chart with two series: WhatsApp messages, Email messages
  - X-axis: date, Y-axis: message count
  - Tooltip showing exact counts on hover
  - Legend with source toggles
- Fetch data from `GET /monitor/messages-over-time`
- Respect date range and child filters from parent page

**Success Criteria**:
- [ ] Chart renders correctly with real data
- [ ] Both sources clearly distinguishable (color-coded)
- [ ] Hover tooltips show accurate data
- [ ] Chart updates when filters change
- [ ] Handles zero-data periods gracefully

**Testing**:
- Component tests with mock data
- Test filter reactivity
- Test empty state

**Acceptance**: Messages chart displays accurate time-series data

---

## Task 11.4: Events Per Channel Chart
**Description**: Bar or pie chart showing how many calendar events were created from each WhatsApp channel / email source.

**Dependencies**: Task 11.1, Task 11.2

**What needs to be done**:
- Create `EventsPerChannelChart` component:
  - Horizontal bar chart (best for variable-length channel names)
  - Bars color-coded by source (WhatsApp green, Email red)
  - Sorted by count descending
  - Tooltip with exact count and percentage
- Fetch data from `GET /monitor/events-per-channel`
- Respect date range and child filters

**Success Criteria**:
- [ ] Chart renders with correct per-channel counts
- [ ] Channels sorted by activity
- [ ] Source color-coding is clear
- [ ] Handles many channels without visual clutter (scrollable or top-N with "others")

**Testing**:
- Component tests with varying channel counts
- Test sort order
- Test overflow with many channels

**Acceptance**: Events per channel chart is accurate and readable

---

## Task 11.5: Sync History & Performance Chart
**Description**: Timeline chart showing sync runs with their duration, status, and message yield.

**Dependencies**: Task 11.1, Task 11.2

**What needs to be done**:
- Create `SyncHistoryChart` component:
  - Combined chart: bar for message count, line for sync duration
  - Color-coded bars by sync status (green=success, orange=partial, red=failed)
  - X-axis: sync timestamp, Y-axis left: messages, Y-axis right: duration (seconds)
  - Tooltip showing: start time, end time, duration, messages fetched, status, channel breakdown
- Fetch data from `GET /monitor/sync-history`
- Respect date range filter

**Success Criteria**:
- [ ] Chart shows sync history accurately
- [ ] Status color-coding is clear
- [ ] Duration and message count both readable on dual axis
- [ ] Tooltip shows full sync details
- [ ] Failed syncs are visually prominent

**Testing**:
- Component tests with mixed success/failure data
- Test dual-axis rendering
- Test tooltip content

**Acceptance**: Sync history chart provides clear operational visibility

---

## Task 11.6: Summary Stats Cards
**Description**: Top-level KPI cards showing key metrics at a glance.

**Dependencies**: Task 11.1, Task 11.2

**What needs to be done**:
- Create `MonitorSummaryCards` component with stat cards:
  - Total messages scanned (with trend arrow vs previous period)
  - Total events created (with trend arrow)
  - Average sync duration
  - Sync success rate (percentage with color indicator)
  - Most active channel
  - Last sync time and status
- Fetch data from `GET /monitor/summary`
- Respect date range and child filters
- Trend arrows compare current period to previous equivalent period

**Success Criteria**:
- [ ] All KPI cards show correct values
- [ ] Trend arrows correctly indicate up/down vs previous period
- [ ] Cards update when filters change
- [ ] Visually clean and scannable

**Testing**:
- Component tests with known data
- Test trend calculation logic
- Test edge cases (no previous period data)

**Acceptance**: Summary cards provide accurate at-a-glance metrics

---

## Task 11.7: Channel Activity Heatmap
**Description**: Heatmap showing message volume per channel over time, helping identify patterns and quiet/busy periods.

**Dependencies**: Task 11.1, Task 11.2

**What needs to be done**:
- Create `ChannelActivityHeatmap` component:
  - Grid: rows = channels, columns = days/weeks
  - Cell color intensity = message count
  - Tooltip showing channel, date, and count
  - Color scale legend
- Fetch data from `GET /monitor/channels-activity`
- Respect date range and child filters

**Success Criteria**:
- [ ] Heatmap renders correctly with real data
- [ ] Color intensity accurately reflects message volume
- [ ] Tooltip shows precise data
- [ ] Readable with many channels (scrollable)

**Testing**:
- Component tests with various data densities
- Test color scale accuracy
- Test scroll behavior with many channels

**Acceptance**: Heatmap provides clear channel activity patterns

---

## Task 11.8: UI/UX Improvement for Monitor Page
**Description**: Polish the Monitor page using the `ui-ux-pro-max` skill for a professional analytics dashboard experience.

**Dependencies**: Tasks 11.2–11.7

**Reference**: See `.agents/skills/ui-ux-pro-max/SKILL.md` — use app-interface, charts, colors, and UX guidelines data.

**What needs to be done**:
- Run `ui-ux-pro-max` skill to analyze and improve the Monitor page
- Apply consistent chart styling (colors, fonts, grid lines, legends)
- Improve layout with clear visual hierarchy:
  - Summary cards at top
  - Primary charts (messages, events) in the middle
  - Detailed charts (sync history, heatmap) below
- Add smooth chart animations on load and filter change
- Polish filter controls (date range picker, child selector)
- Ensure charts are accessible (keyboard navigation, screen reader labels)
- Dark/light theme consistency for all charts

**Success Criteria**:
- [ ] All charts share a consistent visual style
- [ ] Layout guides the eye from summary to detail
- [ ] Animations are smooth and not distracting
- [ ] Filters are intuitive
- [ ] Charts are accessible
- [ ] Consistent with app-wide design system

**Acceptance**: Monitor page visually polished with professional analytics dashboard feel

---

## Task 11.9: Testing — Unit Tests & Integration Tests
**Description**: Comprehensive test suite covering the Monitor module with unit tests for the service layer and e2e integration tests for the HTTP endpoints using a real in-memory database.

**Dependencies**: Tasks 11.1–11.8

**What needs to be done**:

### Unit Tests (`monitor.service.spec.ts`)
- **getMessagesOverTime**: day/week/month grouping, source filtering, childId filtering, empty data, default date range
- **getEventsPerChannel**: sorted output, empty data, channel name resolution from sourceId
- **getSyncHistory**: duration calculation, null startedAt/endedAt, ordering, date range filtering
- **getSummary**: all KPIs accurate, success rate calculation, previous period comparison, zero data edge case, mixed success/failed syncs
- **getChannelsActivity**: heatmap matrix dimensions, correct cell values, empty data, childId filtering

### E2E Integration Tests (`test/monitor.e2e-spec.ts`)
- Full HTTP endpoint tests using supertest against a real NestJS app with in-memory SQLite
- Seed test data (messages, calendar events, sync logs) before running queries
- Test all 5 endpoints: messages-over-time, events-per-channel, sync-history, summary, channels-activity
- Test query parameter validation (from/to dates, childId, groupBy)
- Test empty database returns valid empty responses
- Test date range filtering returns only data within range

**Success Criteria**:
- [x] Unit tests cover all 5 service methods with edge cases
- [x] E2E tests verify all 5 HTTP endpoints return correct data
- [x] E2E tests verify query parameter filtering works
- [x] E2E tests verify empty state responses
- [x] All tests pass (`npm test` and `npm run test:e2e`)

### Sync Button E2E Test (`test/sync-button.e2e-spec.ts`)
- Full app with mock WhatsApp service (connected, returns Hebrew messages)
- Creates a child, clicks "Sync Now" (POST /sync/manual), verifies messages stored
- Verifies sync log has channel details with no skips
- Verifies child lastScanAt updated
- Verifies no duplicate messages on re-sync
- Tests disconnected scenario: verifies skip reason logged correctly

**Acceptance**: Full test coverage for Monitor module, all tests green
