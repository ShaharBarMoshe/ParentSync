import { execSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Compilation smoke tests — verify that both backend and frontend
 * TypeScript code compiles without errors. These catch type errors,
 * missing imports, and interface mismatches that unit tests may miss.
 */
describe('Compilation (e2e)', () => {
  it('backend TypeScript compiles without errors (production code)', () => {
    expect(() => {
      execSync('npx tsc --noEmit -p tsconfig.build.json', {
        cwd: path.join(ROOT, 'backend'),
        stdio: 'pipe',
        timeout: 60000,
      });
    }).not.toThrow();
  }, 60000);

  it('backend NestJS build succeeds', () => {
    expect(() => {
      execSync('npx nest build', {
        cwd: path.join(ROOT, 'backend'),
        stdio: 'pipe',
        timeout: 60000,
      });
    }).not.toThrow();
  }, 60000);

  it('frontend TypeScript compiles without errors', () => {
    expect(() => {
      execSync('npx tsc --noEmit', {
        cwd: path.join(ROOT, 'frontend'),
        stdio: 'pipe',
        timeout: 60000,
      });
    }).not.toThrow();
  }, 60000);

  it('frontend Vite build succeeds', () => {
    expect(() => {
      execSync('npx vite build', {
        cwd: path.join(ROOT, 'frontend'),
        stdio: 'pipe',
        timeout: 120000,
      });
    }).not.toThrow();
  }, 120000);
});
