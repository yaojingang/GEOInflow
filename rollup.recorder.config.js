import 'dotenv/config';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/recorder/index.js',
  output: {
    file: 'public/recorder.js',
    format: 'iife',
  },
  plugins: [
    typescript({
      tsconfig: false,
      include: ['src/recorder/privacy.ts', 'src/tracker/privacy.ts'],
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
    }),
    resolve({ browser: true, extensions: ['.js', '.ts'] }),
    commonjs(),
    replace({
      __COLLECT_API_HOST__: process.env.COLLECT_API_HOST || '',
      delimiters: ['', ''],
      preventAssignment: true,
    }),
    terser({ compress: { evaluate: false } }),
  ],
};
