import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ChildController } from './child.controller';
import { ChildService } from './child.service';
import { ChildEntity } from './entities/child.entity';

describe('ChildController', () => {
  let controller: ChildController;
  let service: jest.Mocked<ChildService>;

  const mockChild: ChildEntity = {
    id: 'uuid-1',
    name: 'Yoni',
    channelNames: 'parents-group',
    teacherEmails: 'teacher@school.com',
    calendarColor: '1',
    lastScanAt: null,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockChild2: ChildEntity = {
    id: 'uuid-2',
    name: 'Dana',
    channelNames: 'class-updates',
    teacherEmails: null,
    calendarColor: '3',
    lastScanAt: null,
    order: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockService = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      reorder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChildController],
      providers: [
        { provide: ChildService, useValue: mockService },
        { provide: APP_GUARD, useValue: { canActivate: () => true } },
      ],
    }).compile();

    controller = module.get<ChildController>(ChildController);
    service = module.get(ChildService);
  });

  describe('findAll', () => {
    it('should return all children', async () => {
      service.findAll.mockResolvedValue([mockChild, mockChild2]);

      const result = await controller.findAll();

      expect(result).toEqual([mockChild, mockChild2]);
      expect(service.findAll).toHaveBeenCalled();
    });

    it('should return empty array when no children exist', async () => {
      service.findAll.mockResolvedValue([]);

      const result = await controller.findAll();

      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create a child', async () => {
      const dto = { name: 'Yoni', channelNames: 'parents-group' };
      service.create.mockResolvedValue(mockChild);

      const result = await controller.create(dto);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockChild);
    });

    it('should create a child with minimal fields', async () => {
      const dto = { name: 'Yoni' };
      service.create.mockResolvedValue(mockChild);

      const result = await controller.create(dto);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockChild);
    });
  });

  describe('reorder', () => {
    it('should reorder children and return updated list', async () => {
      const reordered = [
        { ...mockChild2, order: 0 },
        { ...mockChild, order: 1 },
      ];
      service.reorder.mockResolvedValue(reordered);

      const result = await controller.reorder({ ids: ['uuid-2', 'uuid-1'] });

      expect(service.reorder).toHaveBeenCalledWith(['uuid-2', 'uuid-1']);
      expect(result).toEqual(reordered);
    });
  });

  describe('update', () => {
    it('should update a child by id', async () => {
      const dto = { name: 'Yoni Updated' };
      const updated = { ...mockChild, name: 'Yoni Updated' };
      service.update.mockResolvedValue(updated);

      const result = await controller.update('uuid-1', dto);

      expect(service.update).toHaveBeenCalledWith('uuid-1', dto);
      expect(result.name).toBe('Yoni Updated');
    });
  });

  describe('delete', () => {
    it('should delete a child by id', async () => {
      service.delete.mockResolvedValue(undefined);

      await controller.delete('uuid-1');

      expect(service.delete).toHaveBeenCalledWith('uuid-1');
    });
  });
});
