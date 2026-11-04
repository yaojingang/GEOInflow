// A per-query resource budget, independent of retained data or derived storage.
// The default deployment gives CH 4 GiB; ordinary reports and exports each have
// one admission slot. Operators must size their combined budgets with ingestion
// and server caches before raising concurrency.
export function warehouseReadResources(value = '1073741824') {
  const bytes = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 67108864)
    throw new Error('warehouse-query-memory-invalid');
  return {
    max_memory_usage: String(bytes),
    // Keep headroom for merging spilled aggregate/sort blocks. Fixed 128/64 MiB
    // caps caused hundreds of tiny spills even with a 1 GiB query budget. CH's
    // available-memory ratio limits remain active as an additional safeguard.
    max_bytes_before_external_group_by: String(Math.floor(bytes / 2)),
    max_bytes_before_external_sort: String(Math.floor(bytes / 2)),
    max_bytes_before_external_join: String(Math.floor(bytes / 4)),
  };
}
