import assert from 'node:assert/strict';

type TimedInput = { start: number; end: number; seen?: number };
type ReadSample = { end: number; status: number; shape?: boolean };
const ms = (n: number) => Math.round(n * 100) / 100;

// 33 arrivals in a second alternate between two of the twenty visible paths.
// A path then stays idle for nine seconds while ordinary page reads continue.
export function logLane(sequence: number) {
  return (Math.floor(sequence / 33) % 10) * 2 + (sequence % 2);
}

// A complete lane count identifies an entire closed set, including out-of-order ACKs.
// Only structurally validated, physically reconciled writes can contribute. No other writer uses this fresh site.
export function certify<S extends ReadSample>(
  inputs: TimedInput[],
  snaps: S[],
  base: number,
  count: (s: S) => number | undefined,
  increment: number,
) {
  const ordered = [...inputs].sort((a, b) => a.start - b.start);
  let previous = base,
    proven = 0;
  for (const s of snaps) {
    const observed = count(s);
    if (s.status !== 200 || !s.shape || observed === undefined) continue;
    assert(observed >= previous, 'nonmonotonic visible population');
    previous = observed;
    const possible = ordered.filter(x => x.start <= s.end).length;
    assert(
      observed <= base + possible * increment,
      'business response exceeds possible accepted population',
    );
    if (observed === base + possible * increment) proven = possible;
    for (let i = 0; i < proven; i++)
      if (ordered[i].seen === undefined && s.end >= ordered[i].end) ordered[i].seen = s.end;
  }
}

export function visibility(inputs: TimedInput[]) {
  const observed = inputs.filter(i => i.seen !== undefined);
  const missing = inputs.length - observed.length;
  const times = observed.map(i => i.seen! - i.end);
  // Missing measurements remain +infinity for ranking; JSON uses null for an unbounded quantile.
  const rank = Math.ceil(inputs.length * 0.95);
  const conservative = (all: number[]) =>
    rank && rank <= all.length ? ms([...all].sort((a, b) => a - b)[rank - 1]) : null;
  return {
    accepted: inputs.length,
    matched: observed.length,
    missing,
    p95AckToPageMs: conservative(times),
    p95SendToPageMs: conservative(observed.map(i => i.seen! - i.start)),
    within5s: times.filter(v => v <= 5000).length,
    within5sPct: inputs.length
      ? ms((100 * times.filter(v => v <= 5000).length) / inputs.length)
      : null,
    allWithin5s: inputs.length > 0 && times.filter(v => v <= 5000).length === inputs.length,
    over5s: times.filter(v => v > 5000).length,
    missedOrOver5s: missing + times.filter(v => v > 5000).length,
  };
}
