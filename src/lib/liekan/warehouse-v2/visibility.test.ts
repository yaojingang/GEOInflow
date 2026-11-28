import { describe, expect, it } from 'vitest';
import { certify, logLane, visibility } from '../../../../scripts/liekan-warehouse-v2-visibility';

describe('formal HTTP visibility accounting', () => {
  it('keeps both paths observable between consecutive cohorts', () => {
    const first = Array.from({ length: 33 }, (_, i) => logLane(i));
    expect(new Set(first)).toEqual(new Set([0, 1]));
    expect(Array.from({ length: 297 }, (_, i) => logLane(i + 33)).every(n => n >= 2)).toBe(true);
    expect(logLane(330)).toBe(0);
  });
  it('retains unproved batches, even when a later upload overtakes an earlier one', () => {
    const writes = [
      { start: 1, end: 4 },
      { start: 2, end: 3 },
    ];
    const page = (end: number, count: number) => ({ end, count, shape: true, status: 200 });
    certify(writes, [page(8, 12)], 10, s => s.count, 2);
    expect(visibility(writes)).toMatchObject({ missing: 2, p95AckToPageMs: null });
    certify(writes, [page(5030, 14)], 10, s => s.count, 2);
    expect(visibility(writes)).toMatchObject({ missing: 0, over5s: 2 });
  });
  it('uses a complete business response after ACK and ignores failed reads', () => {
    const writes = [
      { start: 1, end: 10 },
      { start: 2, end: 3 },
    ];
    const pages = [
      { end: 4, status: 200 },
      { end: 13, status: 503 },
      { end: 14, status: 200 },
    ];
    certify(
      writes,
      pages.map(p => ({ ...p, shape: true })),
      0,
      () => 4,
      2,
    );
    expect(visibility(writes)).toMatchObject({ matched: 2, p95AckToPageMs: 4, within5s: 2 });
  });
});
