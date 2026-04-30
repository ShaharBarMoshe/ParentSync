import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppErrorEmitterService } from './app-error-emitter.service';

describe('AppErrorEmitterService', () => {
  let service: AppErrorEmitterService;
  let emitter: EventEmitter2;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppErrorEmitterService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(AppErrorEmitterService);
    emitter = moduleRef.get(EventEmitter2);
  });

  it('emits app.error with timestamp on first call', () => {
    const ok = service.emit({
      source: 'oauth',
      code: 'OAUTH_REFRESH_FAILED',
      message: 'expired',
    });

    expect(ok).toBe(true);
    expect(emitter.emit).toHaveBeenCalledWith(
      'app.error',
      expect.objectContaining({
        source: 'oauth',
        code: 'OAUTH_REFRESH_FAILED',
        message: 'expired',
        timestamp: expect.any(String),
      }),
    );
  });

  it('suppresses repeated emissions of the same code within the dedupe window', () => {
    service.emit({ source: 's', code: 'C1', message: 'm' });
    const ok = service.emit({ source: 's', code: 'C1', message: 'm' });

    expect(ok).toBe(false);
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('emits different codes independently within the same window', () => {
    service.emit({ source: 's', code: 'A', message: 'm' });
    service.emit({ source: 's', code: 'B', message: 'm' });

    expect(emitter.emit).toHaveBeenCalledTimes(2);
  });

  it('re-emits after clear()', () => {
    service.emit({ source: 's', code: 'C', message: 'm' });
    service.clear('C');
    const ok = service.emit({ source: 's', code: 'C', message: 'm' });

    expect(ok).toBe(true);
    expect(emitter.emit).toHaveBeenCalledTimes(2);
  });

  it('respects a per-call dedupeWindowMs of 0 (no dedupe)', () => {
    service.emit({ source: 's', code: 'D', message: 'm' }, { dedupeWindowMs: 0 });
    service.emit({ source: 's', code: 'D', message: 'm' }, { dedupeWindowMs: 0 });

    expect(emitter.emit).toHaveBeenCalledTimes(2);
  });
});
