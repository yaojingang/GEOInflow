import { describe, expect, it } from 'vitest';
import { decimalInput, warehouseTime } from './fact-input';

describe('warehouse timestamp and numeric input', () => {
  it('preserves six-digit keyset cursor precision across UTC offsets', () => {
    expect(warehouseTime('2026-11-03 01:02:03.123456')).toBe('2026-11-03 01:02:03.123456');
    expect(warehouseTime('2026-11-03T01:02:03.123456Z')).toBe('2026-11-03 01:02:03.123456');
    expect(warehouseTime('2026-11-03T01:02:03.000009+08:00')).toBe('2026-11-02 17:02:03.000009');
    expect(warehouseTime('2026-11-03 01:02:03.1+00')).toBe('2026-11-03 01:02:03.100000');
    expect(warehouseTime(new Date('2026-11-03T01:02:03.123Z'))).toBe('2026-11-03 01:02:03.123000');
    expect(() => warehouseTime('2026-11-03T01:02:03.1234567Z')).toThrow('precision');
  });
  it('matches PostgreSQL decimal tie rounding for both signs', () => {
    expect(decimalInput(1.005, 2)).toBe('1.01');
    expect(decimalInput(-1.005, 2)).toBe('-1.01');
    expect(decimalInput('1.000005e1', 4)).toBe('10.0001');
  });
});
