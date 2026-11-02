import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const entry = process.argv[2] || 'src/clean.js';
const out = process.argv[3] || 'dist/clean.js';
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: out,
  define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis' },
  inject: ['src/shims.js'],
  alias: {
    buffer: require.resolve('buffer/'),
    os: require.resolve('os-browserify/browser'),
    path: require.resolve('path-browserify'),
    util: require.resolve('util/'),
    events: require.resolve('events/'),
  },
  plugins: [{
    // GramJS ships a browser implementation of its crypto: use it instead of Node's
    name: 'gramjs-browser',
    setup(b) {
      b.onResolve({ filter: /CryptoFile$/ }, () => ({ path: 'CryptoFile', namespace: 'cryptofile' }));
      b.onLoad({ filter: /.*/, namespace: 'cryptofile' }, () => ({
        contents: `module.exports = { __esModule: true, default: require(${JSON.stringify(require.resolve('telegram/crypto/crypto.js'))}) };`,
        loader: 'js', resolveDir: process.cwd(),
      }));
      b.onResolve({ filter: /^websocket$/ }, () => ({ path: 'websocket', namespace: 'ws' }));
      b.onLoad({ filter: /.*/, namespace: 'ws' }, () => ({ contents: 'module.exports = { w3cwebsocket: globalThis.WebSocket }', loader: 'js' }));
      b.onResolve({ filter: /^(fs|net|socks|node-localstorage|crypto)$/ }, (a) => ({ path: a.path, namespace: 'empty' }));
      b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'module.exports = {}', loader: 'js' }));
    },
  }],
  logLevel: 'warning',
});
console.log('built', out);
// the pages and files that need no build go next to the bundle
import fs from 'node:fs';
if (entry === 'src/clean.js') fs.cpSync('public', 'dist', { recursive: true });
