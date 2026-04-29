import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { UserSettingEntity } from './entities/user-setting.entity';

describe('SettingsController', () => {
  let controller: SettingsController;
  let service: jest.Mocked<SettingsService>;

  const mockSetting: UserSettingEntity = {
    id: '1',
    key: 'check_schedule',
    value: 'daily',
    updatedAt: new Date(),
  };

  const mockSensitiveSetting: UserSettingEntity = {
    id: '2',
    key: 'openrouter_api_key',
    value: 'sk-1234567890abcdef',
    updatedAt: new Date(),
  };

  const mockSecretSetting: UserSettingEntity = {
    id: '3',
    key: 'google_client_secret',
    value: 'GOCSPX-abcdefgh1234',
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockService = {
      findAll: jest.fn(),
      findByKey: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SettingsService, useValue: mockService },
        { provide: APP_GUARD, useValue: { canActivate: () => true } },
      ],
    }).compile();

    controller = module.get<SettingsController>(SettingsController);
    service = module.get(SettingsService);
  });

  describe('findAll', () => {
    it('should return all settings as-is (SENSITIVE_SETTING_KEYS is empty)', async () => {
      service.findAll.mockResolvedValue([
        mockSetting,
        mockSensitiveSetting,
        mockSecretSetting,
      ]);

      const result = await controller.findAll();

      expect(result).toHaveLength(3);
      expect(result[0].value).toBe('daily');
      expect(result[1].value).toBe('sk-1234567890abcdef');
      expect(result[2].value).toBe('GOCSPX-abcdefgh1234');
    });

    it('should return empty array when no settings exist', async () => {
      service.findAll.mockResolvedValue([]);
      const result = await controller.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('getSensitiveStatus', () => {
    it('should return empty object when SENSITIVE_SETTING_KEYS is empty', async () => {
      service.findAll.mockResolvedValue([mockSensitiveSetting]);

      const result = await controller.getSensitiveStatus();

      expect(result).toEqual({});
    });
  });

  describe('findByKey', () => {
    it('should return non-sensitive setting as-is', async () => {
      service.findByKey.mockResolvedValue(mockSetting);

      const result = await controller.findByKey('check_schedule');

      expect(result.value).toBe('daily');
    });

    it('should return value as-is when key is not in SENSITIVE_SETTING_KEYS', async () => {
      service.findByKey.mockResolvedValue(mockSensitiveSetting);

      const result = await controller.findByKey('openrouter_api_key');

      expect(result.value).toBe('sk-1234567890abcdef');
      expect(result.id).toBe('2');
      expect(result.key).toBe('openrouter_api_key');
    });
  });

  describe('create', () => {
    it('should create a setting', async () => {
      const dto = { key: 'check_schedule', value: 'weekly' };
      service.create.mockResolvedValue({ ...mockSetting, value: 'weekly' });

      const result = await controller.create(dto);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result.value).toBe('weekly');
    });
  });

  describe('update', () => {
    it('should update a setting by key', async () => {
      const dto = { value: 'new-value' };
      service.update.mockResolvedValue({ ...mockSetting, value: 'new-value' });

      const result = await controller.update('check_schedule', dto);

      expect(service.update).toHaveBeenCalledWith('check_schedule', dto);
      expect(result.value).toBe('new-value');
    });
  });

  describe('delete', () => {
    it('should delete a setting by key', async () => {
      service.delete.mockResolvedValue(undefined);

      await controller.delete('check_schedule');

      expect(service.delete).toHaveBeenCalledWith('check_schedule');
    });
  });
});
