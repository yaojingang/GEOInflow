import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = mocks.query;
      connect = mocks.connect;
      on() {}
      async end() {}
    },
  },
}));
import { ControlDatabase, WarehouseConflict, warehouseTransient } from './control-db';
beforeEach(() => vi.clearAllMocks());
describe('warehouse transient control failures', () => {
  it.each(['57014', '55P03', '53300'])('turns %s into a retryable control response', async code => {
    mocks.query.mockRejectedValue({ code, message: 'private driver detail' });
    await expect(new ControlDatabase('test').read('SELECT 1')).rejects.toMatchObject({
      code: 'warehouse-control-busy',
    });
  });
  it.each(['57P01', 'ECONNREFUSED', 'ECONNRESET'])(
    'turns %s into unavailable without driver details',
    async code => {
      mocks.query.mockRejectedValue({ code, message: 'private driver detail' });
      await expect(new ControlDatabase('test').read('SELECT 1')).rejects.toThrow(
        'warehouse-control-unavailable',
      );
    },
  );
  it('preserves SQL/schema errors and does not treat data conflicts as transient', async () => {
    const error = { code: '42P01' };
    mocks.query.mockRejectedValue(error);
    await expect(new ControlDatabase('test').read('SELECT missing')).rejects.toBe(error);
    expect(warehouseTransient(new WarehouseConflict('warehouse-operation-conflict'))).toBe(false);
    expect(warehouseTransient(new WarehouseConflict('warehouse-authority-frozen'))).toBe(true);
  });
});

describe('pool acquisition and transaction connection failures', () => {
  it.each([
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
  ])('classifies the exact driver timeout %s', async message => {
    mocks.query.mockRejectedValue(new Error(message));
    await expect(new ControlDatabase('test').read('SELECT 1')).rejects.toMatchObject({
      code: 'warehouse-control-unavailable',
    });
  });
  it('does not mistake arbitrary query text for a connection timeout', async () => {
    const error = new Error('private query containing timeout exceeded when trying to connect');
    mocks.query.mockRejectedValue(error);
    await expect(new ControlDatabase('test').read('SELECT 1')).rejects.toBe(error);
  });
  it('classifies connection acquisition before BEGIN', async () => {
    mocks.connect.mockRejectedValue(new Error('Connection terminated due to connection timeout'));
    const work = vi.fn();
    await expect(new ControlDatabase('test').transaction(work)).rejects.toMatchObject({
      code: 'warehouse-control-unavailable',
    });
    expect(work).not.toHaveBeenCalled();
  });
  it('keeps lost COMMIT replies uncertain, even for a connection failure', async () => {
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'COMMIT')
          throw Object.assign(new Error('private detail'), { code: 'ECONNRESET' });
        return { rows: [] };
      }),
      on: vi.fn(),
      off: vi.fn(),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);
    await expect(new ControlDatabase('test').transaction(async () => 42)).rejects.toThrow(
      'warehouse-control-commit-uncertain',
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
