import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(project, 'dist');
if (dist !== join(project, 'dist') || !dist.startsWith(project + sep)) {
  throw new Error('Invalid build destination');
}
await rm(dist, { recursive: true, force: true });
const destination = join(dist, 'roomly');
await mkdir(destination, { recursive: true });
const files = ['index.html', 'style.css', 'tablet.css', 'holidays.js', 'core.js', 'app.js', 'fullscreen.js', 'config.js', 'google.js', 'setup.html', 'auth.html', 'access.css', 'access.js', 'admin.html', 'admin.js', 'privacy.html', 'about.html', 'manifest.webmanifest', 'pwa.js', 'pwa.css', 'sw.js', 'offline.html', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
for (const file of files) await copyFile(join(project, file), join(destination, file));
await writeFile(join(dist, '_headers'), `/roomly/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Cache-Control: no-cache
`);
const published = await readdir(destination);
if (published.length !== files.length || published.some(file => !files.includes(file))) {
  throw new Error('Unexpected file in public build');
}
console.log(`Built ${files.length} public assets under /roomly/`);
