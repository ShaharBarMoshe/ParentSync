import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCalendarEventDto } from './create-calendar-event.dto';

describe('CreateCalendarEventDto', () => {
  function createDto(data: Partial<CreateCalendarEventDto>) {
    return plainToInstance(CreateCalendarEventDto, data);
  }

  it('should pass with valid data', async () => {
    const dto = createDto({
      title: 'School Meeting',
      date: '2026-03-20',
      time: '10:00',
      location: 'School Hall',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should pass with minimal data (title + date)', async () => {
    const dto = createDto({ title: 'Event', date: '2026-03-20' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should fail without title', async () => {
    const dto = createDto({ date: '2026-03-20' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('should fail without date', async () => {
    const dto = createDto({ title: 'Event' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'date')).toBe(true);
  });

  it('should fail with invalid date format', async () => {
    const dto = createDto({ title: 'Event', date: 'not-a-date' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'date')).toBe(true);
  });

  it('should fail with invalid time format', async () => {
    const dto = createDto({
      title: 'Event',
      date: '2026-03-20',
      time: '3pm',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'time')).toBe(true);
  });

  it('should pass with valid time format', async () => {
    const dto = createDto({
      title: 'Event',
      date: '2026-03-20',
      time: '15:00',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
