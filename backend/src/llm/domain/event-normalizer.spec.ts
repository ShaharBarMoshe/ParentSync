import {
  validateEvents,
  collapseSingleGathering,
  normalizeEndTime,
  normalizeEvents,
} from './event-normalizer';
import { daysFromNow } from '../../../test/helpers/relative-dates';

describe('event-normalizer', () => {
  const date = daysFromNow(7);

  describe('validateEvents', () => {
    it('keeps a well-formed create event and trims its strings', () => {
      const [event] = validateEvents([
        {
          title: '  Purim party  ',
          date,
          time: '09:30',
          location: '  Room 3 ',
          description: ' bring a costume ',
        },
      ]);

      expect(event).toMatchObject({
        title: 'Purim party',
        date,
        time: '09:30',
        location: 'Room 3',
        description: 'bring a costume',
      });
    });

    it('drops an event with no usable title', () => {
      expect(validateEvents([{ title: '   ', date }])).toEqual([]);
      expect(validateEvents([{ date }])).toEqual([]);
    });

    it('drops a create event whose date is not ISO', () => {
      expect(validateEvents([{ title: 'Trip', date: 'next tuesday' }])).toEqual(
        [],
      );
      expect(validateEvents([{ title: 'Trip', date: '' }])).toEqual([]);
    });

    it('allows an empty date on cancel/delay, where the original date may be unstated', () => {
      const events = validateEvents([
        { title: 'Trip', date: '', action: 'cancel' },
        { title: 'Trip', date: '', action: 'delay', newDate: date },
      ]);
      expect(events).toHaveLength(2);
      expect(events[0].action).toBe('cancel');
      expect(events[1].newDate).toBe(date);
    });

    it('rejects an unknown action rather than guessing', () => {
      expect(
        validateEvents([{ title: 'Trip', date, action: 'reschedule' }]),
      ).toEqual([]);
    });

    it('rejects malformed time, newDate and newTime', () => {
      expect(validateEvents([{ title: 'A', date, time: '9:30' }])).toEqual([]);
      expect(
        validateEvents([
          { title: 'A', date, action: 'delay', newDate: '03-05-2026' },
        ]),
      ).toEqual([]);
      expect(
        validateEvents([{ title: 'A', date, action: 'delay', newTime: 'noon' }]),
      ).toEqual([]);
    });

    it('treats null the same as absent, so a nullable schema field is safe', () => {
      const [event] = validateEvents([
        {
          title: 'A',
          date,
          time: null,
          endTime: null,
          location: null,
          description: null,
          action: null,
        },
      ]);
      expect(event).toMatchObject({ title: 'A', date });
      expect(event.time).toBeUndefined();
      expect(event.action).toBeUndefined();
    });

    it('ignores non-object entries', () => {
      expect(validateEvents(['nope', null, 42, undefined])).toEqual([]);
    });

    it('normalizes action: create becomes undefined, cancel/delay are kept', () => {
      const events = validateEvents([
        { title: 'A', date, action: 'create' },
        { title: 'B', date, action: 'cancel' },
      ]);
      expect(events[0].action).toBeUndefined();
      expect(events[1].action).toBe('cancel');
    });
  });

  describe('normalizeEndTime', () => {
    it('keeps an end time strictly after the start', () => {
      expect(normalizeEndTime('11:00', '10:00')).toBe('11:00');
    });

    it('drops one that is malformed, missing a start, or not after it', () => {
      expect(normalizeEndTime('11am', '10:00')).toBeUndefined();
      expect(normalizeEndTime('11:00', undefined)).toBeUndefined();
      expect(normalizeEndTime('10:00', '10:00')).toBeUndefined();
      expect(normalizeEndTime('09:00', '10:00')).toBeUndefined();
    });

    it('drops a bad end time without taking the event with it', () => {
      const [event] = validateEvents([
        { title: 'A', date, time: '10:00', endTime: '09:00' },
      ]);
      expect(event.title).toBe('A');
      expect(event.endTime).toBeUndefined();
    });
  });

  describe('collapseSingleGathering', () => {
    it('collapses one gathering described twice, keeping the most specific', () => {
      const collapsed = collapseSingleGathering([
        { title: 'Party', date, time: '17:00' },
        { title: 'Party', date, time: '17:30', endTime: '18:00' },
      ]);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]).toMatchObject({ time: '17:30', endTime: '18:00' });
    });

    it('matches case- and whitespace-insensitively on the grouping fields', () => {
      const collapsed = collapseSingleGathering([
        { title: 'party', date, location: 'Gym' },
        { title: '  PARTY ', date, location: ' gym ', time: '17:00' },
      ]);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0].time).toBe('17:00');
    });

    it('keeps genuinely different events apart', () => {
      const collapsed = collapseSingleGathering([
        { title: 'Party', date, location: 'Gym' },
        { title: 'Trip', date, location: 'Gym' },
      ]);
      expect(collapsed).toHaveLength(2);
    });

    it('never merges cancel/delay events, even when they look alike', () => {
      const collapsed = collapseSingleGathering([
        { title: 'Trip', date, action: 'cancel' },
        { title: 'Trip', date, action: 'cancel' },
      ]);
      expect(collapsed).toHaveLength(2);
    });

    it('passes through zero and one event untouched', () => {
      expect(collapseSingleGathering([])).toEqual([]);
      const one = [{ title: 'A', date }];
      expect(collapseSingleGathering(one)).toEqual(one);
    });
  });

  describe('normalizeEvents', () => {
    it('validates then collapses in one pass', () => {
      const events = normalizeEvents([
        { title: 'Party', date, time: '17:00' },
        { title: 'Party', date, time: '17:30', endTime: '18:00' },
        { title: 'Broken', date: 'someday' },
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ time: '17:30', endTime: '18:00' });
    });
  });
});
