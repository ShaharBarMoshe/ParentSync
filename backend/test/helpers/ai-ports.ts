import type { TestingModuleBuilder } from '@nestjs/testing';
import {
  EVENT_EXTRACTOR,
  RELEVANCE_CLASSIFIER,
  DUPLICATE_JUDGE,
  type ExtractionRequest,
  type ExtractionResult,
  type IEventExtractor,
  type IRelevanceClassifier,
  type IDuplicateJudge,
} from '../../src/llm/ports/ai-ports';
import { EMBEDDING_SERVICE } from '../../src/shared/constants/injection-tokens';

/**
 * Stubs for the four AI ports, for e2e specs.
 *
 * All four must be overridden together. Overriding only the extractor leaves
 * the real classifier chain in place, and the first message through the
 * pipeline then makes a live Gemini call — which fails slowly, and only in CI.
 */
export interface AiPortMocks {
  extractor: IEventExtractor & { extract: jest.Mock };
  classifier: IRelevanceClassifier & { classify: jest.Mock };
  duplicateJudge: IDuplicateJudge & { areIdentical: jest.Mock };
  embeddings: { embedText: jest.Mock; embedBatch: jest.Mock };
}

/**
 * Every port stubbed to its most inert answer: nothing extracted, everything
 * relevant, nothing duplicated. Specs override the one they care about.
 */
export function createAiPortMocks(): AiPortMocks {
  return {
    extractor: {
      extract: jest.fn(
        async (requests: ExtractionRequest[]): Promise<ExtractionResult[]> =>
          requests.map((r) => ({ id: r.id, events: [] })),
      ),
    },
    classifier: {
      classify: jest.fn().mockResolvedValue({ isEvent: true, reason: 'stub' }),
    },
    duplicateJudge: { areIdentical: jest.fn().mockResolvedValue(false) },
    embeddings: {
      embedText: jest.fn().mockResolvedValue(null),
      embedBatch: jest.fn().mockResolvedValue([]),
    },
  };
}

/** Apply the stubs to a testing module builder. */
export function overrideAiPorts(
  builder: TestingModuleBuilder,
  mocks: AiPortMocks,
): TestingModuleBuilder {
  return builder
    .overrideProvider(EVENT_EXTRACTOR)
    .useValue(mocks.extractor)
    .overrideProvider(RELEVANCE_CLASSIFIER)
    .useValue(mocks.classifier)
    .overrideProvider(DUPLICATE_JUDGE)
    .useValue(mocks.duplicateJudge)
    .overrideProvider(EMBEDDING_SERVICE)
    .useValue(mocks.embeddings);
}

/**
 * An extractor that answers from a map of group content → events, so a spec
 * can express "this message yields this event" without caring how the adapter
 * chose to batch the call.
 */
export function extractorReturning(
  eventsFor: (content: string) => unknown[],
): jest.Mock {
  return jest.fn(async (requests: ExtractionRequest[]) =>
    requests.map((r) => ({ id: r.id, events: eventsFor(r.content) as any })),
  );
}
