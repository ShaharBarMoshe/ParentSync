import { Test, TestingModule } from '@nestjs/testing';
import { PromptRegistry } from './prompt-registry.service';
import { SettingsService } from '../../settings/settings.service';
import { DEFAULT_SYSTEM_PROMPT } from '../services/default-system-prompt';
import { DEFAULT_CLASSIFIER_PROMPT } from '../services/default-classifier-prompt';
import {
  LLM_SYSTEM_PROMPT_KEY,
  LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY,
  LLM_CLASSIFIER_PROMPT_KEY,
  LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY,
} from '../../settings/constants/setting-keys';

describe('PromptRegistry', () => {
  let registry: PromptRegistry;
  let settings: { findByKey: jest.Mock; create: jest.Mock };

  const stored = (values: Record<string, string>) => (key: string) =>
    key in values
      ? Promise.resolve({ value: values[key] })
      : Promise.reject(new Error(`Setting not found: ${key}`));

  beforeEach(async () => {
    settings = {
      findByKey: jest.fn().mockImplementation(stored({})),
      create: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptRegistry,
        { provide: SettingsService, useValue: settings },
      ],
    }).compile();

    registry = module.get(PromptRegistry);
  });

  describe('reading', () => {
    it('falls back to the shipped defaults when nothing is stored', async () => {
      await expect(registry.systemPrompt()).resolves.toMatchObject({
        prompt: DEFAULT_SYSTEM_PROMPT,
      });
      await expect(registry.classifierPrompt()).resolves.toMatchObject({
        prompt: DEFAULT_CLASSIFIER_PROMPT,
      });
    });

    it('prefers a stored override', async () => {
      settings.findByKey.mockImplementation(
        stored({
          [LLM_SYSTEM_PROMPT_KEY]: 'MY RULES',
          [LLM_CLASSIFIER_PROMPT_KEY]: 'MY GATE',
        }),
      );
      await expect(registry.systemPrompt()).resolves.toMatchObject({
        prompt: 'MY RULES',
      });
      await expect(registry.classifierPrompt()).resolves.toMatchObject({
        prompt: 'MY GATE',
      });
    });

    it('ignores a blank override rather than sending an empty prompt', async () => {
      settings.findByKey.mockImplementation(
        stored({ [LLM_SYSTEM_PROMPT_KEY]: '   ' }),
      );
      await expect(registry.systemPrompt()).resolves.toMatchObject({
        prompt: DEFAULT_SYSTEM_PROMPT,
      });
    });

    it('re-reads on every call, so an edit lands without a restart', async () => {
      await registry.systemPrompt();
      settings.findByKey.mockImplementation(
        stored({ [LLM_SYSTEM_PROMPT_KEY]: 'EDITED' }),
      );
      await expect(registry.systemPrompt()).resolves.toMatchObject({
        prompt: 'EDITED',
      });
    });
  });

  describe('versioning', () => {
    it('derives the version from the prompt text alone', () => {
      expect(PromptRegistry.versionOf('same')).toBe(
        PromptRegistry.versionOf('same'),
      );
      expect(PromptRegistry.versionOf('a')).not.toBe(
        PromptRegistry.versionOf('b'),
      );
      expect(PromptRegistry.versionOf('a')).toHaveLength(16);
    });

    it('changes when the prompt changes, so cached parses miss', async () => {
      const before = (await registry.systemPrompt()).version;
      settings.findByKey.mockImplementation(
        stored({ [LLM_SYSTEM_PROMPT_KEY]: 'EDITED' }),
      );
      expect((await registry.systemPrompt()).version).not.toBe(before);
    });
  });

  describe('boot-time seeding', () => {
    it('writes both shipped defaults when the user has not customized them', async () => {
      await registry.onModuleInit();
      expect(settings.create).toHaveBeenCalledWith({
        key: LLM_SYSTEM_PROMPT_KEY,
        value: DEFAULT_SYSTEM_PROMPT,
      });
      expect(settings.create).toHaveBeenCalledWith({
        key: LLM_CLASSIFIER_PROMPT_KEY,
        value: DEFAULT_CLASSIFIER_PROMPT,
      });
    });

    it('leaves a customized prompt alone', async () => {
      settings.findByKey.mockImplementation(
        stored({
          [LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY]: 'true',
          [LLM_CLASSIFIER_PROMPT_IS_CUSTOM_KEY]: 'true',
        }),
      );
      await registry.onModuleInit();
      expect(settings.create).not.toHaveBeenCalled();
    });

    it('re-seeds only the prompt that is not customized', async () => {
      settings.findByKey.mockImplementation(
        stored({ [LLM_SYSTEM_PROMPT_IS_CUSTOM_KEY]: 'true' }),
      );
      await registry.onModuleInit();
      expect(settings.create).toHaveBeenCalledTimes(1);
      expect(settings.create).toHaveBeenCalledWith({
        key: LLM_CLASSIFIER_PROMPT_KEY,
        value: DEFAULT_CLASSIFIER_PROMPT,
      });
    });
  });
});
