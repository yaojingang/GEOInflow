const cookieName = 'liekan_export_session';

export function warehouseExportCredential(request: Request) {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${cookieName}=`));
  if (!cookie) return undefined;
  try {
    return decodeURIComponent(cookie.slice(cookieName.length + 1)) || undefined;
  } catch {
    return undefined;
  }
}

export function warehouseExportCookie(request: Request, credential?: string) {
  const url = new URL(request.url);
  const boundary = url.pathname.lastIndexOf('/api/');
  if (boundary < 0) throw new Error('warehouse-export-cookie-path-invalid');
  // Auth verification must receive this cookie so an SSO identity change can
  // clear it. Only the export download route may use it for authentication.
  const path = `${url.pathname.slice(0, boundary)}/api`;
  const secure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  // This is a browser-session cookie. Logout and every login attempt expire the
  // known path; artifact-specific cookies from older builds are never accepted.
  return `${cookieName}=${credential ? encodeURIComponent(credential) : ''}; Path=${path}; HttpOnly; SameSite=Strict${credential ? '' : '; Max-Age=0'}${secure ? '; Secure' : ''}`;
}

export function clearWarehouseExportCookie(request: Request, response: Response) {
  response.headers.append('Set-Cookie', warehouseExportCookie(request));
  return response;
}

export function authenticateWarehouseExport(request: Request) {
  // An explicit invalid/partial credential must not fall back to another identity.
  if (request.headers.has('authorization')) return request;
  const credential = warehouseExportCredential(request);
  if (!credential) return request;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${credential}`);
  return new Request(request, { headers });
}
