import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const fromNext = createRequire(require.resolve('next/package.json'));
const postcss = fromNext('postcss');
const localByDefault = require('next/dist/compiled/postcss-modules-local-by-default');
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '').trim();

for (const name of ['Features', 'Navigation']) {
  test(`${name} keeps its existing global selectors and declarations in Webpack pure mode`, async () => {
    const file = `src/styles/liekan/${name}.module.css`;
    const css = await readFile(file, 'utf8');
    const original = css.replace(/\/\* cssmodules-pure-(?:no-check|ignore) \*\/\n/g, '');
    const transform = (source, mode) =>
      postcss([localByDefault({ mode })]).process(source, { from: file });

    await assert.rejects(transform(original, 'pure'), /is not pure/);
    const [compatible, existing] = await Promise.all([
      transform(css, 'pure'),
      transform(original, 'local'),
    ]);
    assert.equal(withoutComments(compatible.css), withoutComments(existing.css));
  });
}

for (const file of [
  'src/styles/liekan/AiChatHome.module.css',
  'src/components/common/Badge.module.css',
]) {
  test(`${file} retains strict pure-mode validation`, async () => {
    const css = await readFile(file, 'utf8');
    assert.doesNotMatch(css, /cssmodules-pure-(?:no-check|ignore)/);
    await postcss([localByDefault({ mode: 'pure' })]).process(css, { from: file });
  });
}
