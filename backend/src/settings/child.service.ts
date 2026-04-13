import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { CHILD_REPOSITORY } from '../shared/constants/injection-tokens';
import type { IChildRepository } from './interfaces/child-repository.interface';
import { CreateChildDto } from './dto/create-child.dto';
import { UpdateChildDto } from './dto/update-child.dto';
import { ChildEntity } from './entities/child.entity';

@Injectable()
export class ChildService {
  constructor(
    @Inject(CHILD_REPOSITORY)
    private readonly childRepository: IChildRepository,
  ) {}

  async findAll(): Promise<ChildEntity[]> {
    return this.childRepository.findAll();
  }

  async findById(id: string): Promise<ChildEntity> {
    const child = await this.childRepository.findById(id);
    if (!child) {
      throw new NotFoundException(`Child with id "${id}" not found`);
    }
    return child;
  }

  async create(dto: CreateChildDto): Promise<ChildEntity> {
    const order = await this.childRepository.getNextOrder();
    return this.childRepository.create({ ...dto, order });
  }

  async update(id: string, dto: UpdateChildDto): Promise<ChildEntity> {
    const existing = await this.childRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Child with id "${id}" not found`);
    }
    return this.childRepository.update(id, dto);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.childRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Child with id "${id}" not found`);
    }
    return this.childRepository.delete(id);
  }

  async resetAllLastScan(): Promise<number> {
    const children = await this.childRepository.findAll();
    for (const child of children) {
      await this.childRepository.update(child.id, { lastScanAt: null as any });
    }
    return children.length;
  }

  async reorder(ids: string[]): Promise<ChildEntity[]> {
    for (let i = 0; i < ids.length; i++) {
      await this.childRepository.update(ids[i], { order: i });
    }
    return this.childRepository.findAll();
  }
}
