import { LangChainEmbeddingService } from './langchain-embedding.service';
import { SettingsService } from '../../settings/settings.service';
import { EmbeddingFailedError } from '../interfaces/embedding-service.interface';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';

const embedDocuments = jest.fn();
const constructorCalls: any[] = [];

jest.mock('@langchain/google-genai', () => ({
  GoogleGenerativeAIEmbeddings: jest.fn().mockImplementation((config: unknown) => {
    constructorCalls.push(config);
    return { embedDocuments };
  }),
}));

describe('LangChainEmbeddingService', () => {
  let service: LangChainEmbeddingService;
  let settings: Record<string, string>;

  const vector = (seed: number) => [seed, seed + 1, seed + 2];

  beforeEach(async () => {
    jest.clearAllMocks();
    constructorCalls.length = 0;
    settings = { gemini_api_key: 'AIzaTESTKEY' };

    const settingsService = {
      findByKeyDecrypted: jest.fn(async (key: string) => {
        if (!(key in settings)) throw new Error('not found');
        return { key, value: settings[key] };
      }),
    } as unknown as SettingsService;

    service = new LangChainEmbeddingService(settingsService);
    await service.onModuleInit();
    embedDocuments.mockResolvedValue([vector(1)]);
  });

  describe('embedText', () => {
    it('returns the vector for a single text', async () => {
      await expect(service.embedText('hello')).resolves.toEqual(vector(1));
      expect(embedDocuments).toHaveBeenCalledWith(['hello']);
    });

    it('caches by content so a repeat costs no API call', async () => {
      await service.embedText('hello');
      await service.embedText('hello');

      expect(embedDocuments).toHaveBeenCalledTimes(1);
    });

    it('caches per text, not globally', async () => {
      embedDocuments.mockResolvedValueOnce([vector(1)]).mockResolvedValueOnce([vector(9)]);

      await expect(service.embedText('a')).resolves.toEqual(vector(1));
      await expect(service.embedText('b')).resolves.toEqual(vector(9));
      expect(embedDocuments).toHaveBeenCalledTimes(2);
    });

    it('rejects an empty vector rather than returning it', async () => {
      embedDocuments.mockResolvedValue([[]]);

      await expect(service.embedText('hello')).rejects.toBeInstanceOf(
        EmbeddingFailedError,
      );
    });

    it('fails clearly when no API key is configured', async () => {
      const bare = new LangChainEmbeddingService({
        findByKeyDecrypted: jest.fn().mockRejectedValue(new Error('x')),
      } as unknown as SettingsService);
      await bare.onModuleInit();

      await expect(bare.embedText('hello')).rejects.toThrow(
        /not configured/,
      );
    });

    it('disables LangChain’s own retries', async () => {
      expect(constructorCalls[0].maxRetries).toBe(0);
    });
  });

  describe('embedBatch', () => {
    it('preserves input order', async () => {
      embedDocuments.mockResolvedValue([vector(1), vector(2), vector(3)]);

      await expect(service.embedBatch(['a', 'b', 'c'])).resolves.toEqual([
        vector(1),
        vector(2),
        vector(3),
      ]);
    });

    it('issues one API call for the whole batch, not one per text', async () => {
      embedDocuments.mockResolvedValue([vector(1), vector(2), vector(3)]);

      await service.embedBatch(['a', 'b', 'c']);

      expect(embedDocuments).toHaveBeenCalledTimes(1);
      expect(embedDocuments).toHaveBeenCalledWith(['a', 'b', 'c']);
    });

    /**
     * Calendar-conflict dedup embeds the proposed event and then a window of
     * candidate summaries, so partial cache hits are the normal case.
     */
    it('sends only the uncached texts and stitches results back in order', async () => {
      embedDocuments.mockResolvedValueOnce([vector(5)]);
      await service.embedText('b');
      embedDocuments.mockResolvedValueOnce([vector(1), vector(3)]);

      const result = await service.embedBatch(['a', 'b', 'c']);

      expect(embedDocuments).toHaveBeenLastCalledWith(['a', 'c']);
      expect(result).toEqual([vector(1), vector(5), vector(3)]);
    });

    it('makes no API call when everything is cached', async () => {
      embedDocuments.mockResolvedValue([vector(1), vector(2)]);
      await service.embedBatch(['a', 'b']);
      embedDocuments.mockClear();

      await expect(service.embedBatch(['a', 'b'])).resolves.toEqual([
        vector(1),
        vector(2),
      ]);
      expect(embedDocuments).not.toHaveBeenCalled();
    });

    it('returns an empty array without calling out', async () => {
      await expect(service.embedBatch([])).resolves.toEqual([]);
      expect(embedDocuments).not.toHaveBeenCalled();
    });

    /**
     * A short batch would otherwise pair vectors with the wrong source text
     * and corrupt every similarity score downstream.
     */
    it('refuses a response whose length does not match the request', async () => {
      embedDocuments.mockResolvedValue([vector(1)]);

      await expect(service.embedBatch(['a', 'b', 'c'])).rejects.toThrow(
        /returned 1 vectors for 3 inputs/,
      );
    });

    it('sends a repeated text once and fans the vector back out', async () => {
      embedDocuments.mockResolvedValue([vector(1), vector(2)]);

      const result = await service.embedBatch(['a', 'b', 'a']);

      expect(embedDocuments).toHaveBeenCalledWith(['a', 'b']);
      expect(result).toEqual([vector(1), vector(2), vector(1)]);
    });
  });

  describe('failure contract', () => {
    it('wraps a provider failure so dedup can fail open', async () => {
      embedDocuments.mockRejectedValue(new Error('socket hang up'));

      const error = await service.embedText('hello').catch((e) => e);

      expect(error).toBeInstanceOf(EmbeddingFailedError);
      expect(error.cause).toBeDefined();
    });

    it('names a depleted account separately from a flaky call', async () => {
      embedDocuments.mockRejectedValue(
        new Error('prepayment credits are depleted'),
      );

      await expect(service.embedText('hello')).rejects.toBeInstanceOf(
        LlmQuotaExhaustedError,
      );
    });
  });

  describe('settings hot-reload', () => {
    it('rebuilds the client and drops the cache when the key changes', async () => {
      await service.embedText('hello');
      expect(embedDocuments).toHaveBeenCalledTimes(1);

      service.handleSettingsChanged({ key: 'gemini_api_key', value: ' AIzaNEW ' });

      await service.embedText('hello');
      expect(embedDocuments).toHaveBeenCalledTimes(2);
      expect(constructorCalls.at(-1).apiKey).toBe('AIzaNEW');
    });

    it('ignores unrelated settings', async () => {
      await service.embedText('hello');
      service.handleSettingsChanged({ key: 'gemini_model', value: 'x' });
      await service.embedText('hello');

      expect(embedDocuments).toHaveBeenCalledTimes(1);
    });
  });
});
