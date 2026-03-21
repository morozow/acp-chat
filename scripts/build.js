import * as esbuild from 'esbuild';
import { execSync } from 'child_process';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outdir: 'dist',
  minify: true,
  treeShaking: true,
  sourcemap: false,
  drop: ['debugger'],
  mangleProps: /^_/,
  charset: 'utf8',
};

// Build index.js (library)
await esbuild.build({
  ...shared,
  entryPoints: ['src/index.ts'],
});

// Build cli.js (shebang already in source)
await esbuild.build({
  ...shared,
  entryPoints: ['src/cli.ts'],
});

// Generate type declarations with tsc
execSync('tsc --emitDeclarationOnly --declaration', { stdio: 'inherit' });

console.log('Build complete!');
