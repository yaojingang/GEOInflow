import pg from 'pg';

export interface ControlSQL {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class WarehouseConflict extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class WarehouseCommitUncertain extends Error {
  constructor() {
    super('warehouse-control-commit-uncertain');
  }
}

export function controlFailure(error: unknown): WarehouseConflict | undefined {
  const code = (error as { code?: string })?.code;
  if (['40001', '40P01', '55P03', '57014', '53300'].includes(code))
    return new WarehouseConflict('warehouse-control-busy');
  if (
    ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(
      code,
    ) ||
    (error instanceof Error &&
      [
        'Connection terminated due to connection timeout',
        'timeout exceeded when trying to connect',
      ].includes(error.message))
  )
    return new WarehouseConflict('warehouse-control-unavailable');
}

export function warehouseTransient(error: unknown): error is WarehouseConflict {
  return (
    error instanceof WarehouseConflict &&
    [
      'warehouse-authority-frozen',
      'warehouse-authority-changed',
      'warehouse-control-busy',
      'warehouse-control-unavailable',
      'warehouse-read-reference-lost',
      'warehouse-read-boundary-changed',
    ].includes(error.code)
  );
}

export class ControlDatabase {
  private readonly pool;

  constructor(connectionString: string, max = 6) {
    this.pool = new pg.Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      application_name: 'liekan-warehouse-control',
      options: '-c statement_timeout=5000 -c lock_timeout=1000',
    });
    // Idle socket errors invalidate the connection; they must not terminate the worker.
    this.pool.on('error', () => {});
  }

  async read<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> {
    try {
      return (await this.pool.query(sql, values)).rows;
    } catch (error) {
      throw controlFailure(error) ?? error;
    }
  }

  async transaction<T>(work: (tx: ControlSQL) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(error => {
      throw controlFailure(error) ?? error;
    });
    let failed: Error | undefined;
    let committing = false;
    const onError = (error: Error) => {
      failed = error;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const result = await work(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = error instanceof Error ? error : new Error('warehouse-control-error');
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Preserve the original failure. */
      }
      // A lost response is not evidence of rollback. Callers reconcile their stable
      // operation ID and must not blindly generate a new candidate or decision.
      if (committing && !['40001', '40P01'].includes((error as { code?: string })?.code)) {
        throw new WarehouseCommitUncertain();
      }
      throw controlFailure(error) ?? error;
    } finally {
      client.release(failed);
      client.off('error', onError);
    }
  }

  async close() {
    await this.pool.end();
  }
}
