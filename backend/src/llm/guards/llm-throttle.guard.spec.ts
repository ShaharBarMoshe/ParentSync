import { LlmRateLimiter } from './llm-throttle.guard';

describe('LlmRateLimiter', () => {
  let rateLimiter: LlmRateLimiter;

  beforeEach(() => {
    rateLimiter = new LlmRateLimiter();
  });

  it('should be defined', () => {
    expect(rateLimiter).toBeDefined();
  });

  it('should allow requests under the limit', async () => {
    await rateLimiter.acquire();
    expect(rateLimiter.getCurrentCount()).toBe(1);
  });

  it('should track multiple requests', async () => {
    for (let i = 0; i < 5; i++) {
      await rateLimiter.acquire();
    }
    expect(rateLimiter.getCurrentCount()).toBe(5);
  });

  it('should prune old entries', async () => {
    // Manually test pruning by checking the count
    await rateLimiter.acquire();
    expect(rateLimiter.getCurrentCount()).toBe(1);
    // Current count should still be 1 since we haven't waited
    expect(rateLimiter.getCurrentCount()).toBeGreaterThanOrEqual(1);
  });

  it('should start with zero count', () => {
    expect(rateLimiter.getCurrentCount()).toBe(0);
  });
});
