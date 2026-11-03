// ClickHouse 25.8 applies its 128 KiB HTTP form-field limit before query
// settings. Split transport fields without dropping values or changing types.
const partBytes = 24000;
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) * 2 + 4;
function stringParts(value: string) {
  const parts: string[] = [];
  let current = '',
    bytes = 0;
  for (const c of value) {
    const n = Buffer.byteLength(c) * 2 + 2;
    if (bytes + n > partBytes && current) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += c;
    bytes += n;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}
export function prepareQueryParameters<
  T extends {
    query: string;
    query_params?: Record<string, unknown>;
    use_multipart_params?: boolean;
    use_multipart_params_auto?: boolean;
  },
>(input: T): T {
  if (!input.query_params) return input;
  const params = { ...input.query_params },
    split = new Map<string, string>();
  let changed = false,
    index = 0;
  const bind = (value: unknown, type: string) => {
    let key: string;
    do {
      key = `wh_chunk_${index++}`;
    } while (key in params);
    params[key] = value;
    return `{${key}:${type}}`;
  };
  const string = (v: string) =>
    `concat(${stringParts(v)
      .map(s => bind(s, 'String'))
      .join(',')})`;
  const query = input.query.replace(
    /\{([a-zA-Z_][a-zA-Z_0-9]*):([^{}]+)\}/g,
    (placeholder, name: string, type: string) => {
      const value = input.query_params[name];
      if (value === undefined || size(value) <= partBytes) return placeholder;
      const cache = `${name}:${type}`;
      if (split.has(cache)) return split.get(cache);
      let expression: string;
      if (Array.isArray(value) && /^Array\(.+\)$/.test(type)) {
        const parts: string[] = [];
        let batch: unknown[] = [],
          bytes = 0;
        const flush = () => {
          if (batch.length) {
            parts.push(bind(batch, type));
            batch = [];
            bytes = 0;
          }
        };
        for (const item of value) {
          const n = size(item);
          if (n > partBytes) {
            flush();
            if (typeof item !== 'string' || !/^Array\((?:Nullable\()?String\)?\)$/.test(type))
              throw new Error('warehouse-query-parameter-type-too-large');
            parts.push(`CAST([${string(item)}] AS ${type})`);
          } else {
            if (bytes + n > partBytes) flush();
            batch.push(item);
            bytes += n;
          }
        }
        flush();
        expression = `arrayConcat(${parts.join(',')})`;
      } else if (typeof value === 'string' && ['String', 'Nullable(String)'].includes(type))
        expression = `CAST(${string(value)} AS ${type})`;
      else throw new Error('warehouse-query-parameter-type-too-large');
      split.set(cache, expression);
      changed = true;
      return expression;
    },
  );
  if (!changed) return input;
  for (const name of Object.keys(input.query_params))
    if (!query.includes(`{${name}:`)) delete params[name];
  // Long SQL remains a raw POST body; ordinary batch queries use multipart
  // fields after splitting, avoiding the aggregate URL-length limit as well.
  const multipart = Buffer.byteLength(query) < 96000;
  return {
    ...input,
    query,
    query_params: params,
    use_multipart_params: multipart,
    use_multipart_params_auto: false,
  };
}
