import { Test, TestingModule } from '@nestjs/testing';
import { DuplicateJudgeChain } from './duplicate-judge.chain';
import { GeminiChatFactory } from './gemini-chat.factory';
import { ChainRunner } from './chain-runner.service';
import { daysFromNow } from '../../../test/helpers/relative-dates';

describe('DuplicateJudgeChain', () => {
  let judge: DuplicateJudgeChain;
  let run: jest.Mock;
  let runs: { input: any; opts: any }[];

  const date = daysFromNow(10);
  const a = { title: 'יום הולדת בבילון', date, time: '17:00' };
  const b = { title: 'מפגש בבילון', date, time: '17:00' };

  beforeEach(async () => {
    runs = [];
    run = jest.fn(async (_c: unknown, input: any, opts: any) => {
      runs.push({ input, opts });
      return { identical: true };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuplicateJudgeChain,
        {
          provide: GeminiChatFactory,
          useValue: {
            defaultModel: 'gemini-2.0-flash',
            create: () => ({ withStructuredOutput: () => ({}) }),
          },
        },
        { provide: ChainRunner, useValue: { run } },
      ],
    }).compile();

    judge = module.get(DuplicateJudgeChain);
  });

  it('reports a match as identical', async () => {
    await expect(judge.areIdentical(a, b)).resolves.toBe(true);
  });

  it('reports a non-match as different', async () => {
    run.mockResolvedValue({ identical: false });
    await expect(judge.areIdentical(a, b)).resolves.toBe(false);
  });

  it('puts both events in the prompt with their distinguishing fields', async () => {
    await judge.areIdentical(
      { ...a, location: 'Gym', description: 'bring a gift' },
      b,
    );
    const text = runs[0].input[1].content as string;
    expect(text).toContain('יום הולדת בבילון');
    expect(text).toContain('מפגש בבילון');
    expect(text).toContain('Location: Gym');
    expect(text).toContain('bring a gift');
  });

  it('renders missing fields readably rather than as undefined', async () => {
    await judge.areIdentical(a, b);
    const text = runs[0].input[1].content as string;
    expect(text).toContain('Location: none');
    expect(text).not.toContain('undefined');
  });

  it('renders an all-day event as such', async () => {
    await judge.areIdentical({ title: 'A', date }, { title: 'B', date });
    expect(runs[0].input[1].content).toContain('Time: all-day');
  });

  it('names the run so it is findable in a trace', async () => {
    await judge.areIdentical(a, b);
    expect(runs[0].opts.runName).toBe('judge-duplicate');
  });

  /**
   * The direction matters: a wrong `false` costs the user one dismissal, a
   * wrong `true` silently drops a real event.
   */
  it('treats a provider failure as "different"', async () => {
    run.mockRejectedValue(new Error('network down'));
    await expect(judge.areIdentical(a, b)).resolves.toBe(false);
  });

  it('treats a missing verdict field as "different"', async () => {
    run.mockResolvedValue({});
    await expect(judge.areIdentical(a, b)).resolves.toBe(false);
  });
});
