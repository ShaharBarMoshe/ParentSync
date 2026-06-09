import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { IEmbeddingService } from '../interfaces/embedding-service.interface';

const VECTOR_DIM = 768;

/**
 * Deterministic mock embedding service for tests.
 *
 * Same text → same vector; different text → near-orthogonal vector.
 * Tests can force a high-similarity case via `setOverride`.
 */
@Injectable()
export class MockEmbeddingService implements IEmbeddingService {
  private readonly overrides = new Map<string, number[]>();

  setOverride(text: string, vector: number[]): void {
    this.overrides.set(text, vector);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  async embedText(text: string): Promise<number[]> {
    const override = this.overrides.get(text);
    if (override) return override;
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }

  /**
   * Build a unit vector seeded by SHA-256(text) using a simple xorshift32 PRNG.
   * Same input → same output. Distinct inputs → effectively orthogonal vectors
   * (cosine ≈ 0).
   */
  private deterministicVector(text: string): number[] {
    const seedBytes = createHash('sha256').update(text).digest();
    let state =
      (seedBytes.readUInt32BE(0) ^
        seedBytes.readUInt32BE(4) ^
        seedBytes.readUInt32BE(8) ^
        seedBytes.readUInt32BE(12)) >>>
      0;
    if (state === 0) state = 1;

    const out = new Array<number>(VECTOR_DIM);
    let mag = 0;
    for (let i = 0; i < VECTOR_DIM; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const v = (state / 0xffffffff) * 2 - 1;
      out[i] = v;
      mag += v * v;
    }
    const norm = Math.sqrt(mag) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) out[i] /= norm;
    return out;
  }
}
