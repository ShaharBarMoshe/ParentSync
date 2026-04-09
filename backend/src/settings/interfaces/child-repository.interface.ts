import { ChildEntity } from '../entities/child.entity';

export interface IChildRepository {
  findAll(): Promise<ChildEntity[]>;
  findById(id: string): Promise<ChildEntity | null>;
  create(child: Partial<ChildEntity>): Promise<ChildEntity>;
  update(id: string, child: Partial<ChildEntity>): Promise<ChildEntity>;
  delete(id: string): Promise<void>;
  getNextOrder(): Promise<number>;
}
