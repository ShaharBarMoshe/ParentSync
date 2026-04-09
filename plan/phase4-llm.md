# Phase 4: LLM Integration

**Status**: Done

## Task 4.1: OpenRouter API Client (NestJS LlmModule)
**Description**: Create NestJS LlmModule with injectable OpenRouter service using HttpModule.

**Dependencies**: Task 1.1, Task 1.2

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `di-use-interfaces-tokens`, `api-use-interceptors`, `perf-use-caching`.

**What needs to be done**:
- **Create LlmModule** with `@nestjs/axios` HttpModule:
  ```typescript
  @Module({
    imports: [HttpModule.register({ timeout: 30000, maxRedirects: 3 })],
    providers: [
      { provide: LLM_SERVICE, useClass: OpenRouterService },
      MessageParserService,
    ],
    exports: [LLM_SERVICE, MessageParserService],
  })
  ```
- **Define DTOs** for request/response:
  - `LlmRequestDto`: messages (array), model, temperature, maxTokens
  - `LlmResponseDto`: choices (array with content)
- **Create OpenRouterService** implementing `ILLMService` interface:
  - Method: `callLLM(messages: LlmMessage[]): Promise<string>`
  - Inject `HttpService` and `SettingsService` via constructor
  - API key loaded from database via `SettingsService` (runtime-configurable via Settings UI, never logged — `devops-use-logging`)
  - Listens to `settings.changed` events for dynamic model/API key updates
- Implement error handling with retries (max 3 with exponential backoff)
- **Use NestJS interceptor** for request logging (sanitize API key) (`api-use-interceptors`)
- Add timeout handling (30 seconds via HttpModule config)

**Success Criteria**:
- [x] API client makes successful requests to OpenRouter
- [x] Requests properly formatted with OpenRouter headers
- [x] Responses parsed correctly
- [x] API key never exposed in logs
- [x] Error responses handled with appropriate HTTP status codes

**Testing**:
- Unit tests using `Test.createTestingModule()` with mock `HttpService` (`test-use-testing-module`, `test-mock-external-services`)
- Integration tests with real OpenRouter API
- Test error scenarios (invalid request, API down, timeout)
- Test retry logic

**Acceptance**: LlmModule functional with injectable OpenRouterService, tested with mocks and real API

---

## Task 4.2: Message Parser (LLM-based)
**Description**: Implement prompt engineering and response parsing for extracting calendar events.

**Dependencies**: Task 1.1, Task 1.3, Task 4.1

**What needs to be done**:
- Design system prompt for LLM (stored in code or config):
  ```
  Extract calendar events from the following message. Return a JSON array of events.
  If no event is detected, return an empty array [].
  Each event must have: title, description, date (YYYY-MM-DD), time (HH:MM), location.
  Example: [{"title":"Birthday","date":"2026-03-15","time":"14:00","location":"Park"}]
  ```
- Create MessageParser backend class:
  - Method: `parseMessage(content: String): Promise<CalendarEvent[]>`
  - Call LLM with message content
  - Extract JSON from response
  - Validate extracted data
  - Return CalendarEvent objects
- Add fallback for parsing errors (log error, return empty array)

**Success Criteria**:
- [x] Parser correctly extracts events from messages
- [x] Returns valid CalendarEvent objects
- [x] Handles non-event messages (returns empty array)
- [x] Parsing errors don't crash (logged and handled)
- [x] Parser tested with diverse samples

**Testing**:
- Unit tests with mock LLM responses
- Integration tests with real LLM calls
- Test edge cases: no event, multiple events, ambiguous dates, malformed JSON
- Sample test messages:
  - "birthday for miki 12.3.26 in the jungle park Modiin" → {title: "Miki's Birthday", date: "2026-03-12", location: "Jungle Park, Modiin"}
  - "hello how are you?" → []
  - "doctor appointment tuesday 3pm with dr. smith" → {title: "Doctor Appointment", time: "15:00", location: "Dr. Smith's office"}

**Acceptance**: Parser tested with 10+ diverse samples, 80%+ accuracy

---

## Task 4.3: LLM Rate Limiting & Caching (NestJS)
**Description**: Implement rate limiting and caching using NestJS built-in modules.

**Dependencies**: Task 4.1, Task 4.2, Task 1.3

**Reference**: See `.agents/skills/nestjs-best-practices/SKILL.md` — rules `perf-use-caching`, `security-rate-limiting`, `micro-use-queues`.

**What needs to be done**:
- **Custom `LlmRateLimiter`** for rate limiting LLM calls (max 20 requests per minute):
  - Token bucket algorithm with 60-second sliding window
  - Automatically waits when limit exceeded (no rejected requests)
  - **Note**: Uses a custom implementation instead of `@nestjs/throttler` for finer LLM-specific control
- **Use `@nestjs/cache-manager`** for response caching (`perf-use-caching`):
  - Cache key: SHA256 hash of message content
  - TTL: 24 hours (86400 seconds)
  - Manual cache injection in `MessageParserService`
- Add cache hit/miss logging via NestJS Logger (`devops-use-logging`)
- **Custom `LlmQueueProcessor`** for sequential background processing:
  - In-memory Promise-based queue with concurrency control
  - Respects rate limiting before each processing step
  - **Note**: Uses a custom queue instead of `@nestjs/bull` to avoid Redis dependency
- Return cached response if available, skip LLM call

**Success Criteria**:
- [x] API calls don't exceed rate limit
- [x] Identical messages served from cache (within TTL)
- [x] Cache reduces LLM API calls by 50%+
- [x] Rate-limited requests queued and processed
- [x] Cache performance doesn't impact page load

**Testing**:
- Unit tests for rate limiter
- Integration tests with cache
- Stress test: process 100 messages rapidly
- Verify cache TTL expiration
- Monitor API call reduction

**Acceptance**: Rate limiting and caching working, API call reduction verified
