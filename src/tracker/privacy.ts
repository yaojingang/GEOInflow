const privateParameter =
  /^(?:password|passwd|pwd|secret|token|access_token|refresh_token|id_token|auth_token|session_token|api[_-]?key|authorization|cookie|code|email|e-mail|phone|mobile|reset[_-]?(?:token|code)|invite[_-]?(?:token|code))$/i;
const privateValue =
  /(?:\bBearer\s+\S+|\b(?:sk|pk|sess|token)-[a-z0-9_-]{12,}|[^\s@/]+@[^\s@/]+\.[a-z]{2,})/i;
const redacted = '[redacted]';

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
  const url = new URL(value, base);
  url.username = '';
  url.password = '';
  const query = new URLSearchParams(url.search);
  if (sanitizeParameters(query)) url.search = query.toString();
  if (url.hash) {
    const fragment = url.hash.slice(1);
    const separator = fragment.indexOf('?');
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
    return (
      path.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/]*@/i, '$1') +
      (original.search === sanitized.search ? query : sanitized.search) +
      (original.hash === sanitized.hash ? fragment : sanitized.hash)
    );
  } catch {
    return value;
  }
}
