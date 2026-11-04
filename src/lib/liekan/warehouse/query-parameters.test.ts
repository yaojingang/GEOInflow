import { describe, expect, it } from 'vitest';
import { prepareQueryParameters } from './query-parameters';

describe('warehouse batch parameter transport', () => {
  it('preserves every key and reuses split expressions at repeated references', () => {
    const keys = Array.from({ length: 10001 }, (_, i) => String(i).padStart(40, '0'));
    const input: {
      query: string;
      query_params: Record<string, unknown>;
      use_multipart_params?: boolean;
    } = {
      query: 'SELECT {keys:Array(String)}, {keys:Array(String)}, {n:UInt32}',
      query_params: { keys, n: 4 },
    };
    const p = prepareQueryParameters(input);
    expect(p.query_params.keys).toBeUndefined();
    expect(p.use_multipart_params).toBe(true);
    expect(
      Object.entries(p.query_params)
        .filter(([k]) => k !== 'n')
        .flatMap(([, v]) => v as string[]),
    ).toEqual(keys);
    expect(
      p.query
        .split(', {n:UInt32}')[0]
        .split('SELECT ')[1]
        .match(/arrayConcat/g),
    ).toHaveLength(2);
    expect(input.query_params.keys).toHaveLength(10001);
  });
  it('preserves large unicode strings without splitting surrogate pairs', () => {
    const value = "词😀'\\".repeat(12000),
      p = prepareQueryParameters({ query: 'SELECT {value:String}', query_params: { value } });
    expect(Object.values(p.query_params).join('')).toBe(value);
    for (const v of Object.values(p.query_params))
      expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(48000);
  });
  it('preserves nullable array element types for oversized string items', () => {
    const value = ['x'.repeat(150000), null, 'ok'],
      p = prepareQueryParameters({
        query: 'SELECT {value:Array(Nullable(String))}',
        query_params: { value },
      });
    expect(p.query).toContain('CAST([concat(');
    expect(p.query).toContain('AS Array(Nullable(String))');
  });
});
