import { build } from 'esbuild';

const prismaExternalPlugin = {
  name: 'prisma-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
      path: '../generated/prisma/client.js',
      external: true,
    }));
  },
};

const commonBanner = {
  js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
};

await build({
  entryPoints: ['scripts/liekan-warehouse-start-check.ts'],
  outfile: 'dist/liekan-warehouse-start-check.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
});

await build({
  entryPoints: ['scripts/liekan-warehouse-v2.mts'],
  outfile: 'dist/liekan-warehouse-v2.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: commonBanner,
  plugins: [prismaExternalPlugin],
});

await build({
  entryPoints: ['src/liekan-worker/main.ts'],
  outfile: 'dist/liekan-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: commonBanner,
  plugins: [prismaExternalPlugin],
});

await build({
  entryPoints: ['src/liekan-worker/analytics.ts'],
  outfile: 'dist/liekan-analytics-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: commonBanner,
  plugins: [prismaExternalPlugin],
});
