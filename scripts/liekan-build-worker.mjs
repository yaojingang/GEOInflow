import { build } from 'esbuild';
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
  entryPoints: ['src/liekan-worker/warehouse.ts'],
  outfile: 'dist/liekan-warehouse-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
await build({
  entryPoints: ['src/liekan-worker/warehouse-maintenance.ts'],
  outfile: 'dist/liekan-maintenance-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
await build({
  entryPoints: ['scripts/liekan-warehouse.ts'],
  outfile: 'dist/liekan-warehouse-command.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
await build({
  entryPoints: ['src/liekan-worker/warehouse-transition.ts'],
  outfile: 'dist/liekan-transition-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
await build({
  entryPoints: ['src/liekan-worker/main.ts'],
  outfile: 'dist/liekan-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
await build({
  entryPoints: ['src/liekan-worker/analytics.ts'],
  outfile: 'dist/liekan-analytics-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'prisma-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@\/generated\/prisma\/client$/ }, () => ({
          path: '../generated/prisma/client.js',
          external: true,
        }));
      },
    },
  ],
});
