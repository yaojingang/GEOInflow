import { beforeEach, describe, expect, test, vi } from 'vitest';
import { deleteWebsite, getWebsite, resetWebsite } from './website';

const {
  transactionMock,
  redisDelMock,
  redisSetMock,
  resetLiekanMock,
  stopWebsiteSourcesMock,
  findUniqueMock,
  findFirstMock,
  shareFindFirstMock,
  lockMock,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  redisDelMock: vi.fn(),
  redisSetMock: vi.fn(),
  resetLiekanMock: vi.fn(),
  stopWebsiteSourcesMock: vi.fn(),
  findUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
  shareFindFirstMock: vi.fn(),
  lockMock: vi.fn(),
}));

vi.mock('@/lib/liekan/upstream/ai-lifecycle', () => ({ clearAiWebsiteInTransaction: vi.fn() }));
vi.mock('@/lib/liekan/upstream/server', () => ({ lockWritableWebsite: lockMock }));
vi.mock('@/lib/liekan/upstream/lifecycle', async () => {
  const actual = await vi.importActual<typeof import('@/lib/liekan/upstream/lifecycle')>(
    '@/lib/liekan/upstream/lifecycle',
  );
  return {
    ...actual,
    resetLiekanStatistics: resetLiekanMock,
    stopWebsiteSources: stopWebsiteSourcesMock,
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
    client: {
      website: { findUnique: findUniqueMock, findFirst: findFirstMock },
      share: { findFirst: shareFindFirstMock },
    },
  },
  getSchema: () => new URL(process.env.DATABASE_URL || '').searchParams.get('schema'),
}));

vi.mock('@/lib/redis', () => ({
  default: {
    client: {
      del: redisDelMock,
      set: redisSetMock,
    },
  },
}));

function createDeleteTx(calls: string[]) {
  return {
    sessionReplaySaved: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionReplaySaved');
      }),
    },
    sessionReplay: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionReplay');
      }),
    },
    heatmapEvent: {
      deleteMany: vi.fn(async () => {
        calls.push('heatmapEvent');
      }),
    },
    revenue: {
      deleteMany: vi.fn(async () => {
        calls.push('revenue');
      }),
    },
    eventData: {
      deleteMany: vi.fn(async () => {
        calls.push('eventData');
      }),
    },
    $executeRawUnsafe: vi.fn(async () => {
      calls.push('rawSql');
    }),
    sessionData: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionData');
      }),
    },
    sessionLink: {
      deleteMany: vi.fn(async () => {
        calls.push('sessionLink');
      }),
    },
    websiteEvent: {
      deleteMany: vi.fn(async () => {
        calls.push('websiteEvent');
      }),
    },
    session: {
      deleteMany: vi.fn(async () => {
        calls.push('session');
      }),
    },
    report: {
      deleteMany: vi.fn(async () => {
        calls.push('report');
      }),
    },
    segment: {
      deleteMany: vi.fn(async () => {
        calls.push('segment');
      }),
    },
    annotation: {
      deleteMany: vi.fn(async () => {
        calls.push('annotation');
      }),
    },
    share: {
      deleteMany: vi.fn(async () => {
        calls.push('share');
      }),
    },
    website: {
      delete: vi.fn(async () => {
        calls.push('websiteDelete');
        return { id: 'website-1' };
      }),
      update: vi.fn(async () => {
        calls.push('websiteUpdate');
        return { id: 'website-1' };
      }),
    },
  };
}

