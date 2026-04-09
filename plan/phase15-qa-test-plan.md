# Phase 15: QA Test Plan Execution

**Status**: Done

**Dependencies**: Phase 9 (Testing & Polish) — Phase 9 covers test infrastructure and basic coverage; this phase provides the structured QA execution plan with 91 test cases, quality gates, and OWASP security testing.

**Reference**: See `tests/docs/TEST-PLAN.md` for the full test plan with all test case specifications.

**Methodology**: QA Expert skill (AAA pattern, Google Testing Standards, OWASP Top 10, TC-[CATEGORY]-[NUMBER] format)

---

## Task 14.1: Backend Unit Tests (42 test cases)

**Description**: Execute all backend unit test cases covering 14 services across 8 NestJS modules.

**Dependencies**: Phase 9 Task 9.1

**Test Cases**:
- **Settings Module** (TC-SET-001 to TC-SET-008): Settings CRUD, child CRUD, reorder, crypto service — 8 tests
- **Messages Module** (TC-MSG-001 to TC-MSG-006): WhatsApp message processing, Gmail fetch, token refresh, error handling, query filters, QR code — 6 tests
- **LLM Module** (TC-LLM-001 to TC-LLM-009): OpenRouter API calls, rate limiting, timeout, message parsing (event extraction, no-event, malformed response), queue processor, throttle guard, logging interceptor — 9 tests
- **Calendar Module** (TC-CAL-001 to TC-CAL-006): Event creation, Google Calendar create/update/delete, token refresh, ICS generator — 6 tests
- **Sync Module** (TC-SYN-001 to TC-SYN-007): Full sync orchestration, per-child sync, partial failure recovery, event sync to Google, approval/reject, sync log — 7 tests
- **Auth Module** (TC-AUTH-001 to TC-AUTH-004): OAuth URL generation, code exchange with PKCE, token refresh, revoked token — 4 tests
- **Monitor Module** (TC-MON-001 to TC-MON-002): Sync metrics aggregation, channel activity heatmap — 2 tests

**Implementation Rules**:
- All tests use `Test.createTestingModule()` (rule: `test-use-testing-module`)
- External services mocked via `.overrideProvider()` (rule: `test-mock-external-services`)
- Type-safe mocks: `jest.Mocked<Type>`
- Time-dependent tests: `jest.useFakeTimers()`

**Success Criteria**:
- [ ] All 42 backend unit test cases passing
- [ ] Backend code coverage >= 80%
- [ ] Zero P0 test failures
- [ ] All external services mocked (no real API calls)

**Commands**:
```bash
cd backend && npm test -- --coverage
```

---

## Task 14.2: Frontend Unit Tests (9 test cases)

**Description**: Execute all frontend unit test cases covering 4 pages, WhatsApp QR modal, and API service.

**Dependencies**: Phase 9 Task 9.1

**Test Cases**:
- **TC-FE-001 to TC-FE-002**: DashboardPage — render summary, trigger manual sync
- **TC-FE-003 to TC-FE-004**: CalendarPage — display events, approve/reject event
- **TC-FE-005 to TC-FE-006**: SettingsPage — save settings, child CRUD
- **TC-FE-007**: WhatsAppQRModal — QR code display
- **TC-FE-008**: MonitorPage — chart rendering
- **TC-FE-009**: API service — error handling (500, timeout)

**Success Criteria**:
- [ ] All 9 frontend test cases passing
- [ ] Frontend code coverage >= 70%
- [ ] API calls mocked (no backend dependency)

**Commands**:
```bash
cd frontend && npm test -- --coverage
```

---

## Task 14.3: API Integration Tests (7 test cases)

**Description**: Execute Supertest-based integration tests against the full NestJS application with real SQLite and mocked external APIs.

**Dependencies**: Task 14.1

**Test Cases**:
- **TC-API-001**: Health check endpoint
- **TC-API-002**: Settings CRUD via HTTP (full lifecycle)
- **TC-API-003**: Children CRUD via HTTP (full lifecycle + reorder)
- **TC-API-004**: Calendar events CRUD via HTTP
- **TC-API-005**: Trigger manual sync via HTTP (full pipeline)
- **TC-API-006**: Validation pipe — reject invalid input (400 errors)
- **TC-API-007**: Monitor endpoints — metric aggregation

**Implementation Rules**:
- Full `INestApplication` with global pipes, filters, guards (rule: `test-e2e-supertest`)
- Real SQLite database (in-memory), mocked external APIs
- Proper `beforeAll()`/`afterAll()` setup and teardown

**Success Criteria**:
- [ ] All 7 API integration tests passing
- [ ] Correct HTTP status codes (200, 201, 400, 404, 429)
- [ ] Validation errors include field-level messages
- [ ] Database cleaned between test suites

**Commands**:
```bash
cd backend && npm run test:e2e
```

---

## Task 14.4: End-to-End Flow Tests (5 test cases)

**Description**: Test complete user flows from message ingestion through calendar event creation.

**Dependencies**: Task 14.3

**Test Cases**:
- **TC-E2E-001**: WhatsApp message -> LLM parse -> calendar event -> Google Calendar sync
- **TC-E2E-002**: Gmail email -> LLM parse -> calendar event
- **TC-E2E-003**: Per-child sync isolation (2 children, sync one)
- **TC-E2E-004**: Settings change affects sync behavior
- **TC-E2E-005**: Sync with no new messages (clean no-op)

