import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TypeOrmMessageRepository } from './typeorm-message.repository';
import { MessageEntity } from '../entities/message.entity';
import { MessageSource } from '../../shared/enums/message-source.enum';

describe('TypeOrmMessageRepository', () => {
  let repository: TypeOrmMessageRepository;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [MessageEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([MessageEntity]),
      ],
      providers: [TypeOrmMessageRepository],
    }).compile();

    repository = module.get<TypeOrmMessageRepository>(
      TypeOrmMessageRepository,
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('should create and find a message', async () => {
    const message = await repository.create({
      source: MessageSource.WHATSAPP,
      content: 'Test message',
      timestamp: new Date(),
      channel: 'test-channel',
      sender: 'test-sender',
    });

    expect(message.id).toBeDefined();
    expect(message.content).toBe('Test message');

    const found = await repository.findById(message.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe('Test message');
  });

  it('should find unparsed messages', async () => {
    await repository.create({
      source: MessageSource.EMAIL,
      content: 'Unparsed',
      timestamp: new Date(),
      channel: 'inbox',
      parsed: false,
    });
    await repository.create({
      source: MessageSource.EMAIL,
      content: 'Parsed',
      timestamp: new Date(),
      channel: 'inbox',
      parsed: true,
    });

    const unparsed = await repository.findUnparsed();
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0].content).toBe('Unparsed');
  });

  it('should update a message', async () => {
    const message = await repository.create({
      source: MessageSource.WHATSAPP,
      content: 'Original',
      timestamp: new Date(),
      channel: 'ch',
    });

    const updated = await repository.update(message.id, { parsed: true });
    expect(updated.parsed).toBe(true);
  });

  it('should delete a message', async () => {
    const message = await repository.create({
      source: MessageSource.WHATSAPP,
      content: 'To delete',
      timestamp: new Date(),
      channel: 'ch',
    });

    await repository.delete(message.id);
    const found = await repository.findById(message.id);
    expect(found).toBeNull();
  });
});
