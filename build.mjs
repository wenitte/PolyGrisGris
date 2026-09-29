import { context, build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

const shared = { bundle: true, target: 'chrome111', logLevel: 'info', sourcemap: false };
const jobs = [
  { entryPoints: ['src/background.js'], outfile: 'dist/background.js', format: 'esm' },
  { entryPoints: ['src/content.js'], outfile: 'dist/content.js', format: 'iife' },
  { entryPoints: ['src/inpage.js'], outfile: 'dist/inpage.js', format: 'iife' },
  { entryPoints: ['src/popup.js'], outfile: 'dist/popup.js', format: 'iife' },
];

for (const job of jobs) {
  const opts = { ...shared, ...job };
  if (watch) await (await context(opts)).watch();
  else await build(opts);
}
if (!watch) console.log('\nBuilt to ./dist — load that folder via chrome://extensions → Load unpacked.');
