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

  describe('findByApprovalMessageId', () => {
    it('finds an event by its WhatsApp approval message key', async () => {
      const approvalMessageId =
        'true_120363407443598263@g.us_3EB0A87880D02F4D93C750_255524885028964@lid';
      const created = await repository.create({
        title: 'Basketball',
        date: '2026-09-07',
        approvalMessageId,
      });

      const found = await repository.findByApprovalMessageId(approvalMessageId);
      expect(found?.id).toBe(created.id);
    });

    /**
     * Regression: legacy rows stored "[object Object]" when a WhatsApp key
     * failed to serialize. More than one row can hold it, so a lookup with the
     * same sentinel returned an arbitrary event and swallowed the reaction.
     */
    it.each(['[object Object]', '', '   '])(
      'never matches a row with an unusable key (%p)',
      async (badId) => {
        await repository.create({
          title: 'Legacy A',
          date: '2026-09-04',
          approvalMessageId: badId,
        });
        await repository.create({
          title: 'Legacy B',
          date: '2026-09-05',
          approvalMessageId: badId,
        });

        expect(await repository.findByApprovalMessageId(badId)).toBeNull();
      },
    );
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
