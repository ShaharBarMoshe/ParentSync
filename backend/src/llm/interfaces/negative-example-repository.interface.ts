import { NegativeExampleEntity } from '../entities/negative-example.entity';

export interface CreateNegativeExampleInput {
  messageContent: string;
  extractedTitle: string;
  extractedDate?: string | null;
  channel?: string | null;
}

export interface INegativeExampleRepository {
  /**
   * Idempotent: inserting the same `messageContent` twice returns the
   * existing row instead of creating a duplicate.
   */
  create(input: CreateNegativeExampleInput): Promise<NegativeExampleEntity>;

  findRecent(limit: number): Promise<NegativeExampleEntity[]>;
  findAll(): Promise<NegativeExampleEntity[]>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<void>;
  count(): Promise<number>;
}
