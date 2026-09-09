import { describe, it, expect } from 'vitest';
import { parseChannelNames, serializeChannelNames } from './channelNames';

describe('channelNames', () => {
  it('returns an empty list for empty input', () => {
    expect(parseChannelNames(null)).toEqual([]);
    expect(parseChannelNames('')).toEqual([]);
  });

  it('reads legacy comma-separated values', () => {
    expect(parseChannelNames('Group A, Group B')).toEqual(['Group A', 'Group B']);
  });

  it('reads newline-separated values', () => {
    expect(parseChannelNames('Group A\nGroup B')).toEqual(['Group A', 'Group B']);
  });

  it('round-trips a channel name containing a comma', () => {
    const names = ["בנים שכבת ה', יזמה", 'כיתה ה2 הורים'];
    expect(parseChannelNames(serializeChannelNames(names))).toEqual(names);
  });

  it('drops blank entries', () => {
    expect(serializeChannelNames(['A', '  ', 'B'])).toBe('A\nB');
    expect(parseChannelNames('A,, ,B')).toEqual(['A', 'B']);
  });
});
