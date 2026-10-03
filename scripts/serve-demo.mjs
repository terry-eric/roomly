import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemo, DEMO_CSP, DEMO_FILES, projectRoot } from './build-demo.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };

export function createDemoServer({ rootDir = join(projectRoot, 'demo-dist'), basePath = '/' } = {}) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('Invalid demo base path');
  const root = resolve(rootDir), allowed = new Set(DEMO_FILES.filter(name => !name.startsWith('.')));
  return createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': DEMO_CSP };
    const plain = (status, text) => { response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); response.end(request.method === 'HEAD' ? '' : text); };
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return plain(405, 'Static demo: read-only files.'); }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { return plain(400, 'Invalid path.'); }
    if (!pathname.startsWith(basePath)) return plain(404, 'Not found.');
    const name = pathname.slice(basePath.length) || 'index.html';
    if (!allowed.has(name)) return plain(404, 'Not found.');
    try {
      const content = await readFile(join(root, name));
      response.writeHead(200, { ...headers, 'Content-Type': types[extname(name)], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { plain(404, 'Not found.'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = { port: 4173, host: '127.0.0.1', basePath: '/', build: true };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-build') options.build = false;
    else if (flag === '--port') options.port = Number(args[++i]);
    else if (flag === '--host') options.host = args[++i];
    else if (flag === '--base-path') options.basePath = args[++i];
    else throw new Error(`Unknown demo option: ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !options.host) throw new Error('Invalid demo host or port');
  if (options.build) await buildDemo();
  const server = createDemoServer({ basePath: options.basePath });
  server.listen(options.port, options.host, () => console.log(`Roomly fictional-data demo: http://${options.host}:${options.port}${options.basePath}`));
  server.on('error', error => { console.error(`Demo server failed: ${error.code || 'server_error'}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
