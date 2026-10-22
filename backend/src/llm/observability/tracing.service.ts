import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import type { KVMap } from 'langsmith/schemas';
import { SettingsService } from '../../settings/settings.service';
import {
  LANGSMITH_ENABLED_KEY,
  LANGSMITH_API_KEY,
  LANGSMITH_PROJECT_KEY,
  LANGSMITH_REDACT_KEY,
  LANGSMITH_SETTING_KEYS,
} from '../../settings/constants/setting-keys';

const DEFAULT_PROJECT = 'parentsync';

/**
 * Keys whose values are message content rather than pipeline structure. These
 * are what a redacted trace must not carry off the machine.
 */
const CONTENT_KEYS = new Set([
  'content',
  'text',
  'input',
  'output',
  'mergedContent',
  'sourceContent',
  'body',
  'message',
  'messages',
  'title',
  'description',
  'location',
]);

/**
 * Builds the LangSmith callbacks handed to every LangChain invocation.
 *
 * Tracing is opt-in and off by default. ParentSync reads children's school
 * messages, and LangSmith is a hosted service — enabling it uploads whatever
 * the pipeline saw to smith.langchain.com. So:
 *
 * - With `langsmith_enabled` unset or false, `callbacks()` returns undefined
 *   and no LangSmith `Client` is ever constructed. Nothing is sent anywhere.
 * - Activation is per-invocation, never via the `LANGSMITH_TRACING` env var.
 *   Env activation is process-wide and cannot be switched off without a
 *   restart, which is the wrong shape for a setting a user toggles in the UI.
 * - With `langsmith_redact` on (the default), message bodies are replaced by a
 *   short content hash and a length before upload. Run structure, node
 *   timings, token counts, model names and errors still upload — enough to
 *   debug a pipeline, without the text of a parent's message.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  /** Cached tracer; `null` means "resolved to disabled", undefined means "not yet resolved". */
  private tracer: LangChainTracer | null | undefined;

  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Callbacks for a LangChain/LangGraph invocation, or `undefined` when
   * tracing is off. Pass straight into `invoke(input, { callbacks })`.
   */
  async callbacks(): Promise<Callbacks | undefined> {
    const tracer = await this.resolveTracer();
    return tracer ? [tracer] : undefined;
  }

  /** True when traces are currently being uploaded. */
  async isEnabled(): Promise<boolean> {
    return (await this.resolveTracer()) !== null;
  }

  @OnEvent('settings.changed')
  handleSettingsChanged(payload: { key: string }): void {
    if ((LANGSMITH_SETTING_KEYS as readonly string[]).includes(payload.key)) {
      this.tracer = undefined;
      this.logger.log(`Tracing settings changed (${payload.key}) — tracer will be rebuilt`);
    }
  }

  private async resolveTracer(): Promise<LangChainTracer | null> {
    if (this.tracer !== undefined) return this.tracer;

    try {
      this.tracer = await this.buildTracer();
    } catch (error) {
      // Observability must never take the pipeline down with it.
      this.logger.error(
        `Could not initialise LangSmith tracing — continuing untraced: ${(error as Error).message}`,
      );
      this.tracer = null;
    }
    return this.tracer;
  }

  private async buildTracer(): Promise<LangChainTracer | null> {
    if (!(await this.readFlag(LANGSMITH_ENABLED_KEY, false))) {
      return null;
    }

    const apiKey = (await this.readValue(LANGSMITH_API_KEY))?.trim();
    if (!apiKey) {
      this.logger.warn(
        'LangSmith tracing is enabled but no API key is configured — staying untraced',
      );
      return null;
    }

    const redact = await this.readFlag(LANGSMITH_REDACT_KEY, true);
    const projectName =
      (await this.readValue(LANGSMITH_PROJECT_KEY))?.trim() || DEFAULT_PROJECT;

    const client = new Client({
      apiKey,
      ...(redact
        ? {
            hideInputs: (inputs: KVMap) => this.redactMap(inputs),
            hideOutputs: (outputs: KVMap) => this.redactMap(outputs),
          }
        : {}),
    });

    this.logger.log(
      `LangSmith tracing enabled (project="${projectName}", redaction=${redact ? 'on' : 'OFF — message content will be uploaded'})`,
    );

    return new LangChainTracer({ client, projectName });
  }

  /** LangSmith hands the hooks a map; keep the top level a map too. */
  redactMap(map: KVMap): KVMap {
    return this.redact(map) as KVMap;
  }

  /**
   * Replace message content with `sha256:<12 hex>/<length>` while preserving
   * the surrounding structure, so a trace still shows how many messages a node
   * saw and how large they were.
   *
   * Recurses through arrays and plain objects. Depth is bounded because a
   * cyclic or pathological payload must not hang the pipeline.
   */
  redact(value: unknown, depth = 0): unknown {
    if (depth > 8) return '[redacted:depth]';
    if (typeof value === 'string') return this.digest(value);
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = CONTENT_KEYS.has(key)
          ? this.redact(val, depth + 1)
          : this.passthroughOrRecurse(val, depth);
      }
      return out;
    }
    return value;
  }

  /**
   * Non-content fields keep their scalar values (counts, ids, timings, model
   * names) but nested structures are still walked, since a content key can sit
   * below a structural one.
   */
  private passthroughOrRecurse(value: unknown, depth: number): unknown {
    if (value && typeof value === 'object') return this.redact(value, depth + 1);
    return value;
  }

  private digest(text: string): string {
    if (text.length === 0) return '';
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
    return `sha256:${hash}/${text.length}`;
  }

  private async readValue(key: string): Promise<string | undefined> {
    try {
      return (await this.settingsService.findByKey(key)).value;
    } catch {
      return undefined;
    }
  }

  private async readFlag(key: string, fallback: boolean): Promise<boolean> {
    const raw = (await this.readValue(key))?.trim().toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true';
  }
}
