import { Test, TestingModule } from '@nestjs/testing';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { ExtractionChain } from './extraction.chain';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';
import { PromptRegistry } from '../prompts/prompt-registry.service';
import { daysFromNow } from '../../../test/helpers/relative-dates';

describe('ExtractionChain', () => {
  let chain: ExtractionChain;
  let structured: jest.Mock;
  let created: { maxTokens?: number }[];
  let runs: { input: any; opts: any }[];
  /** What the fake provider returns for the next `run`. */
  let nextOutput: any;

  const date = daysFromNow(21);

  beforeEach(async () => {
    created = [];
    runs = [];
    nextOutput = { events: [] };
    structured = jest.fn().mockReturnValue({ __structured: true });

    const chatFactory = {
      defaultModel: 'gemini-2.0-flash',
      create: jest.fn((opts: any = {}) => {
        created.push(opts);
        return { withStructuredOutput: structured };
      }),
    };
    const runner = {
      run: jest.fn(async (_chain: unknown, input: any, opts: any) => {
        runs.push({ input, opts });
        return typeof nextOutput === 'function'
          ? nextOutput(input, runs.length - 1)
          : nextOutput;
      }),
    };
    const prompts = {
      systemPrompt: jest
        .fn()
        .mockResolvedValue({ prompt: 'SYSTEM RULES', version: 'v1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtractionChain,
        { provide: GeminiChatFactory, useValue: chatFactory },
        { provide: ChainRunner, useValue: runner },
        { provide: PromptRegistry, useValue: prompts },
      ],
    }).compile();

    chain = module.get(ExtractionChain);
  });

  const req = (id: string, over: Partial<any> = {}) => ({
    id,
    content: `content ${id}`,
    dateContext: date,
    ...over,
  });

  it('returns nothing for no requests, without calling the provider', async () => {
    await expect(chain.extract([])).resolves.toEqual([]);
    expect(runs).toHaveLength(0);
  });

  it('puts the active system prompt on every call', async () => {
    await chain.extract([req('a')]);
    expect(runs[0].input[0]).toBeInstanceOf(SystemMessage);
    expect(runs[0].input[0].content).toBe('SYSTEM RULES');
  });

  describe('single request', () => {
    it('uses the single-message shape and returns normalized events', async () => {
      nextOutput = { events: [{ title: '  Party  ', date, time: '10:00' }] };
      const [result] = await chain.extract([req('a')]);

      expect(runs[0].opts.runName).toBe('extract-events');
      expect(result.id).toBe('a');
      expect(result.events).toEqual([
        expect.objectContaining({ title: 'Party', time: '10:00' }),
      ]);
    });

    it('carries the request date context into the prompt', async () => {
      await chain.extract([req('a', { dateContext: '2026-05-05' })]);
      expect(runs[0].input[1].content).toContain('Current date: 2026-05-05');
    });

    it('drops an event the domain rules reject rather than throwing', async () => {
      nextOutput = {
        events: [
          { title: 'Good', date },
          { title: 'Bad', date: 'sometime next week' },
          { title: '', date },
        ],
      };
      const [result] = await chain.extract([req('a')]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].title).toBe('Good');
    });

    it('collapses one gathering the model described twice', async () => {
      nextOutput = {
        events: [
          { title: 'Party', date, time: '17:00' },
          { title: 'Party', date, time: '17:30', endTime: '18:00' },
        ],
      };
      const [result] = await chain.extract([req('a')]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].endTime).toBe('18:00');
    });

    it('survives a provider that omits the events field', async () => {
      nextOutput = {};
      const [result] = await chain.extract([req('a')]);
      expect(result.events).toEqual([]);
    });
  });

  describe('batching', () => {
    it('sends several text groups in one call, echoing their ids', async () => {
      nextOutput = {
        results: [
          { id: 'a', events: [{ title: 'A', date }] },
          { id: 'b', events: [] },
          { id: 'c', events: [{ title: 'C', date }] },
        ],
      };
      const results = await chain.extract([req('a'), req('b'), req('c')]);

      expect(runs).toHaveLength(1);
      expect(runs[0].opts.runName).toBe('extract-events-batch');
      expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      expect(results[0].events).toHaveLength(1);
      expect(results[1].events).toHaveLength(0);
    });

    it('labels each message with its id and its own date', async () => {
      await chain.extract([
        req('a', { dateContext: '2026-05-01' }),
        req('b', { dateContext: '2026-05-09' }),
      ]);
      const body = runs[0].input[1].content as string;
      expect(body).toContain('id="a"');
      expect(body).toContain('Current date for this message: 2026-05-01');
      expect(body).toContain('id="b"');
      expect(body).toContain('Current date for this message: 2026-05-09');
    });

    it('matches results by id, not by position', async () => {
      nextOutput = {
        results: [
          { id: 'c', events: [{ title: 'C', date }] },
          { id: 'a', events: [{ title: 'A', date }] },
          { id: 'b', events: [] },
        ],
      };
      const results = await chain.extract([req('a'), req('b'), req('c')]);
      expect(results[0].events[0].title).toBe('A');
      expect(results[2].events[0].title).toBe('C');
    });

    it('returns an empty result for a group the provider omitted', async () => {
      nextOutput = { results: [{ id: 'a', events: [{ title: 'A', date }] }] };
      const results = await chain.extract([req('a'), req('b')]);
      expect(results).toHaveLength(2);
      expect(results[1]).toEqual({ id: 'b', events: [] });
    });

    it('chunks past the batch ceiling instead of one giant call', async () => {
      nextOutput = (input: any) => {
        const body = input[1].content as string;
        const ids = [...body.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
        return { results: ids.map((id) => ({ id, events: [] })) };
      };
      const requests = Array.from({ length: 19 }, (_, i) => req(`g${i}`));
      const results = await chain.extract(requests);

      expect(runs).toHaveLength(3); // 8 + 8 + 3
      expect(results).toHaveLength(19);
      expect(results.map((r) => r.id)).toEqual(requests.map((r) => r.id));
    });

    it('raises the token budget with the number of groups, up to the cap', async () => {
      nextOutput = (input: any) => {
        const ids = [...(input[1].content as string).matchAll(/id="([^"]+)"/g)];
        return { results: ids.map((m) => ({ id: m[1], events: [] })) };
      };
      await chain.extract([req('a'), req('b'), req('c')]);
      expect(created[0].maxTokens).toBe(2048 + 3 * 512);
    });
  });

  describe('images', () => {
    it('sends an image-bearing group on its own, never inside a batch', async () => {
      nextOutput = (input: any) => {
        if (Array.isArray(input[1].content)) return { events: [] };
        const ids = [...(input[1].content as string).matchAll(/id="([^"]+)"/g)];
        return { results: ids.map((m) => ({ id: m[1], events: [] })) };
      };

      const results = await chain.extract([
        req('img', { images: [{ mimeType: 'image/jpeg', data: 'AAA' }] }),
        req('t1'),
        req('t2'),
      ]);

      expect(runs).toHaveLength(2); // one for the image, one batch for the text
      expect(runs[0].opts.runName).toBe('extract-events');
      expect(runs[1].opts.runName).toBe('extract-events-batch');
      expect(results.map((r) => r.id)).toEqual(['img', 't1', 't2']);
    });

    it('attaches the image as a content part on the user message', async () => {
      await chain.extract([
        req('img', { images: [{ mimeType: 'image/png', data: 'BASE64' }] }),
      ]);
      const message = runs[0].input[1] as HumanMessage;
      expect(message.content).toEqual([
        expect.objectContaining({ type: 'text' }),
        { type: 'image', mimeType: 'image/png', data: 'BASE64' },
      ]);
    });

    it('tells the model how many images to look at', async () => {
      await chain.extract([
        req('img', {
          images: [
            { mimeType: 'image/png', data: 'A' },
            { mimeType: 'image/png', data: 'B' },
          ],
        }),
      ]);
      const [textPart] = (runs[0].input[1] as any).content;
      expect(textPart.text).toContain('2 attached image(s)');
    });
  });

  it('propagates a provider failure rather than reporting no events', async () => {
    const runner = { run: jest.fn().mockRejectedValue(new Error('boom')) };
    const module = await Test.createTestingModule({
      providers: [
        ExtractionChain,
        {
          provide: GeminiChatFactory,
          useValue: {
            defaultModel: 'm',
            create: () => ({ withStructuredOutput: structured }),
          },
        },
        { provide: ChainRunner, useValue: runner },
        {
          provide: PromptRegistry,
          useValue: {
            systemPrompt: jest.fn().mockResolvedValue({ prompt: 'P', version: 'v' }),
          },
        },
      ],
    }).compile();

    await expect(
      module.get(ExtractionChain).extract([req('a')]),
    ).rejects.toThrow('boom');
  });
});
