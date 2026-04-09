import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChildEntity } from '../entities/child.entity';
import { IChildRepository } from '../interfaces/child-repository.interface';

@Injectable()
export class TypeOrmChildRepository implements IChildRepository {
  constructor(
    @InjectRepository(ChildEntity)
    private readonly repo: Repository<ChildEntity>,
  ) {}

  findAll(): Promise<ChildEntity[]> {
    return this.repo.find({ order: { order: 'ASC' } });
  }

  findById(id: string): Promise<ChildEntity | null> {
    return this.repo.findOneBy({ id });
  }

  async create(child: Partial<ChildEntity>): Promise<ChildEntity> {
    const entity = this.repo.create(child);
    return this.repo.save(entity);
  }

  async update(id: string, child: Partial<ChildEntity>): Promise<ChildEntity> {
    await this.repo.update(id, child);
    return this.repo.findOneByOrFail({ id });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async getNextOrder(): Promise<number> {
    const result = await this.repo
      .createQueryBuilder('child')
      .select('MAX(child.order)', 'maxOrder')
      .getRawOne();
    return (result?.maxOrder ?? -1) + 1;
  }
}
