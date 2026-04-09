import { createEvent, type EventAttributes } from 'ics';
import { CalendarEventEntity } from '../entities/calendar-event.entity';

export function generateICS(event: CalendarEventEntity): string {
  const [year, month, day] = event.date.split('-').map(Number);
  const start: [number, number, number, number, number] = [
    year,
    month,
    day,
    0,
    0,
  ];

  if (event.time) {
    const [hour, minute] = event.time.split(':').map(Number);
    start[3] = hour;
    start[4] = minute;
  }

  const attrs: EventAttributes = {
    title: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start,
    duration: { hours: 1 },
    uid: event.id,
  };

  const { error, value } = createEvent(attrs);
  if (error) {
    throw new Error(`ICS generation failed: ${error.message}`);
  }
  return value!;
}
