import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { PROVIDER_SCHEMAS } from './extraction.schema';

/**
 * Does every provider-facing schema survive the trip to Gemini?
 *
 * Gemini validates `generationConfig.responseSchema` against a protobuf
 * definition, not against general JSON Schema. Anything outside that subset is
 * rejected with a 400 *before the model runs* — so a schema that is perfectly
 * valid zod, and passes every mocked unit test, can still fail on every real
 * sync.
 *
 * That is not hypothetical: `.nullable()` shipped once and took the whole
 * extraction path down with
 * `Proto field is not repeating, cannot start list`, because it converts to
 * `type: ["string", "null"]`. Mocking `withStructuredOutput` in the chain
 * specs meant the conversion never happened in a test.
 *
 * This spec runs the same conversion LangChain does and walks the result, so
 * that class of failure is caught offline and for free.
 */
describe('provider schema compatibility', () => {
  const entries = Object.entries(PROVIDER_SCHEMAS);

  it('covers every schema that is sent to a provider', () => {
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  describe.each(entries)('%s', (_name, schema) => {
    const json = toJsonSchema(schema as never) as Record<string, unknown>;

    it('declares a scalar type on every node, never a list', () => {
      // `type: ["string", "null"]` — what `.nullable()` produces — is the
      // exact shape Gemini's proto rejects.
      expect(collect(json, (n) => Array.isArray(n.type))).toEqual([]);
    });

    it('uses no unions', () => {
      expect(
        collect(json, (n) => !!(n.anyOf || n.oneOf || n.allOf)),
      ).toEqual([]);
    });

    it('uses no dynamic keys', () => {
      // A record converts to an object whose `additionalProperties` is itself
      // a schema; Gemini cannot express keys it was not told about.
      expect(
        collect(
          json,
          (n) =>
            typeof n.additionalProperties === 'object' &&
            n.additionalProperties !== null,
        ),
      ).toEqual([]);
    });

    it('describes every property, so the prompt need not restate the format', () => {
      const undescribed = collect(
        json,
        (n, path) =>
          path.includes('properties') &&
          typeof n.type === 'string' &&
          n.type !== 'object' &&
          !n.description &&
          !n.enum,
      );
      expect(undescribed).toEqual([]);
    });
  });
});

/**
 * Walk every node of a JSON Schema, returning the paths where `predicate`
 * holds. Returning paths rather than a boolean makes a failure say *which*
 * field is wrong — the 400 from Gemini only gives a proto path.
 */
function collect(
  node: unknown,
  predicate: (node: Record<string, any>, path: string) => boolean,
  path = '$',
): string[] {
  if (!node || typeof node !== 'object') return [];

  const found: string[] = [];
  if (!Array.isArray(node)) {
    const record = node as Record<string, any>;
    if (predicate(record, path)) found.push(path);
  }

  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') {
      found.push(...collect(value, predicate, `${path}.${key}`));
    }
  }
  return found;
}
