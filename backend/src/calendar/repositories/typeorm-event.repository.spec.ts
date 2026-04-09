import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TypeOrmEventRepository } from './typeorm-event.repository';
import { CalendarEventEntity } from '../entities/calendar-event.entity';

describe('TypeOrmEventRepository', () => {
  let repository: TypeOrmEventRepository;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [CalendarEventEntity],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([CalendarEventEntity]),
      ],
      providers: [TypeOrmEventRepository],
    }).compile();

    repository = module.get<TypeOrmEventRepository>(TypeOrmEventRepository);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should create and find an event', async () => {
    const event = await repository.create({
      title: 'School Meeting',
      date: '2026-03-20',
      time: '10:00',
      location: 'School Hall',
    });

    expect(event.id).toBeDefined();
    expect(event.title).toBe('School Meeting');

    const found = await repository.findById(event.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('School Meeting');
  });

  it('should find unsynced events', async () => {
    await repository.create({
      title: 'Unsynced',
      date: '2026-03-20',
      syncedToGoogle: false,
    });
    await repository.create({
      title: 'Synced',
      date: '2026-03-21',
      syncedToGoogle: true,
    });

    const unsynced = await repository.findUnsynced();
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0].title).toBe('Unsynced');
  });

  it('should update an event', async () => {
    const event = await repository.create({
      title: 'Original',
      date: '2026-03-20',
    });

    const updated = await repository.update(event.id, {
      syncedToGoogle: true,
      googleEventId: 'abc123',
    });
    expect(updated.syncedToGoogle).toBe(true);
    expect(updated.googleEventId).toBe('abc123');
  });

  it('should delete an event', async () => {
    const event = await repository.create({
      title: 'To delete',
      date: '2026-03-20',
    });

    await repository.delete(event.id);
    const found = await repository.findById(event.id);
    expect(found).toBeNull();
  });
});
