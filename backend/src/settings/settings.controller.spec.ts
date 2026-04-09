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
    it('should return all settings with sensitive values masked', async () => {
      service.findAll.mockResolvedValue([
        mockSetting,
        mockSensitiveSetting,
        mockSecretSetting,
      ]);

      const result = await controller.findAll();

      expect(result).toHaveLength(3);
      // Non-sensitive: returned as-is
      expect(result[0].value).toBe('daily');
      // Sensitive: masked
      expect(result[1].value).not.toBe('sk-1234567890abcdef');
      expect(result[1].value).toContain('••••');
      expect(result[2].value).not.toBe('GOCSPX-abcdefgh1234');
      expect(result[2].value).toContain('••••');
    });

    it('should mask short sensitive values completely', async () => {
      const shortSecret: UserSettingEntity = {
        id: '4',
        key: 'openrouter_api_key',
        value: 'short',
        updatedAt: new Date(),
      };
      service.findAll.mockResolvedValue([shortSecret]);

      const result = await controller.findAll();
      expect(result[0].value).toBe('••••••••');
    });

    it('should return empty array when no settings exist', async () => {
      service.findAll.mockResolvedValue([]);
      const result = await controller.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('getSensitiveStatus', () => {
    it('should return boolean status for each sensitive key', async () => {
      service.findAll.mockResolvedValue([mockSensitiveSetting]);

      const result = await controller.getSensitiveStatus();

      expect(result).toEqual({
        openrouter_api_key: true,
        google_client_secret: false,
      });
    });

    it('should return false for empty or whitespace-only values', async () => {
      const emptySetting: UserSettingEntity = {
        id: '5',
        key: 'openrouter_api_key',
        value: '   ',
        updatedAt: new Date(),
      };
      service.findAll.mockResolvedValue([emptySetting]);

      const result = await controller.getSensitiveStatus();

      expect(result.openrouter_api_key).toBe(false);
      expect(result.google_client_secret).toBe(false);
    });

    it('should return all false when no settings exist', async () => {
      service.findAll.mockResolvedValue([]);

      const result = await controller.getSensitiveStatus();

      expect(result.openrouter_api_key).toBe(false);
      expect(result.google_client_secret).toBe(false);
    });
  });

  describe('findByKey', () => {
    it('should return non-sensitive setting as-is', async () => {
      service.findByKey.mockResolvedValue(mockSetting);

      const result = await controller.findByKey('check_schedule');

      expect(result.value).toBe('daily');
    });

    it('should mask sensitive setting value', async () => {
      service.findByKey.mockResolvedValue(mockSensitiveSetting);

      const result = await controller.findByKey('openrouter_api_key');

      expect(result.value).not.toBe('sk-1234567890abcdef');
      expect(result.value).toContain('••••');
    });

    it('should preserve other fields when masking', async () => {
      service.findByKey.mockResolvedValue(mockSensitiveSetting);

      const result = await controller.findByKey('openrouter_api_key');

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
