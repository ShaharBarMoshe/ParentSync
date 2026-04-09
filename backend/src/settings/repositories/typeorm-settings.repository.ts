import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSettingEntity } from '../entities/user-setting.entity';
import { ISettingsRepository } from '../interfaces/settings-repository.interface';

@Injectable()
export class TypeOrmSettingsRepository implements ISettingsRepository {
  constructor(
    @InjectRepository(UserSettingEntity)
    private readonly repo: Repository<UserSettingEntity>,
  ) {}

  findAll(): Promise<UserSettingEntity[]> {
    return this.repo.find();
  }

  findByKey(key: string): Promise<UserSettingEntity | null> {
    return this.repo.findOneBy({ key });
  }

  async upsert(key: string, value: string): Promise<UserSettingEntity> {
    let setting = await this.repo.findOneBy({ key });
    if (setting) {
      setting.value = value;
    } else {
      setting = this.repo.create({ key, value });
    }
    return this.repo.save(setting);
  }

  async delete(key: string): Promise<void> {
    await this.repo.delete({ key });
  }
}
