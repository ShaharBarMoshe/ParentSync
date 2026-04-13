import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SETTINGS_REPOSITORY } from '../shared/constants/injection-tokens';
import type { ISettingsRepository } from './interfaces/settings-repository.interface';
import { CreateSettingDto } from './dto/create-setting.dto';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { UserSettingEntity } from './entities/user-setting.entity';
import { CryptoService } from '../shared/crypto/crypto.service';
import { SENSITIVE_SETTING_KEYS } from './constants/setting-keys';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(SETTINGS_REPOSITORY)
    private readonly settingsRepository: ISettingsRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly cryptoService: CryptoService,
  ) {}

  private isSensitive(key: string): boolean {
    return SENSITIVE_SETTING_KEYS.has(key);
  }

  private decryptEntity(entity: UserSettingEntity): UserSettingEntity {
    if (this.isSensitive(entity.key)) {
      entity.value = this.cryptoService.decrypt(entity.value);
    }
    return entity;
  }

  private maskEntity(entity: UserSettingEntity): UserSettingEntity {
    if (this.isSensitive(entity.key) && entity.value) {
      const decrypted = this.cryptoService.decrypt(entity.value);
      if (decrypted.length <= 8) {
        entity.value = '••••••••';
      } else {
        entity.value = decrypted.slice(0, 4) + '••••' + decrypted.slice(-4);
      }
    }
    return entity;
  }

  async findAll(): Promise<UserSettingEntity[]> {
    const settings = await this.settingsRepository.findAll();
    return settings.map((s) => this.maskEntity(s));
  }

  async findByKey(key: string): Promise<UserSettingEntity> {
    const setting = await this.settingsRepository.findByKey(key);
    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }
    if (this.isSensitive(key)) {
      return this.maskEntity(setting);
    }
    return setting;
  }

  /** Internal use only — returns decrypted value for sensitive keys (not exposed via API). */
  async findByKeyDecrypted(key: string): Promise<UserSettingEntity> {
    const setting = await this.settingsRepository.findByKey(key);
    if (!setting) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }
    return this.decryptEntity(setting);
  }

  async create(dto: CreateSettingDto): Promise<UserSettingEntity> {
    // Skip saving masked placeholder values for sensitive keys
    if (this.isSensitive(dto.key) && dto.value.includes('••••')) {
      const existing = await this.settingsRepository.findByKey(dto.key);
      if (existing) {
        return this.maskEntity(existing);
      }
    }
    const storedValue = this.isSensitive(dto.key)
      ? this.cryptoService.encrypt(dto.value)
      : dto.value;
    const result = await this.settingsRepository.upsert(dto.key, storedValue);
    this.eventEmitter.emit('settings.changed', { key: dto.key, value: dto.value });
    result.value = dto.value;
    return result;
  }

  async update(key: string, dto: UpdateSettingDto): Promise<UserSettingEntity> {
    const existing = await this.settingsRepository.findByKey(key);
    if (!existing) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }
    // Skip saving masked placeholder values for sensitive keys
    if (this.isSensitive(key) && dto.value.includes('••••')) {
      return this.maskEntity(existing);
    }
    const storedValue = this.isSensitive(key)
      ? this.cryptoService.encrypt(dto.value)
      : dto.value;
    const result = await this.settingsRepository.upsert(key, storedValue);
    this.eventEmitter.emit('settings.changed', { key, value: dto.value });
    result.value = dto.value;
    return result;
  }

  async delete(key: string): Promise<void> {
    const existing = await this.settingsRepository.findByKey(key);
    if (!existing) {
      throw new NotFoundException(`Setting with key "${key}" not found`);
    }
    return this.settingsRepository.delete(key);
  }
}
