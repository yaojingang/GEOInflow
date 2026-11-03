import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Build from the source factory so release checks detect catalog/fixture drift. */
export async function bundledDemoCatalog() {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL('../src/lib/liekan/crawlers/catalog-seed.ts', import.meta.url)),
    ],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    write: false,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return module.exports.getBundledPublishedCatalog();
}
