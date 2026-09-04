// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test runner. Serves the repository, opens each test page in headless Chrome
// and waits for the page to POST its results back to /result.
//
//   node tests/run.mjs             run every page in tests/
//   node tests/run.mjs pipeline    run tests/pipeline.html only
//
// Set CHROME to override browser discovery.
//
// Results come back over HTTP rather than being scraped out of the DOM: the
// pages await worker round-trips, and Chrome's --dump-dom snapshots the page
// before those resolve.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testsDir, '..');
const PORT = 8199;
const TIMEOUT_MS = 60_000;

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME to the executable.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let deliver = null;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (req.method === 'POST' && path === '/result') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(204).end();
    deliver?.(Buffer.concat(chunks).toString('utf8'));
    return;
  }

  // A static host answers / with index.html; the server has to as well, or
  // the precache test reports the app's own start_url as broken.
  const wanted = path.endsWith('/') ? `${path}index.html` : path;
  const rel = normalize(wanted).replace(/^[\\/]+/, '');
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

function runPage(name) {
  return new Promise((done) => {
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // a synthetic camera, so the webcam source can be exercised headlessly
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `http://127.0.0.1:${PORT}/tests/${name}.html`,
    ], { stdio: 'ignore' });

    const finish = (text, ok) => {
      clearTimeout(timer);
      deliver = null;
      try { child.kill(); } catch { /* already gone */ }
      done({ text, ok });
    };

    const timer = setTimeout(() => finish('TIMEOUT: the page never posted a result', false), TIMEOUT_MS);
    child.on('error', (e) => finish(`could not launch the browser: ${e.message}`, false));
    deliver = (text) => finish(text, !/\bFAIL\b|THREW|ERROR|REJECTION|TIMEOUT/.test(text));
  });
}

const requested = process.argv.slice(2);
const pages = requested.length
  ? requested
  : (await readdir(testsDir)).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();

server.listen(PORT, '127.0.0.1');

let failures = 0;
for (const name of pages) {
  console.log(`\n=== ${name} ===`);
  const { text, ok } = await runPage(name);
  console.log(text);
  if (!ok) failures++;
}

server.close();
console.log(failures ? `\n${failures} of ${pages.length} test pages failed.` : `\n${pages.length} test pages passed.`);
process.exit(failures ? 1 : 0);
