import { Test, TestingModule } from '@nestjs/testing';
import { SystemMessage } from '@langchain/core/messages';
import { ClassifierChain } from './classifier.chain';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';
import { LlmQuotaExhaustedError } from '../errors/llm-quota-exhausted.error';

describe('ClassifierChain', () => {
  let chain: ClassifierChain;
  let run: jest.Mock;
  let runs: { input: any; opts: any }[];

  beforeEach(async () => {
    runs = [];
    run = jest.fn(async (_c: unknown, input: any, opts: any) => {
      runs.push({ input, opts });
      return { isEvent: true, reason: 'has a date' };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClassifierChain,
        {
          provide: GeminiChatFactory,
          useValue: {
            defaultModel: 'gemini-2.0-flash',
            create: () => ({ withStructuredOutput: () => ({}) }),
          },
        },
        { provide: ChainRunner, useValue: { run } },
        {
          provide: PromptRegistry,
          useValue: {
            classifierPrompt: jest
              .fn()
              .mockResolvedValue({ prompt: 'GATE RULES', version: 'v1' }),
          },
        },
      ],
    }).compile();

    chain = module.get(ClassifierChain);
  });

  it('returns the structured verdict', async () => {
    await expect(chain.classify('Trip on Monday')).resolves.toEqual({
      isEvent: true,
      reason: 'has a date',
    });
  });

  it('passes a negative verdict through unchanged', async () => {
    run.mockResolvedValue({ isEvent: false, reason: 'chit-chat' });
    await expect(chain.classify('thanks!')).resolves.toEqual({
      isEvent: false,
      reason: 'chit-chat',
    });
  });

  it('uses the active classifier prompt as the system message', async () => {
    await chain.classify('anything');
    expect(runs[0].input[0]).toBeInstanceOf(SystemMessage);
    expect(runs[0].input[0].content).toBe('GATE RULES');
  });

  it('prefixes the date context when one is given', async () => {
    await chain.classify('trip tomorrow', '2026-03-01');
    expect(runs[0].input[1].content).toBe(
      'Current date: 2026-03-01\n\ntrip tomorrow',
    );
  });

  it('omits the prefix when no date context is given', async () => {
    await chain.classify('trip tomorrow');
    expect(runs[0].input[1].content).toBe('trip tomorrow');
  });

  it('names the run so it is findable in a trace', async () => {
    await chain.classify('anything');
    expect(runs[0].opts.runName).toBe('classify-relevance');
  });

  describe('reason handling', () => {
    it('truncates an overlong reason', async () => {
      run.mockResolvedValue({ isEvent: true, reason: 'x'.repeat(200) });
      const verdict = await chain.classify('anything');
      expect(verdict.reason).toHaveLength(80);
    });

    it('substitutes a placeholder when the model gives no reason', async () => {
      run.mockResolvedValue({ isEvent: false, reason: '   ' });
      await expect(chain.classify('anything')).resolves.toEqual({
        isEvent: false,
        reason: '(no reason)',
      });
    });
  });

  describe('fail-open contract', () => {
    it('treats a provider failure as "might be an event"', async () => {
      run.mockRejectedValue(new Error('network down'));
      await expect(chain.classify('anything')).resolves.toEqual({
        isEvent: true,
        reason: 'classifier-fail-open',
      });
    });

    /**
     * A depleted account must not be recorded as "not an event" — that would
     * mark the message parsed and lose it. The extractor's own quota handling
     * is what decides to leave it for the next sync.
     */
    it('fails open on an exhausted quota rather than rejecting the message', async () => {
      run.mockRejectedValue(new LlmQuotaExhaustedError('out of credit'));
      await expect(chain.classify('anything')).resolves.toEqual({
        isEvent: true,
        reason: 'classifier-fail-open',
      });
    });
  });
});
