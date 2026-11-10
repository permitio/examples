import { describe, expect, it } from 'vitest';
import { callerHeaders, errorMessage } from '~/utils/api';
import { formatTime } from '~/utils/time';

describe('formatTime', () => {
  const now = new Date(2026, 10, 10, 15, 30, 0);
  const at = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
    new Date(year, month, day, hour, minute, second).toISOString();

  it.each([
    ['under a minute ago', at(2026, 10, 10, 15, 29, 30), 'Just now'],
    ['a minute ago', at(2026, 10, 10, 15, 29), '1 min ago'],
    ['minutes ago', at(2026, 10, 10, 15, 5), '25 mins ago'],
    ['earlier today', at(2026, 10, 10, 9, 5), 'Today · 09:05 AM'],
    ['yesterday', at(2026, 10, 9, 23, 40), 'Yesterday · 11:40 PM'],
    ['before yesterday', at(2026, 10, 8, 9, 5), '08 Nov 26 · 09:05 AM'],
  ])('says %s', (_case, iso, expected) => {
    expect(formatTime(iso, now)).toBe(expected);
  });

  it('crosses a month boundary for yesterday', () => {
    expect(
      formatTime(new Date(2026, 9, 31, 20, 0).toISOString(), new Date(2026, 10, 1, 8, 0)),
    ).toBe('Yesterday · 08:00 PM');
  });
});

describe('errorMessage', () => {
  it("returns the server's message from a failed fetch", () => {
    const error = Object.assign(new Error('[POST] "/orders": 403 Forbidden'), {
      data: { statusCode: 403, message: 'You are not permitted to perform this action' },
    });

    expect(errorMessage(error)).toBe('You are not permitted to perform this action');
  });

  it("falls back to the error's own message when the body has none", () => {
    expect(errorMessage(Object.assign(new Error('fetch failed'), { data: '<html>' }))).toBe(
      'fetch failed',
    );
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('callerHeaders', () => {
  it('sends the user and city, and asks for JSON errors', () => {
    expect(callerHeaders('rider2', 'california')).toEqual({
      user: 'rider2',
      city: 'california',
      accept: 'application/json',
    });
  });
});
