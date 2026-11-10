import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format';

describe('formatMoney', () => {
  it('groups thousands and shows two decimals', () => {
    expect(formatMoney('£', 457935.1)).toBe('£457,935.10');
    expect(formatMoney('£', 80)).toBe('£80.00');
  });
});
