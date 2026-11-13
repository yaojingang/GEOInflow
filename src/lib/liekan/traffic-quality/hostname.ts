export function hasUrlAuthority(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/\\]/i.test(value.trim());
}

export function normalizeCollectionHostname(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const fullUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const protocolRelative = trimmed.startsWith('//');
  if ((fullUrl || protocolRelative) && !hasUrlAuthority(trimmed)) return null;
  if (/^[/\\]/.test(trimmed) && !protocolRelative) return null;
  try {
    const url = new URL(
      protocolRelative ? `https:${trimmed}` : fullUrl ? trimmed : `https://${trimmed}`,
    );
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (
      !fullUrl &&
      !protocolRelative &&
      (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    )
      return null;
    const hostname = url.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');
    if (!hostname || hostname.length > 253) return null;
    return hostname;
  } catch {
    return null;
  }
}
