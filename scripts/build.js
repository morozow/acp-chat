import * as esbuild from 'esbuild';
import { execSync } from 'child_process';

const shared = {
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outdir: 'dist',
  minify: true,
  treeShaking: true,
  sourcemap: false,
  external: [],
  banner: {
    js: '#!/usr/bin/env node',
  },
};

// Build with esbuild
await esbuild.build({
  ...shared,
  banner: undefined, // No banner for index.js
  entryPoints: ['src/index.ts'],
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/cli.ts'],
});

// Generate type declarations with tsc
execSync('tsc --emitDeclarationOnly --declaration', { stdio: 'inherit' });

console.log('Build complete!');
