import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..');

/**
 * The ports only hold if something checks them.
 *
 * Clean Architecture here is not decoration: the domain must not know which
 * provider or framework answers "extract the events from this message". The
 * previous migration's whole problem was a port shaped like the transport
 * underneath it, and the cheapest way for that to come back is one convenient
 * `import { HumanMessage }` in a service.
 */
describe('architecture', () => {
  const files = walk(SRC).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  );

  it('finds the source tree (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  describe('@langchain stays behind the ports', () => {
    /** The only two places allowed to know LangChain exists. */
    const ALLOWED = [
      join('llm', 'adapters'),
      join('llm', 'observability'),
      join('sync', 'graph'),
    ];

    it('is imported only from the adapter and graph layers', () => {
      const offenders = files
        .filter((file) => /from\s+'@langchain/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(SRC, file))
        .filter((rel) => !ALLOWED.some((dir) => rel.startsWith(dir + sep)));

      expect(offenders).toEqual([]);
    });

    it('never reaches a domain service, controller or entity', () => {
      const offenders = files
        .filter((file) => {
          const rel = relative(SRC, file);
          return (
            (rel.includes(`${sep}services${sep}`) ||
              rel.includes(`${sep}controllers${sep}`) ||
              rel.includes(`${sep}entities${sep}`) ||
              rel.includes(`${sep}dto${sep}`)) &&
            !rel.startsWith(join('llm', 'adapters') + sep)
          );
        })
        .filter((file) => /from\s+'@langchain/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(SRC, file));

      expect(offenders).toEqual([]);
    });
  });

  /**
   * Gemini's structured-output mode accepts only a subset of OpenAPI schema.
   * Dynamic keys are not in it, so a `z.record()` in a provider-facing schema
   * fails at the provider — at runtime, on a real family's messages, not here.
   */
  it('uses no z.record() in provider-facing schemas', () => {
    const schemas = files.filter((f) =>
      relative(SRC, f).startsWith(join('llm', 'schemas') + sep),
    );
    expect(schemas.length).toBeGreaterThan(0);

    for (const file of schemas) {
      // Comments are stripped first — the schema file explains *why* z.record
      // is unusable here, and that explanation must not trip its own guard.
      expect(stripComments(readFileSync(file, 'utf8'))).not.toMatch(
        /z\s*\.\s*record\s*\(/,
      );
    }
  });

  /** Deleted in the LangChain rewrite; nothing should reintroduce it. */
  it('has no trace of the retired LLM_SERVICE transport port', () => {
    const offenders = files
      .filter((file) => /\bLLM_SERVICE\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});

/** Good enough for this guard: block comments and line comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
