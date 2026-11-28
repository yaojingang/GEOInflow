const privateParameter =
  /^(?:password|passwd|pwd|secret|token|access_token|refresh_token|id_token|auth_token|session_token|api[_-]?key|authorization|cookie|code|email|e-mail|phone|mobile|reset[_-]?(?:token|code)|invite[_-]?(?:token|code))$/i;
const privateValue =
  /(?:\bBearer\s+\S+|\b(?:sk|pk|sess|token)-[a-z0-9_-]{12,}|(?:^|[\s@/])[^\s@/]+@[^\s@/]+\.[a-z]{2,})/i;
const redacted = '[redacted]';
const privatePathName =
  /^(?:password|passwd|pwd|secret|token|access_token|refresh_token|id_token|auth_token|session_token|api[_-]?key|authorization|cookie|reset[_-]?(?:token|code)|invite[_-]?(?:token|code)|reset|password[_-]?reset|reset[_-]?password|verify|verify[_-]?email|email[_-]?verification|invite|share|s)$/i;

function sanitizePath(path: string): string {
  const parents: boolean[] = [];
  return path
    .split(/([/\\])/)
    .map(segment => {
      if (!segment || /^[/\\]$/.test(segment)) return segment;
      let decoded = segment.replace(/[\t\n\r]/g, '');
      // Inspect encoded names/separators without rewriting ordinary route bytes.
      for (let depth = 0; depth < 3; depth++) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      let sensitive = false;
      for (const part of decoded.split(/[/\\]/)) {
        if (!part || part === '.') continue;
        if (part === '..') {
          parents.pop();
          continue;
        }
        sensitive ||= parents.at(-1) === true || privateValue.test(part);
        // Query names such as code/email/phone are also ordinary page directories.
        parents.push(privatePathName.test(part));
      }
      return sensitive ? redacted : segment;
    })
    .join('');
}

function sanitizeParameters(parameters: URLSearchParams) {
  const entries = [...parameters];
  if (!entries.some(([key, value]) => privateParameter.test(key) || privateValue.test(value)))
    return false;
  // Rebuild duplicates without retaining a second copy of a sensitive value.
  const clean = entries.map(([key, value]) => [
    key,
    privateParameter.test(key) || privateValue.test(value) ? redacted : value,
  ]);
  for (const key of new Set(parameters.keys())) parameters.delete(key);
  for (const [key, value] of clean) parameters.append(key, value);
  return true;
}

/** Shared by the browser tracker and collector; campaign parameters remain available. */
export function sanitizeCollectionUrl(value: string, base?: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    // Native URL errors retain `input`; the collector logs serialized errors.
    throw new Error('Invalid collection URL');
  }
  url.username = '';
  url.password = '';
  // Redact known secret routes/values, not identifiers based only on their shape:
  // ordinary UUID/hex content IDs must remain distinct in reports and heatmaps.
  // This function never supplies navigation identity.
  url.pathname = sanitizePath(url.pathname);
  const query = new URLSearchParams(url.search);
  if (sanitizeParameters(query)) url.search = query.toString();
  if (url.hash) {
    const fragment = url.hash.slice(1);
    const separator = fragment.indexOf('?');
    const route = /^!?\//.test(fragment);
    if (route) {
      const path = separator >= 0 ? fragment.slice(0, separator) : fragment;
      const query = separator >= 0 ? fragment.slice(separator + 1) : '';
      const parameters = new URLSearchParams(query);
      const cleanQuery = sanitizeParameters(parameters) ? parameters.toString() : query;
      url.hash = sanitizePath(path) + (separator >= 0 ? `?${cleanQuery}` : '');
      return url.href;
    }
    const prefix = separator >= 0 ? fragment.slice(0, separator + 1) : '';
    const parameters = new URLSearchParams(
      separator >= 0 ? fragment.slice(separator + 1) : fragment,
    );
    if (sanitizeParameters(parameters)) url.hash = prefix + parameters.toString();
    else if (privateValue.test(fragment)) url.hash = redacted;
  }
  return url.href;
}

/** Preserve explicit tracker paths and exclusions while redacting outbound values. */
export function sanitizeTrackerUrl(value: string): string {
  try {
    const base = 'https://privacy.invalid/';
    const original = new URL(value, base);
    const sanitized = new URL(sanitizeCollectionUrl(value, base));
    if (original.username || original.password) return sanitized.href;
    const hashIndex = value.indexOf('#');
    const beforeHash = hashIndex < 0 ? value : value.slice(0, hashIndex);
    const queryIndex = beforeHash.indexOf('?');
    const path = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
    const query = queryIndex < 0 ? '' : beforeHash.slice(queryIndex);
    const fragment = hashIndex < 0 ? '' : value.slice(hashIndex);
    // Keep authorities out of path matching, including protocol-relative URLs.
    const authority =
      // biome-ignore lint/suspicious/noControlCharactersInRegex: URL parsing accepts leading C0 controls.
      path.match(/^[\s\u0000-\u0020]*(?:[a-z][a-z\d+.-]*:)?[/\\]{2}[^/\\]*/i)?.[0] || '';
    return (
      authority +
      sanitizePath(path.slice(authority.length)) +
      (original.search === sanitized.search ? query : sanitized.search) +
      (original.hash === sanitized.hash ? fragment : sanitized.hash)
    );
  } catch {
    // An invalid URL cannot be checked safely; never send the unchecked value.
    return '';
  }
}
