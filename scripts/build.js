// Copyright 2026 Raman Marozau <raman@worktif.com>
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
