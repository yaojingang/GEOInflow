// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { type DecisionPlanner, WarehouseConsumer } from './consumer';
import type { Attempt, Ownership, SiteState } from './control';
import { WarehouseDeriver } from './derivation';
import { type InputPosition, type LandedDecision, LandingStore } from './landing';
import { logEnvelope } from './log-package';
import { logPlanner } from './log-planner';
import { collectionPlanner } from './planner';
import { routingKey } from './routing';
import type { QueueInstallation } from './transport';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const decisionProjected = vi.fn(async () => {});
  const queue = {
    installation: { topicName: 'test', topicId: 'topic', partitions: 1 },
    maxMessageBytes: 1024,
    kafka: {
      consumer: () => ({ events: {}, on: () => () => {} }),
    },
  };
  const worker = new WarehouseConsumer(
    { db: {}, decisionProjected } as any,
    {} as any,
    queue as any,
    async () => [],
    { groupId: 'test' },
  );
  const owner = { topicId: 'topic', partition: 0, ownerId: 'owner', generation: '1' } as Ownership;
  const attempt = { attempt_id: 'attempt', status: 'confirmed', effects: [] } as unknown as Attempt;
  return {
    decisionProjected,
    restore: () => (worker as any).restore(owner, attempt) as Promise<void>,
  };
}

test('a receipt key stays busy until a no-effect package is completely published', async () => {
  const states: string[] = [];
  vi.spyOn(LandingStore.prototype, 'projectDecision').mockImplementation(async () => {
    states.push('decision-durable');
  });
  let finish: () => void;
  const publication = new Promise<void>(resolve => {
    finish = resolve;
  });
  vi.spyOn(WarehouseDeriver.prototype, 'derive').mockImplementation(async () => {
    states.push('decision-durable');
    states.push('publication-started');
    await publication;
    states.push('package-published');
  });
  const f = fixture();
  f.decisionProjected.mockImplementation(async () => {
    states.push('receipt-key-released');
  });
  const pending = f.restore();
  await vi.waitFor(() => expect(states).toContain('publication-started'));
  const beforePublication = [...states];
  finish();
  await pending;
  expect(beforePublication).toEqual(['decision-durable', 'publication-started']);
  expect(LandingStore.prototype.projectDecision).not.toHaveBeenCalled();
  expect(states).toEqual([
    'decision-durable',
    'publication-started',
    'package-published',
    'receipt-key-released',
  ]);
});

test('failed no-effect derivation retains the key until recovery publishes the original package', async () => {
  vi.spyOn(LandingStore.prototype, 'projectDecision').mockResolvedValue(undefined);
  const derive = vi
    .spyOn(WarehouseDeriver.prototype, 'derive')
    .mockRejectedValueOnce(new Error('family-write-failed'))
    .mockResolvedValueOnce(undefined);
  const f = fixture();
  await expect(f.restore()).rejects.toThrow('family-write-failed');
  const releasedAfterFailure = f.decisionProjected.mock.calls.length;
  await f.restore();
  expect(releasedAfterFailure).toBe(0);
  expect(f.decisionProjected).toHaveBeenCalledTimes(1);
  expect(derive).toHaveBeenCalledTimes(2);
});

const site: SiteState = {
  website_id: randomUUID(),
  epoch: '2',
  version: '8',
  publication: '7',
  deletion_revision: '3',
  policy_revision: '0',
  governance_revision: '0',
  repair_revision: '0',
  state: 'active',
};
const topicId = 'a'.repeat(32);
const batchId = randomUUID();
const logId = 'b'.repeat(64);

function logInput(offset: string, id = logId): InputPosition {
  const envelope = logEnvelope(
    site,
    { topicId } as QueueInstallation,
    {
      id,
      time: '2026-11-03T01:02:03Z',
      path: '/isolated',
      method: 'GET',
      status: 200,
      bytes: 123,
      ipMasked: 'masked',
      ipHash: 'c'.repeat(64),
      userAgent: 'IsolatedTestBot',
      location: 'unknown',
      bot: 'other',
      vendor: 'other',
      type: 'other',
      verification: 'unverified',
    },
    { batchId, sourceId: null, sourceEpoch: 1, kind: 'manual', receivedAt: new Date() },
  );
  return { partition: 0, offset, envelope };
}

function decision(input: InputPosition, status: LandedDecision['status'] = 'new'): LandedDecision {
  return { input, status, sessionId: null, visitId: null, facts: [] };
}

