import { LiekanError } from './errors';

export function decodeWarehouseLogCursor(cursor: string, scope: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[2] !== scope ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(value[0]) ||
      !/^[a-f0-9]{64}$/.test(value[1])
    )
      throw new Error();
    return [value[0], value[1]];
  } catch {
    throw new LiekanError('日志游标已失效，请重新读取', 409, 'history-repair-cursor-conflict');
  }
}
