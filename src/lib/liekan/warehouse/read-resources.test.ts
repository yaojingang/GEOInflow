import { describe, expect, it } from 'vitest';
import { warehouseReadResources } from './read-resources';

describe('warehouse query resource budget', () => {
  it('keeps independent join and aggregation spill thresholds below the default budget', () => {
    expect(warehouseReadResources()).toEqual(warehouseReadResources('1073741824'));
    expect(warehouseReadResources('1073741824')).toEqual({
      max_memory_usage: '1073741824',
      max_bytes_before_external_group_by: '536870912',
      max_bytes_before_external_sort: '536870912',
      max_bytes_before_external_join: '268435456',
    });
  });
  it('scales spill thresholds down for a smaller installation', () => {
    const settings = warehouseReadResources('67108864');
    expect(settings.max_memory_usage).toBe('67108864');
    expect(Number(settings.max_bytes_before_external_group_by)).toBeLessThan(67108864);
    expect(Number(settings.max_bytes_before_external_join)).toBeLessThan(
      Number(settings.max_bytes_before_external_group_by),
    );
    expect(Number(settings.max_bytes_before_external_join)).toBeGreaterThan(0);
  });
  it.each(['0', '-1', '', 'Infinity', 'NaN', '1e9', '1.5', '9007199254740992'])(
    'rejects invalid or unlimited resource setting %s',
    value => {
      expect(() => warehouseReadResources(value)).toThrow('warehouse-query-memory-invalid');
    },
  );
});
