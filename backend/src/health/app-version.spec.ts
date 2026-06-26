import { resolveAppVersion } from './app-version';

describe('resolveAppVersion', () => {
  const originalEnv = process.env.APP_VERSION;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = originalEnv;
    }
  });

  it('returns the env-injected version with source=env when APP_VERSION is set', () => {
    process.env.APP_VERSION = '9.9.9';

    const result = resolveAppVersion();

    expect(result).toEqual({ version: '9.9.9', source: 'env' });
  });

  it('trims whitespace from the env-injected value', () => {
    process.env.APP_VERSION = '  1.2.3  ';

    expect(resolveAppVersion().version).toBe('1.2.3');
  });

  it('falls back to walking up to the root package.json when APP_VERSION is unset', () => {
    delete process.env.APP_VERSION;

    const result = resolveAppVersion();

    // The repo's root package.json has name=parentsync and a semver version.
    expect(result.source).toBe('package');
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('treats an empty APP_VERSION as missing and falls back', () => {
    process.env.APP_VERSION = '';

    const result = resolveAppVersion();

    expect(result.source).not.toBe('env');
  });
});