**Success Criteria**:
- [ ] All 5 E2E tests passing
- [ ] No flaky tests (pass 3 consecutive runs)
- [ ] Each test completes in < 5 seconds

---

## Task 14.5: Security Tests — OWASP Top 10 (12 test cases)

**Description**: Execute security tests covering 7 OWASP categories. Target: 90% OWASP coverage (9/10 threats mitigated).

**Dependencies**: Task 14.1

**Test Cases**:
- **A01 Broken Access Control** (TC-SEC-001): No credential leaks via API
- **A02 Cryptographic Failures** (TC-SEC-002, TC-SEC-003): Settings and OAuth tokens encrypted at rest
- **A03 Injection** (TC-SEC-004, TC-SEC-005): SQL injection via query params, XSS via stored messages
- **A04 Insecure Design** (TC-SEC-006, TC-SEC-007): Rate limiting, LLM prompt injection
- **A05 Security Misconfiguration** (TC-SEC-008, TC-SEC-009): Error response sanitization, CORS config
- **A07 Authentication Failures** (TC-SEC-010, TC-SEC-011): OAuth state/CSRF validation, PKCE enforcement
- **A09 Security Logging** (TC-SEC-012): Security events logged

**Reference**: See `.agents/skills/oauth2/SKILL.md` for OAuth security checklist.

**Success Criteria**:
- [ ] All 12 security tests passing
- [ ] 0 P0 security vulnerabilities
- [ ] Encryption verified at database level
- [ ] OWASP coverage >= 90%

---

## Task 14.6: Performance Tests (4 test cases)

**Description**: Validate application performance under load and with large datasets.

**Dependencies**: Task 14.3

**Test Cases**:
- **TC-PERF-001**: Sync with 500 messages (< 60s)
- **TC-PERF-002**: API response time under 50 concurrent requests (p95 < 500ms)
- **TC-PERF-003**: Database queries with 10k messages + 2k events (< 200ms)
- **TC-PERF-004**: Frontend Lighthouse score (>= 80)

**Success Criteria**:
- [ ] All performance benchmarks met
- [ ] No memory leaks during bulk processing
- [ ] Database indexes effective

---

## Task 14.7: UI/UX & Accessibility Tests (7 test cases)

**Description**: Validate responsive design, keyboard navigation, color contrast, and user-facing states.

**Dependencies**: Phase 9 Task 9.3

**Reference**: See `.agents/skills/ui-ux-pro-max/SKILL.md` for accessibility and responsive guidelines.

**Test Cases**:
- **TC-UI-001**: Responsive layout — desktop (1920x1080)
- **TC-UI-002**: Responsive layout — tablet (768px)
- **TC-UI-003**: Keyboard navigation (Tab, Enter, Escape)
- **TC-UI-004**: Color contrast WCAG AA (4.5:1 ratio)
- **TC-UI-005**: Loading states (spinners/skeletons)
- **TC-UI-006**: Empty states (helpful messages)
- **TC-UI-007**: Error states (user-friendly, retry option)

**Success Criteria**:
- [ ] All pages render correctly at desktop and tablet widths
- [ ] All interactive elements keyboard-accessible
- [ ] WCAG AA contrast requirements met
- [ ] Loading, empty, and error states implemented

---

## Task 14.8: Electron Desktop Tests (5 test cases)

**Description**: Validate Electron shell functionality including launch, tray, IPC, and process management.

**Dependencies**: Phase 12

**Test Cases**:
- **TC-EL-001**: App launch with splash screen
- **TC-EL-002**: System tray integration (icon, menu, Sync Now)
- **TC-EL-003**: IPC communication (getBackendUrl, getAppInfo, showNotification)
- **TC-EL-004**: Backend child process management (start/stop, no orphans)
- **TC-EL-005**: Window state persistence across restarts

**Success Criteria**:
- [ ] App launches and loads frontend after backend ready
- [ ] Tray menu functional
- [ ] IPC bridge working for all exposed APIs
- [ ] Clean shutdown (no orphaned processes)

---

## Quality Gates (All Must Pass)

| Gate | Target | Blocker |
|------|--------|---------|
| Test Execution | 100% (91/91) | Yes |
| Pass Rate | >= 80% | Yes |
| P0 Bugs | 0 | Yes |
| P1 Bugs | <= 5 | Yes |
| Backend Coverage | >= 80% | Yes |
| Frontend Coverage | >= 70% | Yes |
| OWASP Coverage | 90% (9/10) | Yes |
| Lighthouse Score | >= 80 | No |

---

## Execution Schedule

| Week | Tasks | Test Cases |
|------|-------|------------|
| Week 1 | Task 14.1 (Backend Unit) | 42 tests |
| Week 2 | Task 14.2 (Frontend) + Task 14.3 (API) + Task 14.4 (E2E) + Task 14.5 (Security) | 33 tests |
| Week 3 | Task 14.6 (Perf) + Task 14.7 (UI/UX) + Task 14.8 (Electron) + Regression | 16 tests + regression |

**Total**: 91 test cases across 8 tasks over 3 weeks.