describe('getWebsite dual-track resolution', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    findFirstMock.mockReset();
    shareFindFirstMock.mockReset();
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/umami?schema=public';
  });

  const uuid = '5b4c0de0-6c47-5b51-8f53-11e5e8c79001';
  const site = { id: uuid, name: '猎看', siteNumber: 101 };

  test('resolves a UUID through the original lookup', async () => {
    findUniqueMock.mockResolvedValue(site);
    shareFindFirstMock.mockResolvedValue(null);
    await expect(getWebsite(uuid)).resolves.toEqual({ ...site, shareId: null });
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: uuid } });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  test('resolves the short site number through the site_number lookup', async () => {
    findFirstMock.mockResolvedValue(site);
    shareFindFirstMock.mockResolvedValue({ slug: 'share-slug' });
    await expect(getWebsite('101')).resolves.toEqual({ ...site, shareId: 'share-slug' });
    expect(findFirstMock).toHaveBeenCalledWith({ where: { siteNumber: 101 } });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  test('rejects malformed identifiers without touching the database', async () => {
    await expect(getWebsite('101x')).resolves.toBeNull();
    await expect(getWebsite('not-a-site')).resolves.toBeNull();
    await expect(getWebsite('')).resolves.toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  test('accepts numeric handles up to nine digits and rejects longer ones', async () => {
    findFirstMock.mockResolvedValue(site);
    shareFindFirstMock.mockResolvedValue(null);
    await expect(getWebsite('999999999')).resolves.toEqual({ ...site, shareId: null });
    expect(findFirstMock).toHaveBeenCalledWith({ where: { siteNumber: 999999999 } });

    findFirstMock.mockClear();
    await expect(getWebsite('1234567890')).resolves.toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  test('queries site number zero like any other numeric handle', async () => {
    findFirstMock.mockResolvedValue(null);
    shareFindFirstMock.mockResolvedValue(null);
    await expect(getWebsite('0')).resolves.toBeNull();
    expect(findFirstMock).toHaveBeenCalledWith({ where: { siteNumber: 0 } });
  });
});

describe('website delete dependencies', () => {
  let steps: string[];
  let transactions: { calls: string[]; sql: string[]; query: string[] }[];
  let catalogRows: { name: string }[];
  let keysFor: (table?: string) => { name: string }[];
  let executeResult: (sql: string) => number;
  let onWebsiteDelete: (() => void) | undefined;
  let activeCalls: string[];

  beforeEach(() => {
    steps = [];
    transactions = [];
    catalogRows = [];
    keysFor = () => [];
    executeResult = () => 0;
    onWebsiteDelete = undefined;
    activeCalls = [];
    transactionMock.mockReset();
    redisDelMock.mockReset();
    redisSetMock.mockReset();
    resetLiekanMock.mockReset();
    stopWebsiteSourcesMock.mockReset();
    lockMock.mockReset();
    delete process.env.CLOUD_MODE;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/umami?schema=public';
    lockMock.mockImplementation(async () => {
      steps.push('lock');
    });
    resetLiekanMock.mockImplementation(async () => {
      activeCalls.push('liekanReset');
    });
    stopWebsiteSourcesMock.mockImplementation(async () => {
      activeCalls.push('stop');
    });
    transactionMock.mockImplementation(async (work, options) => {
      expect(options).toEqual({ timeout: 30000 });
      activeCalls = [];
      const tx = createDeleteTx(activeCalls);
      tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
        activeCalls.push('rawSql');
        if (sql.includes('DELETE FROM') || sql.includes('delete from event_data')) steps.push(sql);
        return executeResult(sql);
      });
      tx.$queryRawUnsafe = vi.fn(async (sql: string, arg?: string) => {
        if (sql.includes('pg_constraint')) return catalogRows;
        if (sql.includes('indisprimary')) return keysFor(arg);
        return [];
      });
      tx.website.delete.mockImplementation(async () => {
        activeCalls.push('websiteDelete');
        onWebsiteDelete?.();
        return { id: 'website-1' };
      });
      const recorded = activeCalls;
      try {
        return await work(tx);
      } finally {
        transactions.push({
          calls: [...recorded],
          sql: tx.$executeRawUnsafe.mock.calls.map(call => String(call[0])),
          query: tx.$queryRawUnsafe.mock.calls.map(call => String(call[0])),
        });
      }
    });
  });

  function batchSql() {
    return transactions.flatMap(tx => tx.sql).filter(sql => sql.includes('LIMIT'));
  }

  function finalTransaction() {
    return transactions.find(
      tx => tx.calls.includes('websiteDelete') || tx.calls.includes('websiteUpdate'),
    );
  }

  test('deleteWebsite batches dependent rows before the website row transaction', async () => {
    await deleteWebsite('website-1');
    const sql = batchSql();
    const safety = sql.findIndex(statement => statement.includes('event_data.website_event_id'));
    const events = sql.findIndex(statement => statement.startsWith('DELETE FROM website_event'));
    const sessions = sql.findIndex(statement => statement.startsWith('DELETE FROM session '));
    expect(safety).toBeGreaterThan(-1);
    expect(events).toBeGreaterThan(safety);
    expect(sessions).toBeGreaterThan(events);
    expect(sql.some(statement => statement.includes('LIMIT 5000'))).toBe(true);
    expect(
      transactions.some(tx => tx.query.some(statement => statement.includes('confdeltype'))),
    ).toBe(true);

    const final = finalTransaction();
    expect(final?.calls.filter(call => call !== 'rawSql')).toEqual([
      'stop',
      'sessionReplaySaved',
      'sessionReplay',
      'heatmapEvent',
      'revenue',
      'eventData',
      'sessionData',
      'sessionLink',
      'websiteEvent',
      'session',
      'report',
      'segment',
      'annotation',
      'share',
      'websiteDelete',
    ]);
    expect(final?.sql.some(statement => statement.includes('delete from event_data'))).toBe(true);
    expect(final?.sql.some(statement => statement.includes('liekan_analytics_revision'))).toBe(
      true,
    );
    expect(transactions.at(-1)).toBe(final);
  });

  test('hard delete purges cascaded tables and soft delete leaves them', async () => {
    catalogRows = [{ name: 'liekan_log' }];
    await deleteWebsite('website-1');
    expect(batchSql().some(statement => statement.startsWith('DELETE FROM liekan_log'))).toBe(true);

    transactions = [];
    steps = [];
    process.env.CLOUD_MODE = '1';
    await deleteWebsite('website-1');
    expect(
      transactions.some(tx => tx.query.some(statement => statement.includes('pg_constraint'))),
    ).toBe(false);
    expect(batchSql().some(statement => statement.includes('liekan_log'))).toBe(false);
    expect(finalTransaction()?.calls).toContain('websiteUpdate');
    expect(redisDelMock).toHaveBeenCalledWith('website:website-1');
  });

  test('rejects a cascaded table name that is not an identifier', async () => {
    catalogRows = [{ name: 'bad-name' }];
    await expect(deleteWebsite('website-1')).rejects.toThrow('Invalid SQL identifier');
    expect(steps.some(step => step.includes('DELETE FROM'))).toBe(false);
  });

  test('uses the primary key for batches and repeats a full batch', async () => {
    keysFor = table => (table === 'website_event' ? [{ name: 'event_id' }] : []);
    let passes = 0;
    executeResult = sql => {
      if (!sql.startsWith('DELETE FROM website_event')) return 0;
      passes += 1;
      return passes === 1 ? 5000 : 0;
    };
    await deleteWebsite('website-1');
    const eventDeletes = batchSql().filter(statement =>
      statement.startsWith('DELETE FROM website_event'),
    );
    expect(eventDeletes).toHaveLength(2);
    expect(eventDeletes[0]).toContain('(event_id) IN (SELECT event_id FROM website_event');
    expect(batchSql().find(statement => statement.startsWith('DELETE FROM session '))).toContain(
      '(ctid) IN (SELECT ctid FROM session ',
    );
  });

  test('retries the committed purge when the final transaction times out', async () => {
    let commits = 0;
    onWebsiteDelete = () => {
      commits += 1;
      if (commits === 1)
        throw Object.assign(new Error('interactive transaction timeout'), { code: 'P2028' });
    };
    await deleteWebsite('website-1');
    expect(commits).toBe(2);
    expect(transactions.filter(tx => tx.calls.includes('websiteDelete'))).toHaveLength(2);

    commits = 0;
    transactions = [];
    onWebsiteDelete = () => {
      throw Object.assign(new Error('interactive transaction timeout'), { code: 'P2028' });
    };
    await expect(deleteWebsite('website-1')).rejects.toMatchObject({ code: 'P2028' });
    expect(transactions.filter(tx => tx.calls.includes('websiteDelete'))).toHaveLength(5);
  });

  test('resetWebsite checks write access before batched deletes and then resets the row', async () => {
    const identity = { userId: 'owner-1' };
    await resetWebsite('website-1', identity);
    expect(steps[0]).toBe('lock');
    expect(lockMock).toHaveBeenCalledWith(expect.anything(), 'website-1', identity);
    const sql = batchSql();
    const logs = sql.findIndex(statement => statement.startsWith('DELETE FROM liekan_log'));
    const events = sql.findIndex(statement => statement.startsWith('DELETE FROM website_event'));
    expect(logs).toBeGreaterThan(-1);
    expect(events).toBeGreaterThan(logs);
    const final = finalTransaction();
    expect(resetLiekanMock).toHaveBeenCalledWith(expect.anything(), 'website-1', identity);
    expect(final?.calls.filter(call => call !== 'rawSql')).toEqual([
      'liekanReset',
      'sessionReplaySaved',
      'sessionReplay',
      'heatmapEvent',
      'revenue',
      'eventData',
      'sessionData',
      'sessionLink',
      'websiteEvent',
      'session',
      'websiteUpdate',
    ]);
    expect(transactions.at(-1)).toBe(final);
  });

  test('revoked write access stops reset before dependent rows are deleted', async () => {
    lockMock.mockImplementation(async () => {
      steps.push('lock');
      throw new Error('Permission revoked');
    });
    await expect(resetWebsite('website-1', { userId: 'owner-1' })).rejects.toThrow(
      'Permission revoked',
    );
    expect(steps).toEqual(['lock']);
    expect(batchSql()).toEqual([]);
    expect(resetLiekanMock).not.toHaveBeenCalled();
    expect(finalTransaction()).toBeUndefined();
  });
});
