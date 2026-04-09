import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ChildService } from './child.service';
import { CHILD_REPOSITORY } from '../shared/constants/injection-tokens';
import { IChildRepository } from './interfaces/child-repository.interface';
import { ChildEntity } from './entities/child.entity';

describe('ChildService', () => {
  let service: ChildService;
  let repository: jest.Mocked<IChildRepository>;

  const mockChild: ChildEntity = {
    id: 'child-1',
    name: 'Alice',
    channelNames: 'Parents Group,Class Updates',
    teacherEmails: 'teacher@school.com',
    calendarColor: '1',
    lastScanAt: new Date('2026-03-21T10:00:00Z'),
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockChild2: ChildEntity = {
    id: 'child-2',
    name: 'Bob',
    channelNames: 'Sports Team',
    teacherEmails: 'coach@school.com',
    calendarColor: '2',
    lastScanAt: null as unknown as Date,
    order: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockRepository: jest.Mocked<IChildRepository> = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getNextOrder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChildService,
        { provide: CHILD_REPOSITORY, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<ChildService>(ChildService);
    repository = module.get(CHILD_REPOSITORY);
  });

  describe('findAll', () => {
    it('should return all children', async () => {
      repository.findAll.mockResolvedValue([mockChild, mockChild2]);

      const result = await service.findAll();

      expect(result).toEqual([mockChild, mockChild2]);
      expect(repository.findAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('findById', () => {
    it('should return child when found', async () => {
      repository.findById.mockResolvedValue(mockChild);

      const result = await service.findById('child-1');

      expect(result).toEqual(mockChild);
      expect(repository.findById).toHaveBeenCalledWith('child-1');
    });

    it('should throw NotFoundException when not found', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('should set auto-order and create child', async () => {
      repository.getNextOrder.mockResolvedValue(3);
      repository.create.mockResolvedValue({ ...mockChild, order: 3 });

      const dto = { name: 'Alice', channelNames: 'Parents Group,Class Updates' };
      const result = await service.create(dto as any);

      expect(repository.getNextOrder).toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalledWith({ ...dto, order: 3 });
      expect(result.order).toBe(3);
    });
  });

  describe('update', () => {
    it('should update existing child', async () => {
      const updated = { ...mockChild, name: 'Alice Updated' };
      repository.findById.mockResolvedValue(mockChild);
      repository.update.mockResolvedValue(updated);

      const result = await service.update('child-1', { name: 'Alice Updated' } as any);

      expect(result.name).toBe('Alice Updated');
      expect(repository.update).toHaveBeenCalledWith('child-1', {
        name: 'Alice Updated',
      });
    });

    it('should throw NotFoundException when not found', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update('nonexistent', { name: 'Test' } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete child', async () => {
      repository.findById.mockResolvedValue(mockChild);
      repository.delete.mockResolvedValue();

      await service.delete('child-1');

      expect(repository.delete).toHaveBeenCalledWith('child-1');
    });

    it('should throw NotFoundException when not found', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reorder', () => {
    it('should update order for each child', async () => {
      const reordered = [
        { ...mockChild2, order: 0 },
        { ...mockChild, order: 1 },
      ];
      repository.update.mockResolvedValue({} as any);
      repository.findAll.mockResolvedValue(reordered);

      const result = await service.reorder(['child-2', 'child-1']);

      expect(repository.update).toHaveBeenCalledWith('child-2', { order: 0 });
      expect(repository.update).toHaveBeenCalledWith('child-1', { order: 1 });
      expect(repository.update).toHaveBeenCalledTimes(2);
      expect(result).toEqual(reordered);
    });
  });
});
