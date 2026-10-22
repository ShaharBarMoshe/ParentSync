import { Test, TestingModule } from '@nestjs/testing';
import { TracingService } from './tracing.service';
import { SettingsService } from '../../settings/settings.service';

jest.mock('langsmith', () => ({
  Client: jest.fn().mockImplementation((config: unknown) => ({ __config: config })),
}));

describe('TracingService', () => {
  let service: TracingService;
  let settings: Record<string, string>;
  const { Client } = require('langsmith');

  beforeEach(async () => {
    jest.clearAllMocks();
    settings = {};

    const settingsService = {
      findByKey: jest.fn(async (key: string) => {
        if (!(key in settings)) throw new Error(`Setting "${key}" not found`);
        return { key, value: settings[key] };
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TracingService,
        { provide: SettingsService, useValue: settingsService },
      ],
    }).compile();

    service = module.get(TracingService);
  });

  /**
   * The default matters more than any other behaviour here: this app reads
   * children's school messages, and LangSmith is a hosted service.
   */
  describe('opt-in by default', () => {
    it('is disabled when nothing is configured, and builds no client', async () => {
      await expect(service.callbacks()).resolves.toBeUndefined();
      await expect(service.isEnabled()).resolves.toBe(false);
      expect(Client).not.toHaveBeenCalled();
    });

    it('stays disabled when an API key is present but the switch is off', async () => {
      settings.langsmith_api_key = 'ls-secret';

      await expect(service.callbacks()).resolves.toBeUndefined();
      expect(Client).not.toHaveBeenCalled();
    });

    it('stays disabled when enabled without an API key', async () => {
      settings.langsmith_enabled = 'true';

      await expect(service.callbacks()).resolves.toBeUndefined();
      expect(Client).not.toHaveBeenCalled();
    });

    it('traces once enabled with a key', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';

      const callbacks = await service.callbacks();

      expect(callbacks).toHaveLength(1);
      expect(Client).toHaveBeenCalledTimes(1);
    });

    it.each(['false', 'FALSE', '', '   '])(
      'treats %p as disabled',
      async (value) => {
        settings.langsmith_enabled = value;
        settings.langsmith_api_key = 'ls-secret';

        await expect(service.callbacks()).resolves.toBeUndefined();
      },
    );
  });

  describe('redaction', () => {
    async function clientConfig(overrides: Record<string, string> = {}) {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      Object.assign(settings, overrides);
      await service.callbacks();
      return (Client as jest.Mock).mock.calls[0][0];
    }

    it('is on by default', async () => {
      const config = await clientConfig();
      expect(typeof config.hideInputs).toBe('function');
      expect(typeof config.hideOutputs).toBe('function');
    });

    it('can be switched off explicitly', async () => {
      const config = await clientConfig({ langsmith_redact: 'false' });
      expect(config.hideInputs).toBeUndefined();
      expect(config.hideOutputs).toBeUndefined();
    });

    /**
     * The assertion that matters: a realistic pipeline payload must not carry
     * any message text off the machine.
     */
    it('leaves no message content in a realistic payload', async () => {
      const config = await clientConfig();
      const payload = {
        model: 'gemini-2.5-flash-lite',
        groupCount: 2,
        messages: [
          { role: 'system', content: 'You are a calendar event extractor.' },
          { role: 'user', content: 'אסיפת הורים ביום שלישי ב-18:00' },
        ],
        groups: [{ mergedContent: 'טיול שנתי ביום חמישי', childId: 'child-1' }],
      };

      const redacted = config.hideInputs(payload);
      const serialized = JSON.stringify(redacted);

      expect(serialized).not.toContain('אסיפת הורים');
      expect(serialized).not.toContain('טיול שנתי');
      expect(serialized).not.toContain('calendar event extractor');
      // Structure survives, so a trace is still worth reading.
      expect(redacted.model).toBe('gemini-2.5-flash-lite');
      expect(redacted.groupCount).toBe(2);
      expect(redacted.messages).toHaveLength(2);
      expect(redacted.messages[0].role).toBe('system');
      expect(redacted.groups[0].childId).toBe('child-1');
    });

    it('replaces content with a stable hash and the original length', () => {
      const once = service.redact({ content: 'school trip friday' }) as Record<string, string>;
      const twice = service.redact({ content: 'school trip friday' }) as Record<string, string>;

      expect(once.content).toMatch(/^sha256:[0-9a-f]{12}\/18$/);
      expect(once.content).toBe(twice.content);
      expect(service.redact({ content: 'different text' })).not.toEqual(once);
    });

    it('keeps an empty string empty rather than hashing it', () => {
      expect(service.redact({ content: '' })).toEqual({ content: '' });
    });

    it('redacts content nested under structural keys', () => {
      const redacted = service.redact({
        state: { groups: [{ mergedContent: 'secret text' }] },
      }) as any;

      expect(redacted.state.groups[0].mergedContent).toMatch(/^sha256:/);
    });

    it('terminates on a deeply nested payload instead of hanging', () => {
      let deep: Record<string, unknown> = { content: 'bottom' };
      for (let i = 0; i < 40; i++) deep = { nested: deep };

      expect(() => service.redact(deep)).not.toThrow();
      expect(JSON.stringify(service.redact(deep))).toContain('[redacted:depth]');
    });

    it('preserves non-string scalars', () => {
      expect(
        service.redact({ tokens: 3288, ok: true, cost: null, missing: undefined }),
      ).toEqual({ tokens: 3288, ok: true, cost: null, missing: undefined });
    });
  });

  describe('reacting to settings changes', () => {
    it('rebuilds the tracer when a tracing setting changes', async () => {
      await expect(service.callbacks()).resolves.toBeUndefined();

      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      service.handleSettingsChanged({ key: 'langsmith_enabled' });

      await expect(service.callbacks()).resolves.toHaveLength(1);
    });

    it('can be switched back off without a restart', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      await expect(service.callbacks()).resolves.toHaveLength(1);

      settings.langsmith_enabled = 'false';
      service.handleSettingsChanged({ key: 'langsmith_enabled' });

      await expect(service.callbacks()).resolves.toBeUndefined();
    });

    it('ignores unrelated settings changes', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      await service.callbacks();

      service.handleSettingsChanged({ key: 'gemini_model' });
      await service.callbacks();

      // Still the one client built on first resolve — no needless rebuild.
      expect(Client).toHaveBeenCalledTimes(1);
    });

    it('caches the resolution instead of re-reading settings every call', async () => {
      await service.callbacks();
      await service.callbacks();
      await service.callbacks();

      const reads = (
        service as unknown as { settingsService: { findByKey: jest.Mock } }
      ).settingsService.findByKey.mock.calls.length;
      expect(reads).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('never lets a tracing failure break the pipeline', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      (Client as jest.Mock).mockImplementationOnce(() => {
        throw new Error('langsmith unreachable');
      });

      await expect(service.callbacks()).resolves.toBeUndefined();
    });

    it('does not log the API key', async () => {
      const logs: string[] = [];
      jest
        .spyOn(
          (service as unknown as { logger: { log: (m: string) => void } }).logger,
          'log',
        )
        .mockImplementation((m: string) => void logs.push(m));

      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-super-secret-key';
      settings.langsmith_project = 'parentsync';
      await service.callbacks();

      expect(logs.join('\n')).not.toContain('ls-super-secret-key');
    });

    it('warns loudly when redaction is off', async () => {
      const logs: string[] = [];
      jest
        .spyOn(
          (service as unknown as { logger: { log: (m: string) => void } }).logger,
          'log',
        )
        .mockImplementation((m: string) => void logs.push(m));

      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      settings.langsmith_redact = 'false';
      await service.callbacks();

      expect(logs.join('\n')).toContain('message content will be uploaded');
    });
  });

  describe('project name', () => {
    it('defaults to parentsync', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      await service.callbacks();

      const tracer = (await service.callbacks())![0] as { projectName?: string };
      expect(tracer.projectName).toBe('parentsync');
    });

    it('uses the configured project when set', async () => {
      settings.langsmith_enabled = 'true';
      settings.langsmith_api_key = 'ls-secret';
      settings.langsmith_project = '  my-project  ';
      await service.callbacks();

      const tracer = (await service.callbacks())![0] as { projectName?: string };
      expect(tracer.projectName).toBe('my-project');
    });
  });
});
