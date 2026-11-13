import { sanitizeTrackerUrl } from '../tracker/privacy';

const urlField =
  /^(?:url|href|referrer|referer|src|action|formaction|poster|background|cite|longdesc|xlink:href)$/i;
const resourceField = /^(?:src|poster|background)$/i;

function sanitizeResourceUrl(value: string): string {
  // Embedded images and recorded blob references have no navigational URL path.
  return /^(?:data|blob):/i.test(value) ? value : sanitizeTrackerUrl(value);
}

function decodeCssUrl(value: string): string {
  return value.replace(/\\([a-f\d]{1,6}\s?|[^\n\r\f])/gi, (_match, escaped: string) => {
    const hex = escaped.trim();
    if (!/^[a-f\d]{1,6}$/i.test(hex)) return escaped;
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}

function sanitizeCss(value: string): string {
  // Advance past every scanned byte, including malformed/unterminated tokens.
  // A regex retry at each nested `url(` can block collection on a small request.
  const start = /\/\*|["']|url\(|@import\s+/gi;
  const quotedEnd = (from: number, quote: string) => {
    let end = from;
    while (end < value.length) {
      if (value[end] === '\\') {
        end += value[end + 1] === '\r' && value[end + 2] === '\n' ? 3 : 2;
      } else if (value[end] === quote || /[\n\r\f]/.test(value[end])) break;
      else end++;
    }
    return end;
  };
  const chunks: string[] = [];
  let copied = 0;
  for (let match = start.exec(value); match; match = start.exec(value)) {
    if (match[0] === '/*') {
      const end = value.indexOf('*/', start.lastIndex);
      if (end < 0) break;
      start.lastIndex = end + 2;
      continue;
    }
    if (match[0] === '"' || match[0] === "'") {
      start.lastIndex = quotedEnd(start.lastIndex, match[0]) + 1;
      continue;
    }
    const isUrl = match[0].toLowerCase().startsWith('url(');
    let cursor = start.lastIndex;
    while (cursor < value.length && /\s/.test(value[cursor])) cursor++;
    const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor++] : '';
    if (!isUrl && !quote) continue; // @import url(...) is handled by the next token.
    const from = cursor;
    if (quote) cursor = quotedEnd(cursor, quote);
    else
      while (cursor < value.length) {
        if (value[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (value[cursor] === ')') break;
        cursor++;
      }
    if (cursor >= value.length) break;
    if (quote && value[cursor] !== quote) {
      start.lastIndex = cursor + 1;
      continue;
    }
    const raw = value.slice(from, cursor);
    if (quote) cursor++;
    if (isUrl) {
      while (cursor < value.length && /\s/.test(value[cursor])) cursor++;
      if (value[cursor] !== ')') {
        start.lastIndex = cursor;
        continue;
      }
      cursor++;
    }
    start.lastIndex = cursor;
    const decoded = decodeCssUrl(raw.trim());
    const sanitized = sanitizeResourceUrl(decoded);
    if (decoded !== sanitized) {
      chunks.push(
        value.slice(copied, match.index),
        isUrl ? 'url(' : '@import ',
        JSON.stringify(sanitized),
        isUrl ? ')' : '',
      );
      copied = cursor;
    }
  }
  chunks.push(value.slice(copied));
  return chunks.join('');
}

/** Copy rrweb events before buffering/fragmentation, retaining IDs, geometry and ordering. */
export function sanitizeReplayEvent(event: any): any {
  const visit = (value: any, key = '', styleText = false, cssValue = false): any => {
    if (typeof value === 'string') {
      if (
        cssValue ||
        /^(?:style|_cssText|cssText|rule|rules)$/.test(key) ||
        (key === 'textContent' && styleText)
      )
        return sanitizeCss(value);
      if (urlField.test(key)) {
        return resourceField.test(key) ? sanitizeResourceUrl(value) : sanitizeTrackerUrl(value);
      }
      if (/^(?:srcset|imagesrcset)$/i.test(key)) {
        return value.replace(/\S+/g, token => {
          const url = token.replace(/,+$/, '');
          return sanitizeResourceUrl(url) + token.slice(url.length);
        });
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => visit(item, key, styleText, cssValue));
    if (!value || typeof value !== 'object') return value;
    const isStyle =
      styleText || (typeof value.tagName === 'string' && value.tagName.toLowerCase() === 'style');
    const isCss = cssValue || key === 'style' || value.source === 8 || value.source === 13;
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, visit(entry, name, isStyle, isCss)]),
    );
  };
  // Legacy transport fragments contain only part of a JSON string. Keep their
  // protocol intact; the updated recorder sanitizes before generating fragments.
  return visit(event);
}

/** Sanitize complete fragment groups without changing their transport IDs or counts. */
export function sanitizeReplayEvents(events: any[]): any[] {
  const clean = events.map(sanitizeReplayEvent);
  const groups = new Map<string, number[]>();
  for (const [index, event] of clean.entries()) {
    const data = event?.data;
    if (
      event?.type !== 'umami:rrweb-event-fragment' ||
      typeof data?.id !== 'string' ||
      typeof data.value !== 'string' ||
      !Number.isInteger(data.total) ||
      data.total < 1 ||
      !Number.isInteger(data.index) ||
      data.index < 0 ||
      data.index >= data.total
    )
      continue;
    const group = groups.get(data.id) || [];
    group.push(index);
    groups.set(data.id, group);
  }
  for (const group of groups.values()) {
    const total = clean[group[0]].data.total;
    if (group.length !== total || group.some(index => clean[index].data.total !== total)) continue;
    const ordered = [...group].sort((a, b) => clean[a].data.index - clean[b].data.index);
    if (ordered.some((index, position) => clean[index].data.index !== position)) continue;
    try {
      const original = JSON.parse(ordered.map(index => clean[index].data.value).join(''));
      const sanitized = JSON.stringify(sanitizeReplayEvent(original));
      let offset = 0;
      for (const [position, index] of ordered.entries()) {
        const end =
          position === total - 1 ? sanitized.length : offset + clean[index].data.value.length;
        clean[index].data.value = sanitized.slice(offset, end);
        offset = end;
      }
    } catch {
      // Keep incomplete or malformed legacy fragments intact for existing readers.
    }
  }
  return clean;
}
