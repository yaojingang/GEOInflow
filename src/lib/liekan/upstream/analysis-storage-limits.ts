type StorageEnvironment = Record<string, string | undefined>;
const mib = 1024 ** 2;

/** Read once per process; web and workers receive the same installation settings. */
export function readAnalysisStorageLimits(env: StorageEnvironment = process.env) {
  const read = (name: keyof StorageEnvironment, fallback: number, minimum: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback * mib;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value * mib) || value < minimum)
      throw new Error(`Invalid ${name}: expected an integer MiB capacity of at least ${minimum}`);
    return value * mib;
  };
  // Keep the fixed result reserves below the 10% recovery headroom.
  const siteLimit = read('LIEKAN_ANALYSIS_SITE_LIMIT_MIB', 1024, 512);
  const globalLimit = read('LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB', 8192, 2048);
  if (globalLimit < siteLimit)
    throw new Error('Invalid LIEKAN_ANALYSIS_GLOBAL_LIMIT_MIB: must cover the site capacity');
  return { siteLimit, globalLimit };
}

export const { siteLimit: ANALYSIS_SITE_LIMIT, globalLimit: ANALYSIS_GLOBAL_LIMIT } =
  readAnalysisStorageLimits();