function planningFixture(inputs: InputPosition[], planner: DecisionPlanner) {
  const owner: Ownership = { topicId, ownerId: randomUUID(), partition: 0, generation: '1' };
  const attempt = {
    attempt_id: randomUUID(),
    epoch: site.epoch,
    deletion_revision: site.deletion_revision,
  } as Attempt;
  const control = {
    db: {},
    claim: vi.fn().mockResolvedValue(owner),
    recovery: vi.fn().mockResolvedValue([]),
    ready: vi
      .fn()
      .mockResolvedValue(inputs.map(input => ({ website_id: input.envelope.websiteId }))),
    intent: vi.fn().mockResolvedValue(attempt),
    site: vi.fn().mockResolvedValue(site),
    confirm: vi.fn().mockResolvedValue(attempt),
    abort: vi.fn().mockResolvedValue(undefined),
    safeOffset: vi.fn().mockResolvedValue(undefined),
  };
  const worker = new WarehouseConsumer(
    control as any,
    {} as any,
    { installation: { topicId }, kafka: { consumer: () => ({ events: {}, on: vi.fn() }) } } as any,
    planner,
    { groupId: 'test' },
  );
  (worker as any).assigned.add(0);
  vi.spyOn(worker as any, 'payloads').mockResolvedValue(inputs);
  vi.spyOn(worker as any, 'restore').mockResolvedValue(undefined);
  const deleted = vi.spyOn(LandingStore.prototype, 'deletedInputs').mockResolvedValue(new Set());
  const replay = vi.spyOn(LandingStore.prototype, 'acceptedInputs').mockResolvedValue(new Map());
  const receipts = vi.spyOn(LandingStore.prototype, 'receipts').mockResolvedValue([]);
  const stage = vi.spyOn(LandingStore.prototype, 'stage').mockResolvedValue(() => []);
  return {
    boundary: {
      websiteId: site.website_id,
      epoch: site.epoch,
      publication: '7',
      deletionRevision: '3',
    },
    control,
    restore: vi.mocked((worker as any).restore),
    drain: () => (worker as any).drain(0) as Promise<boolean>,
    deleted,
    replay,
    receipts,
    stage,
  };
}

test('pure log work uses the accepted log lookup and skips generic identity receipts', async () => {
  const log = logInput('1');
  const db = {
    read: vi.fn().mockResolvedValue([
      {
        batch_id: batchId,
        source_id: null,
        source_epoch: 1,
        status: 'pending',
        kind: 'manual',
        import_present: true,
        repair_scope_id: null,
      },
    ]),
  };
  const lookup = vi.fn().mockResolvedValue([{ id: logId, event_digest: null }]);
  const plan = collectionPlanner(
    vi.fn<DecisionPlanner>(),
    logPlanner(db as any, {} as any, undefined, lookup),
  );
  const f = planningFixture([log], plan);
  expect(await f.drain()).toBe(true);
  expect(f.receipts).not.toHaveBeenCalled();
  expect(f.deleted).toHaveBeenCalledWith(f.boundary, [log]);
  expect(f.replay).toHaveBeenCalledWith(f.boundary, [log]);
  expect(lookup).toHaveBeenCalledWith(site, [logId]);
  expect(f.stage.mock.calls[0][1]).toMatchObject([{ input: log, status: 'duplicate', facts: [] }]);
});

test('mixed work fetches receipts only for new browser decisions and respects deletion and replay', async () => {
  const log = logInput('1');
  const deletedLog = logInput('2', 'd'.repeat(64));
  const freshLog = logInput('4', 'e'.repeat(64));
  const browser: InputPosition = {
    partition: 0,
    offset: '3',
    envelope: {
      ...log.envelope,
      kind: 'browser',
      inputId: randomUUID(),
      clientEventId: randomUUID(),
    },
  };
  const replayed = decision(log, 'duplicate');
  const browserDecision = decision(browser, 'duplicate');
  const browserPlanner = vi.fn<DecisionPlanner>().mockResolvedValue([browserDecision]);
  const logDecision = decision(freshLog);
  const logs = vi.fn<DecisionPlanner>().mockResolvedValue([logDecision]);
  const inputs = [log, deletedLog, browser, freshLog];
  const f = planningFixture(inputs, collectionPlanner(browserPlanner, logs));
  f.deleted.mockResolvedValue(new Set([deletedLog.envelope.inputId]));
  f.replay.mockResolvedValue(new Map([[log.envelope.inputId, replayed]]));
  const receipt = {
    identity_key: routingKey(browser.envelope),
    payload_hash: browser.envelope.fingerprint,
    original_session: browser.envelope.sessionId,
    original_visit: browser.envelope.visitId,
    source: browser.envelope.collectionSource,
    scope: browser.envelope.collectionScope,
    version: '1',
  };
  f.receipts.mockResolvedValue([receipt]);
  expect(await f.drain()).toBe(true);
  expect(f.deleted).toHaveBeenCalledWith(f.boundary, inputs);
  expect(f.replay).toHaveBeenCalledWith(f.boundary, [log, browser, freshLog]);
  expect(f.receipts).toHaveBeenCalledExactlyOnceWith(f.boundary, [receipt.identity_key]);
  expect(browserPlanner).toHaveBeenCalledExactlyOnceWith([browser], site, [receipt]);
  expect(logs.mock.calls[0][0]).toEqual([freshLog]);
  expect(f.stage.mock.calls[0][1]).toMatchObject([
    browserDecision,
    logDecision,
    replayed,
    { input: deletedLog, status: 'cancelled', facts: [], effects: [{ batchId, cancelled: 1 }] },
  ]);
});

test('a failed recovery fences later work on this partition until the pending attempt succeeds', async () => {
  vi.useFakeTimers();
  try {
    const f = planningFixture([], async () => []);
    const attempt = { attempt_id: randomUUID() };
    f.control.recovery.mockResolvedValue([attempt]);
    f.restore.mockRejectedValueOnce(new Error('readback timed out'));
    expect(await f.drain()).toBe(false);
    expect(await f.drain()).toBe(false);
    expect(f.restore).toHaveBeenCalledTimes(1);
    expect(f.control.ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await f.drain()).toBe(true);
    expect(f.restore).toHaveBeenCalledTimes(2);
    expect(f.control.ready).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
