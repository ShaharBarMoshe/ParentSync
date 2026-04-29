import { Test, TestingModule } from '@nestjs/testing';
import { MessagesController } from './messages.controller';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../interfaces/message-repository.interface';
import { MessageEntity } from '../entities/message.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';

describe('MessagesController', () => {
  let controller: MessagesController;
  let messageRepository: jest.Mocked<IMessageRepository>;

  const mockMessage: MessageEntity = {
    id: 'msg-uuid-1',
    source: MessageSource.WHATSAPP,
    channel: 'parents-group',
    childId: 'child-uuid-1',
    content: 'School trip next Monday',
    sender: 'Teacher',
    timestamp: new Date(),
    parsed: false,
    createdAt: new Date(),
  } as MessageEntity;

  const mockMessage2: MessageEntity = {
    id: 'msg-uuid-2',
    source: MessageSource.EMAIL,
    channel: 'inbox',
    childId: 'child-uuid-1',
    content: 'Parent meeting on Friday',
    sender: 'Principal',
    timestamp: new Date(),
    parsed: true,
    createdAt: new Date(),
  } as MessageEntity;

  beforeEach(async () => {
    const mockRepo: jest.Mocked<IMessageRepository> = {
      findAll: jest.fn(),
      findById: jest.fn(),
      findBySource: jest.fn(),
      findUnparsed: jest.fn(),
      getLastTimestamp: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      pruneOldest: jest.fn(),
      existsByChannelTimestampContent: jest.fn(),
      resetAllParsed: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [
        { provide: MESSAGE_REPOSITORY, useValue: mockRepo },
      ],
    }).compile();

    controller = module.get<MessagesController>(MessagesController);
    messageRepository = module.get(MESSAGE_REPOSITORY);
  });

  describe('getMessages', () => {
    it('should return all messages with default pagination', async () => {
      messageRepository.findAll.mockResolvedValue([mockMessage, mockMessage2]);

      const result = await controller.getMessages(
        { offset: 0, limit: 50 } as any,
      );

      expect(messageRepository.findAll).toHaveBeenCalled();
      expect(result).toEqual([mockMessage, mockMessage2]);
    });

    it('should filter by source when provided', async () => {
      messageRepository.findBySource.mockResolvedValue([mockMessage]);

      const result = await controller.getMessages(
        { source: MessageSource.WHATSAPP, offset: 0, limit: 50 } as any,
      );

      expect(messageRepository.findBySource).toHaveBeenCalledWith(
        MessageSource.WHATSAPP,
      );
      expect(result).toEqual([mockMessage]);
    });

    it('should filter unparsed messages when unparsed=true', async () => {
      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);

      const result = await controller.getMessages(
        { unparsed: true, offset: 0, limit: 50 } as any,
      );

      expect(messageRepository.findUnparsed).toHaveBeenCalled();
      expect(result).toEqual([mockMessage]);
    });

    it('should prioritize unparsed filter over source filter', async () => {
      messageRepository.findUnparsed.mockResolvedValue([mockMessage]);

      const result = await controller.getMessages(
        { unparsed: true, source: MessageSource.WHATSAPP, offset: 0, limit: 50 } as any,
      );

      expect(messageRepository.findUnparsed).toHaveBeenCalled();
      expect(messageRepository.findBySource).not.toHaveBeenCalled();
    });

    it('should apply pagination offset and limit', async () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        ...mockMessage,
        id: `msg-${i}`,
      }));
      messageRepository.findAll.mockResolvedValue(messages);

      const result = await controller.getMessages(
        { offset: 2, limit: 3 } as any,
      );

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('msg-2');
      expect(result[2].id).toBe('msg-4');
    });

    it('should use default pagination when not provided', async () => {
      const messages = Array.from({ length: 60 }, (_, i) => ({
        ...mockMessage,
        id: `msg-${i}`,
      }));
      messageRepository.findAll.mockResolvedValue(messages);

      const result = await controller.getMessages(
        {} as any,
      );

      // Default limit is 50, offset is 0
      expect(result).toHaveLength(50);
    });
  });

  describe('getMessage', () => {
    it('should return a message by id', async () => {
      messageRepository.findById.mockResolvedValue(mockMessage);

      const result = await controller.getMessage('msg-uuid-1');

      expect(messageRepository.findById).toHaveBeenCalledWith('msg-uuid-1');
      expect(result).toEqual(mockMessage);
    });

    it('should return null when message not found', async () => {
      messageRepository.findById.mockResolvedValue(null);

      const result = await controller.getMessage('nonexistent-id');

      expect(result).toBeNull();
    });
  });
});
