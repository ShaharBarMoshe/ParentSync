import { UserSettingEntity } from '../entities/user-setting.entity';

export interface ISettingsRepository {
  findAll(): Promise<UserSettingEntity[]>;
  findByKey(key: string): Promise<UserSettingEntity | null>;
  upsert(key: string, value: string): Promise<UserSettingEntity>;
  delete(key: string): Promise<void>;
}
