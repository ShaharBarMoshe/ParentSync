import { Test, TestingModule } from '@nestjs/testing';
import { GeminiEmbeddingService } from './gemini-embedding.service';
import { SettingsService } from '../../settings/settings.service';
import { EmbeddingFailedError } from '../interfaces/embedding-service.interface';

const embedContentMock = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { embedContent: embedContentMock },
  })),
}));

describe('GeminiEmbeddingService', () => {
  let service: GeminiEmbeddingService;

  const fakeVector = (n: number) => Array.from({ length: 768 }, (_, i) => i + n);

  beforeEach(async () => {
    embedContentMock.mockReset();
    embedContentMock.mockResolvedValue({ embeddings: [{ values: fakeVector(0) }] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiEmbeddingService,
        {
          provide: SettingsService,
          useValue: {
            findByKeyDecrypted: jest.fn().mockResolvedValue({ value: 'test-key' }),
          },
        },
      ],
    }).compile();

    service = module.get(GeminiEmbeddingService);
    await service.onModuleInit();
  });

  it('returns a 768-element number array', async () => {
    const v = await service.embedText('hello world');
    expect(Array.isArray(v)).toBe(true);
    expect(v).toHaveLength(768);
    expect(typeof v[0]).toBe('number');
  });

  it('caches identical text — SDK called once', async () => {
    await service.embedText('same text');
    await service.embedText('same text');
    expect(embedContentMock).toHaveBeenCalledTimes(1);
  });

  it('throws EmbeddingFailedError when the SDK throws', async () => {
    embedContentMock.mockRejectedValueOnce(new Error('network down'));
    await expect(service.embedText('boom')).rejects.toBeInstanceOf(
      EmbeddingFailedError,
    );
  });

  it('throws EmbeddingFailedError when the SDK returns no embeddings', async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [] });
    await expect(service.embedText('empty')).rejects.toBeInstanceOf(
      EmbeddingFailedError,
    );
  });

  it('embedBatch returns one vector per input in order', async () => {
    embedContentMock
      .mockResolvedValueOnce({ embeddings: [{ values: fakeVector(1) }] })
      .mockResolvedValueOnce({ embeddings: [{ values: fakeVector(2) }] })
      .mockResolvedValueOnce({ embeddings: [{ values: fakeVector(3) }] });

    const vectors = await service.embedBatch(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    expect(vectors[0][0]).toBe(1);
    expect(vectors[1][0]).toBe(2);
    expect(vectors[2][0]).toBe(3);
  });
});
