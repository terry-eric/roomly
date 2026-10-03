import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_FILES = Object.freeze(['index.html', 'style.css', 'tablet.css', 'access.css', 'demo.css', 'holidays.js', 'core.js', 'app.js', 'fullscreen.js', 'demo-fixtures.js', 'demo-bootstrap.js', 'use-cases.svg', 'calendar-flow.svg', '.nojekyll']);
export const DEMO_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('Demo template no longer matches the board; update the build transform');
  return source.replace(from, to);
}

function demoHTML(source) {
  let html = replaceOnce(source, '<title>Roomly — 會議室預約</title>', '<title>Roomly — 虛構資料互動示範</title>');
  html = html.replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]*>/g, '')
    .replace(/\s*<meta name="apple-mobile-web-app-[^"]+"[^>]*>/g, '')
    .replace(/\s*<link rel="stylesheet" href="pwa\.css">/g, '')
    .replace(/\s*<script src="(?:pwa|access|config|google)\.js"[^>]*><\/script>/g, '')
    .replace(/\s*<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/g, '')
    .replace(/<a id="(?:admin-link|settings-admin-link)"[^>]*>.*?<\/a>/g, '')
    .replace(/<div class="access-controls">.*?<\/div>/g, '');
  html = replaceOnce(html, '<meta name="viewport" content="width=device-width, initial-scale=1">', `<meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}">\n  <meta name="referrer" content="no-referrer">`);
  html = replaceOnce(html, '<body data-page="board">', '<body data-page="board" data-demo="true">\n<div class="demo-banner" role="note"><strong>互動示範 · 虛構資料</strong><span>會議、人員及會議室均為虛構，不會登入或連接真實日曆。</span></div>');
  html = replaceOnce(html, '<link rel="stylesheet" href="access.css">', '<link rel="stylesheet" href="access.css">\n  <link rel="stylesheet" href="demo.css">');
  html = replaceOnce(html, '<button class="primary" id="google-start">同步</button>', '<button class="primary" id="google-start" type="button">重載範例</button>');
  html = replaceOnce(html, '<button class="primary" id="new-booking">＋ 預約</button>', '<button class="primary" id="new-booking" hidden disabled>示範版不建立預約</button>');
  html = replaceOnce(html, '<button class="nav-item" data-view="import"><span>⚙</span>設定</button>', '<button class="nav-item" data-view="import"><span>ⓘ</span>示範說明</button>');
  html = replaceOnce(html, '<div class="page-heading"><h1>設定</h1></div>', '<div class="page-heading"><h1>示範說明</h1></div>');
  html = replaceOnce(html, '目前登入帳號', '示範身份');
  html = replaceOnce(html, '日曆變更時自動同步，每 10 分鐘補查', '互動示範 · 所有會議與人員均為虛構，沒有連接 Google 或後端。');
  html = replaceOnce(html, '<script src="fullscreen.js"></script>', '<script src="fullscreen.js"></script>\n<script src="demo-fixtures.js"></script>\n<script src="demo-bootstrap.js"></script>');
  if (/<(?:script|link)[^>]*(?:src|href)=["'](?:https?:|\/)/i.test(html) || /(?:access|config|google|pwa)\.js|manifest\.webmanifest|admin\.html/.test(html)) throw new Error('Production integration remains in demo HTML');
  return html;
}

export async function buildDemo({ projectDir = projectRoot } = {}) {
  const project = resolve(projectDir), output = join(project, 'demo-dist');
  if (basename(output) !== 'demo-dist' || dirname(output) !== project) throw new Error('Invalid demo build destination');
  try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Demo destination must not be a symbolic link'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Read and validate the generated files before replacing the old output.
  const html = demoHTML(await readFile(join(project, 'index.html'), 'utf8'));
  let app = await readFile(join(project, 'app.js'), 'utf8');
  app = replaceOnce(app, "'roomly.single-room.bookings.v2'", "'roomly.demo.bookings.v1'")
    .replaceAll("'roomly.bookings.v1'", "'roomly.demo.legacy.v1'")
    .replaceAll("'roomly.'+id", "'roomly.demo.'+id");
  if (/roomly\.single-room|['"]roomly\.bookings|['"]roomly\.['"]\+id/.test(app)) throw new Error('Production storage remains in demo');
  const css = (await readFile(join(project, 'style.css'), 'utf8')).replace(/^@import\s+url\([^\n]*\);\s*/gm, '');
  if (/@import|url\(\s*["']?(?:https?:|\/\/)/i.test(css)) throw new Error('External CSS request remains in demo');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const file of ['tablet.css', 'access.css', 'holidays.js', 'core.js', 'fullscreen.js']) await copyFile(join(project, file), join(output, file));
  for (const [source, target] of [['demo/fixtures.js', 'demo-fixtures.js'], ['demo/bootstrap.js', 'demo-bootstrap.js'], ['demo/demo.css', 'demo.css']]) await copyFile(join(project, source), join(output, target));
  for (const file of ['use-cases.svg', 'calendar-flow.svg']) await copyFile(join(project, 'docs/images', file), join(output, file));
  await Promise.all([writeFile(join(output, 'index.html'), html), writeFile(join(output, 'app.js'), app), writeFile(join(output, 'style.css'), css), writeFile(join(output, '.nojekyll'), '')]);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildDemo();
  console.log(`Built standalone fictional-data demo: ${output}`);
}
