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

  const baseAttrs = {
    title: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start,
    uid: event.id,
  };

  let attrs: EventAttributes;
  if (event.time && event.endTime) {
    const [endHour, endMinute] = event.endTime.split(':').map(Number);
    attrs = {
      ...baseAttrs,
      end: [year, month, day, endHour, endMinute],
    };
  } else {
    attrs = { ...baseAttrs, duration: { hours: 1 } };
  }

  const { error, value } = createEvent(attrs);
  if (error) {
    throw new Error(`ICS generation failed: ${error.message}`);
  }
  return value!;
}
