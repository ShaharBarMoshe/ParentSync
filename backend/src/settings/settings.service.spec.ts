import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SettingsService } from './settings.service';
import { SETTINGS_REPOSITORY } from '../shared/constants/injection-tokens';
import { ISettingsRepository } from './interfaces/settings-repository.interface';
import { UserSettingEntity } from './entities/user-setting.entity';
import { CryptoService } from '../shared/crypto/crypto.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let repository: jest.Mocked<ISettingsRepository>;

  const mockSetting: UserSettingEntity = {
    id: '1',
    key: 'whatsapp_channels',
    value: 'parents-group',
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockRepository: jest.Mocked<ISettingsRepository> = {
      findAll: jest.fn(),
      findByKey: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        {
          provide: SETTINGS_REPOSITORY,
          useValue: mockRepository,
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
        {
          provide: CryptoService,
          useValue: {
            encrypt: jest.fn((v: string) => `enc:${v}`),
            decrypt: jest.fn((v: string) => v.startsWith('enc:') ? v.slice(4) : v),
          },
        },
      ],
    }).compile();

    service = module.get<SettingsService>(SettingsService);
    repository = module.get(SETTINGS_REPOSITORY);
  });

  describe('findAll', () => {
    it('should return all settings', async () => {
      repository.findAll.mockResolvedValue([mockSetting]);
      const result = await service.findAll();
      expect(result).toEqual([mockSetting]);
    });
  });

  describe('findByKey', () => {
    it('should return a setting by key', async () => {
      repository.findByKey.mockResolvedValue(mockSetting);
      const result = await service.findByKey('whatsapp_channels');
      expect(result).toEqual(mockSetting);
    });

    it('should throw NotFoundException if key not found', async () => {
      repository.findByKey.mockResolvedValue(null);
      await expect(service.findByKey('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByKey — non-sensitive keys', () => {
    it('should return value as-is when key is not in SENSITIVE_SETTING_KEYS', async () => {
      const setting = {
        id: '2',
        key: 'openrouter_api_key',
        value: 'sk-or-v1-abcdef1234567890',
        updatedAt: new Date(),
      };
      repository.findByKey.mockResolvedValue(setting);
      const result = await service.findByKey('openrouter_api_key');
      expect(result.value).toBe('sk-or-v1-abcdef1234567890');
    });
  });

  describe('findByKeyDecrypted', () => {
    it('should return value as-is (alias for findByKey)', async () => {
      const setting = {
        id: '2',
        key: 'openrouter_api_key',
        value: 'sk-or-v1-secret',
        updatedAt: new Date(),
      };
      repository.findByKey.mockResolvedValue(setting);
      const result = await service.findByKeyDecrypted('openrouter_api_key');
      expect(result.value).toBe('sk-or-v1-secret');
    });
  });

  describe('create', () => {
    it('should create a setting', async () => {
      repository.upsert.mockResolvedValue(mockSetting);
      const result = await service.create({
        key: 'whatsapp_channels',
        value: 'parents-group',
      });
      expect(result).toEqual(mockSetting);
      expect(repository.upsert).toHaveBeenCalledWith(
        'whatsapp_channels',
        'parents-group',
      );
    });
  });

  describe('update', () => {
    it('should update an existing setting', async () => {
      const updated = { ...mockSetting, value: 'new-value' };
      repository.findByKey.mockResolvedValue(mockSetting);
      repository.upsert.mockResolvedValue(updated);
      const result = await service.update('whatsapp_channels', {
        value: 'new-value',
      });
      expect(result.value).toBe('new-value');
    });

    it('should throw NotFoundException if key not found', async () => {
      repository.findByKey.mockResolvedValue(null);
      await expect(
        service.update('nonexistent', { value: 'val' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a setting', async () => {
      repository.findByKey.mockResolvedValue(mockSetting);
      repository.delete.mockResolvedValue();
      await service.delete('whatsapp_channels');
      expect(repository.delete).toHaveBeenCalledWith('whatsapp_channels');
    });

    it('should throw NotFoundException if key not found', async () => {
      repository.findByKey.mockResolvedValue(null);
      await expect(service.delete('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
