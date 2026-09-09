import { parseChannelNames, serializeChannelNames } from './channel-names';

describe('channel-names', () => {
  describe('parseChannelNames', () => {
    it('returns an empty list for empty input', () => {
      expect(parseChannelNames(null)).toEqual([]);
      expect(parseChannelNames(undefined)).toEqual([]);
      expect(parseChannelNames('')).toEqual([]);
    });

    it('splits legacy comma-separated values', () => {
      expect(parseChannelNames('Group A, Group B ,Group C')).toEqual([
        'Group A',
        'Group B',
        'Group C',
      ]);
    });

    it('splits newline-separated values', () => {
      expect(parseChannelNames('Group A\nGroup B\n Group C ')).toEqual([
        'Group A',
        'Group B',
        'Group C',
      ]);
    });

    it('keeps commas inside a name when newlines are the separator', () => {
      // The real group that the comma encoding used to split in two.
      expect(parseChannelNames("בנים שכבת ה', יזמה\nכיתה ה2 הורים")).toEqual([
        "בנים שכבת ה', יזמה",
        'כיתה ה2 הורים',
      ]);
    });

    it('drops empty entries and surrounding whitespace', () => {
      expect(parseChannelNames('A,,  ,B')).toEqual(['A', 'B']);
      expect(parseChannelNames('\n\nA\n\n B \n')).toEqual(['A', 'B']);
    });
  });

  describe('serializeChannelNames', () => {
    it('round-trips a name containing a comma', () => {
      const names = ["בנים שכבת ה', יזמה", 'Group B'];
      expect(parseChannelNames(serializeChannelNames(names))).toEqual(names);
    });

    it('drops blank entries', () => {
      expect(serializeChannelNames(['A', '   ', '', 'B'])).toBe('A\nB');
    });

    it('produces an empty string for an empty list', () => {
      expect(serializeChannelNames([])).toBe('');
    });
  });
});
