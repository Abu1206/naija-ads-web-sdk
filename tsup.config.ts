import { defineConfig } from 'tsup';

// Two artifacts:
//  - dist/index.js       ESM, for bundlers (Next.js, Vite, webpack)
//  - dist/index.global.js IIFE exposing window.NaijaAds, for plain <script> tags
// Zero runtime dependencies is a hard rule (AGENTS.md §2) — tsup bundles nothing else in.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  globalName: 'NaijaAds',
  outExtension: (ctx) => ({ js: ctx.format === 'iife' ? '.global.js' : '.js' }),
  dts: true,
  sourcemap: true,
  minify: true,
  clean: true,
  target: 'es2020',
});
