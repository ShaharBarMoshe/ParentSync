import '@testing-library/jest-dom';

/**
 * jsdom does not implement EventSource, and `ErrorModal` opens an SSE stream
 * on mount — so every test that renders the app tree threw
 * `ReferenceError: EventSource is not defined` before reaching its assertions.
 *
 * This stub records listeners and stays inert: no test currently drives server
 * events, and a real connection attempt in a unit test would be worse than
 * none. Tests that need to simulate an event can reach for the instance and
 * invoke its handler directly.
 */
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = MockEventSource.CONNECTING;
  readonly OPEN = MockEventSource.OPEN;
  readonly CLOSED = MockEventSource.CLOSED;

  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    readonly url: string,
    readonly withCredentials = false,
  ) {}

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.listeners.get(event.type)?.forEach((l) => l(event));
    return true;
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
    this.listeners.clear();
  }
}

globalThis.EventSource ??= MockEventSource as unknown as typeof EventSource;
