import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageDeduplicationService } from './message-deduplication.service';
import {
  EMBEDDING_SERVICE,
  MESSAGE_REPOSITORY,
} from '../../shared/constants/injection-tokens';
import { SettingsService } from '../../settings/settings.service';
import { sha256 } from '../../shared/utils/hash';

describe('MessageDeduplicationService', () => {
  let service: MessageDeduplicationService;
  let messageRepo: { findParsedWithEmbeddings: jest.Mock };
  let embeddingService: { embedText: jest.Mock; embedBatch: jest.Mock };
  let settings: { findByKey: jest.Mock };

  const unitVec = (len: number, seed: number) => {
    const arr = Array.from({ length: len }, (_, i) =>
      Math.sin(i * (seed + 1)),
    );
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    return arr.map((v) => v / mag);
  };

  const settingsResolver =
    (overrides: Record<string, string> = {}) =>
    (key: string) => {
      const defaults: Record<string, string> = {
        dedup_enabled: 'true',
        dedup_threshold: '0.92',
      };
      const v = overrides[key] ?? defaults[key];
      if (v === undefined)
        return Promise.reject(new Error(`Setting not found: ${key}`));
      return Promise.resolve({ value: v });
    };

  beforeEach(async () => {
    messageRepo = { findParsedWithEmbeddings: jest.fn().mockResolvedValue([]) };
    embeddingService = {
      embedText: jest.fn(),
      embedBatch: jest.fn(),
    };
    settings = { findByKey: jest.fn().mockImplementation(settingsResolver()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageDeduplicationService,
        { provide: MESSAGE_REPOSITORY, useValue: messageRepo },
        { provide: EMBEDDING_SERVICE, useValue: embeddingService },
        { provide: SettingsService, useValue: settings },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(MessageDeduplicationService);
  });

  it('returns no match when dedup_enabled is false (and never calls repo)', async () => {
    settings.findByKey.mockImplementation(
      settingsResolver({ dedup_enabled: 'false' }),
    );

    const result = await service.findDuplicateOf('any content');

    expect(result.match).toBeNull();
    expect(messageRepo.findParsedWithEmbeddings).not.toHaveBeenCalled();
    expect(embeddingService.embedText).not.toHaveBeenCalled();
  });

  it('returns an exact-hash match without calling the embedding API', async () => {
    const content = 'identical flyer';
    const hash = sha256(content);
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'm1', embedding: unitVec(8, 1), contentHash: hash },
    ]);

    const result = await service.findDuplicateOf(content);

    expect(result.match).toEqual({
      matchedMessageId: 'm1',
      similarity: 1.0,
      exact: true,
    });
    expect(embeddingService.embedText).not.toHaveBeenCalled();
  });

  it('returns no match when best similarity is below threshold', async () => {
    embeddingService.embedText.mockResolvedValue(unitVec(8, 1));
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'm1', embedding: unitVec(8, 50), contentHash: 'other-hash' },
    ]);

    const result = await service.findDuplicateOf('fresh content');

    expect(result.match).toBeNull();
    expect(result.embedding).not.toBeNull();
  });

  it('returns a match when similarity ≥ threshold', async () => {
    const target = unitVec(8, 1);
    embeddingService.embedText.mockResolvedValue(target);
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'm1', embedding: target, contentHash: 'h-other' },
    ]);

    const result = await service.findDuplicateOf('paraphrase');

    expect(result.match?.matchedMessageId).toBe('m1');
    expect(result.match?.exact).toBe(false);
    expect(result.match!.similarity).toBeGreaterThanOrEqual(0.92);
  });

  it('fails open when the embedding API throws', async () => {
    embeddingService.embedText.mockRejectedValue(new Error('429 rate limit'));
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'm1', embedding: unitVec(8, 9), contentHash: 'h' },
    ]);

    const result = await service.findDuplicateOf('boom');

    expect(result.match).toBeNull();
    expect(result.embedding).toBeNull();
  });

  it('returns no match when there are zero candidates in the window', async () => {
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([]);
    embeddingService.embedText.mockResolvedValue(unitVec(8, 1));

    const result = await service.findDuplicateOf('first message ever');

    expect(result.match).toBeNull();
  });

  it('picks the candidate with the highest similarity above threshold', async () => {
    const target = unitVec(8, 1);
    // Perturb a single coordinate, then re-normalize, so the vector points
    // in a slightly different direction (uniform scaling alone won't change
    // direction — unitVec's normalization undoes it).
    const perturbed = [...target];
    perturbed[0] += 0.15;
    const magP = Math.sqrt(perturbed.reduce((s, v) => s + v * v, 0));
    const perturbedNorm = perturbed.map((v) => v / magP);

    embeddingService.embedText.mockResolvedValue(target);
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'lower', embedding: perturbedNorm, contentHash: 'a' },
      { id: 'best', embedding: target, contentHash: 'b' },
    ]);

    const result = await service.findDuplicateOf('text');

    expect(result.match?.matchedMessageId).toBe('best');
  });

  it('falls back to default threshold when stored value is invalid', async () => {
    settings.findByKey.mockImplementation(
      settingsResolver({ dedup_threshold: 'banana' }),
    );
    const target = unitVec(8, 1);
    embeddingService.embedText.mockResolvedValue(target);
    messageRepo.findParsedWithEmbeddings.mockResolvedValue([
      { id: 'm1', embedding: target, contentHash: 'x' },
    ]);

    const result = await service.findDuplicateOf('text');

    expect(result.match?.matchedMessageId).toBe('m1');
  });
});
