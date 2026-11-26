import { expect, test } from 'vitest';
import {
  authenticateWarehouseExport,
  clearWarehouseExportCookie,
  warehouseExportCookie,
} from './warehouse-export-cookie';

test('exports use one browser-session credential at the same API path across files', () => {
  const first = new Request('https://example.com/geo/api/liekan/websites/one/exports');
  const second = new Request('https://example.com/geo/api/liekan/websites/two/exports');
  const cookie = warehouseExportCookie(first, 'current-session');
  expect(cookie).toBe(
    'liekan_export_session=current-session; Path=/geo/api; HttpOnly; SameSite=Strict; Secure',
  );
  expect(warehouseExportCookie(second, 'current-session')).toBe(cookie);
  expect(cookie).not.toContain('Max-Age=86400');
});

test('logout expires exactly the export credential without changing locale cookies', () => {
  const request = new Request('http://localhost/api/auth/logout');
  const response = new Response(null, {
    headers: { 'Set-Cookie': 'liekan.locale=en-US; Path=/; SameSite=Lax' },
  });
  clearWarehouseExportCookie(request, response);
  expect(response.headers.getSetCookie()).toEqual([
    'liekan.locale=en-US; Path=/; SameSite=Lax',
    'liekan_export_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0',
  ]);
});

test('an empty explicit authorization header cannot select an older cookie identity', () => {
  const request = new Request('http://localhost/api/liekan/websites/one/exports/file', {
    headers: { authorization: '', cookie: 'liekan_export_session=old-session' },
  });
  expect(authenticateWarehouseExport(request)).toBe(request);
});

test('malformed export cookies never produce an authorization credential', () => {
  const request = new Request('http://localhost/api/liekan/websites/one/exports/file', {
    headers: { cookie: 'liekan_export_session=%ZZ' },
  });
  expect(authenticateWarehouseExport(request).headers.has('authorization')).toBe(false);
});
