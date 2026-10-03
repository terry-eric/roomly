import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { buildDemo, DEMO_FILES, projectRoot } from '../scripts/build-demo.mjs';
import { createDemoServer } from '../scripts/serve-demo.mjs';

const require = createRequire(import.meta.url), core = require('../core.js'), fixtures = require('../demo/fixtures.js');
const inputs = ['index.html', 'app.js', 'style.css', 'tablet.css', 'access.css', 'holidays.js', 'core.js', 'fullscreen.js', 'demo/fixtures.js', 'demo/bootstrap.js', 'demo/demo.css', 'docs/images/use-cases.svg', 'docs/images/calendar-flow.svg'];

async function buildFixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'roomly-demo-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, 'demo'));
  await mkdir(join(project, 'docs/images'), { recursive: true });
  for (const input of inputs) await copyFile(join(projectRoot, input), join(project, input));
  return { project, output: await buildDemo({ projectDir: project }) };
}

function browser(appSource, fixturesSource, bootstrapSource, { storageFails = false } = {}) {
  const elements = new Map(), documentEvents = {}, windowEvents = {}, storageReads = [], storageWrites = [], classes = new Set();
  let fetches = 0, registrations = 0;
  const storage = new Map([
    ['roomly.single-room.bookings.v2', JSON.stringify([{ id: 'private', title: 'PRIVATE_SENTINEL', organizer: 'PRIVATE_NAME', attendees: ['PRIVATE_PERSON'], date: '2026-10-08', room: 'forest', start: '09:00', end: '10:00' }])],
    ['roomly.bookings.v1', 'PRIVATE_LEGACY_SENTINEL'], ['roomly.skip-weekends', 'true']
  ]);
  const element = selector => {
    if (elements.has(selector)) return elements.get(selector);
    const attributes = {}, events = {};
    const el = {
      dataset: {}, value: '', checked: false, hidden: false, disabled: false, innerHTML: '', textContent: '',
      clientWidth: 400, scrollWidth: 1500, scrollLeft: 0, scrollTop: 0, offsetHeight: 30, isConnected: true,
      style: { setProperty() {}, removeProperty() {} },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute: (name, value) => { attributes[name] = value; }, removeAttribute: name => { delete attributes[name]; },
      addEventListener: (name, handler) => { events[name] = handler; },
      querySelector: () => element('popover-close'), contains: target => target === el,
      getBoundingClientRect: () => ({ top: 100, left: 20, bottom: 144, width: 44, height: 44 }),
      scrollTo: options => { el.scrollLeft = options.left; el.scrollTop = options.top; }, focus() {},
      click: () => el.onclick?.(), attributes, events
    };
    elements.set(selector, el); return el;
  };
  const ranges = ['morning', 'afternoon', 'day'].map(value => { const el = element(`[data-range="${value}"]`); el.dataset.range = value; return el; });
  const navigation = ['overview', 'import'].map(value => { const el = element(`nav-${value}`); el.dataset.view = value; return el; });
  const document = {
    hidden: false, body: { classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) } },
    querySelector: selector => ['dialog[open]', '.now-line:not([hidden])', '.now-line', '.now-slot'].includes(selector) ? null : element(selector),
    querySelectorAll: selector => selector === '[data-range]' ? ranges : selector === '.nav-item' ? navigation : selector === 'dialog' ? [element('#booking-dialog'), element('#detail-dialog')] : selector === '.view' ? [element('#overview'), element('#import')] : [],
    addEventListener: (name, handler) => { (documentEvents[name] ||= []).push(handler); }
  };
  const context = {
    RoomCore: core, document, Date: class extends Date { static now() { return Date.parse('2026-10-08T09:45:00+08:00'); } }, Intl, crypto,
    localStorage: {
      getItem: key => { storageReads.push(key); if (storageFails) throw Error('storage disabled'); return storage.get(key) ?? null; },
      setItem: (key, value) => { storageWrites.push(key); if (storageFails) throw Error('storage disabled'); storage.set(key, String(value)); }
    },
    fetch: () => { fetches++; throw Error('A static demo must never fetch'); },
    navigator: { serviceWorker: { register: () => { registrations++; throw Error('No demo service worker'); } } },
    innerWidth: 400, innerHeight: 800, scrollY: 0,
    getComputedStyle: () => ({ minHeight: '240px' }), requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    addEventListener: (name, handler) => { (windowEvents[name] ||= []).push(handler); }
  };
  context.window = context; vm.createContext(context);
  for (const source of [appSource, fixturesSource, bootstrapSource]) vm.runInContext(source, context);
  return { context, element, ranges, navigation, documentEvents, storageReads, storageWrites, get fetches() { return fetches; }, get registrations() { return registrations; } };
}

test('demo build isolates production authentication, storage, external requests and service workers while preserving relative assets', async t => {
  const { project, output } = await buildFixture(t);
  const before = await Promise.all(inputs.map(input => readFile(join(project, input))));
  await writeFile(join(output, 'old-output.txt'), 'stale');
  await buildDemo({ projectDir: project });
  assert.deepEqual((await readdir(output)).sort(), [...DEMO_FILES].sort());
  assert.deepEqual(await Promise.all(inputs.map(input => readFile(join(project, input)))), before, 'the production inputs are untouched');
  const html = await readFile(join(output, 'index.html'), 'utf8'), app = await readFile(join(output, 'app.js'), 'utf8'), css = await readFile(join(output, 'style.css'), 'utf8');
  assert.match(html, /互動示範 · 虛構資料/); assert.match(html, /connect-src 'none'/); assert.match(html, /worker-src 'none'/);
  assert.doesNotMatch(html, /(?:access|google|config|pwa)\.js|gsi\/client|manifest\.webmanifest|admin\.html|\/roomly\//);
  assert.doesNotMatch(app, /roomly\.single-room|['"]roomly\.bookings|['"]roomly\.['"]\+id/);
  assert.doesNotMatch(css, /@import|url\(\s*["']?(?:https?:|\/\/)/);
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  for (const reference of references) {
    assert.ok(DEMO_FILES.includes(reference), `${reference} is a local demo asset`);
    const nested = new URL(reference, 'https://example.test/roomly-demo/');
    assert.equal(nested.pathname, '/roomly-demo/' + reference);
    await readFile(join(output, reference));
  }
  assert.ok(references.includes('fullscreen.js'));
});

test('demo fixtures cover every displayed day with valid fictional participants, no accounts or Meet links', () => {
  for (const days of [core.boardDays('2026-10-08'), core.boardDays('2026-10-08', true, true), core.boardDays('2027-12-31')]) {
    const { events, rooms } = fixtures.create(core, days);
    assert.equal(events.length, days.length * 4); assert.equal(new Set(events.map(event => event.id)).size, events.length);
    for (const day of days) assert.equal(events.filter(event => core.date(event.startISO) === day).length, 4);
    for (const event of events) {
      assert.ok(Date.parse(event.endISO) > Date.parse(event.startISO)); assert.ok(core.time(event.startISO) >= '09:00'); assert.ok(core.time(event.endISO) <= '19:00');
      assert.ok(event.attendees.length >= 2); assert.equal(new Set(event.attendees).size, event.attendees.length);
      assert.ok(event.attendees.every(name => name.includes('虛構'))); assert.equal(event.meet, '');
      assert.ok(event.roomIds.includes(rooms[0].id)); assert.doesNotMatch(JSON.stringify(event), /@|https?:\/\//);
    }
    events[0].attendees[0] = 'changed'; assert.notEqual(fixtures.create(core, days).events[0].attendees[0], 'changed');
  }
  assert.throws(() => fixtures.create(core, ['2026-02-31'])); assert.throws(() => fixtures.create(core, ['2026-10-08', '2026-10-08']));
});

test('built demo renders meetings immediately and date, range and participant interactions never read private storage or contact a backend', async t => {
  const { output } = await buildFixture(t);
  const sources = await Promise.all(['app.js', 'demo-fixtures.js', 'demo-bootstrap.js'].map(file => readFile(join(output, file), 'utf8')));
  for (const storageFails of [false, true]) {
    const h = browser(...sources, { storageFails });
    assert.match(h.element('#gantt').innerHTML, /設計討論/); assert.match(h.element('#gantt').innerHTML, /data-person="安安（虛構）"/);
    assert.match(h.element('#gantt').innerHTML, /data-date="2026-10-08"/); assert.match(h.element('#gantt').innerHTML, /is-today/);
    assert.equal(h.element('#new-booking').hidden, true); assert.equal(h.element('.demo-label').textContent, '虛構資料');
    assert.match(h.element('#calendar-settings').innerHTML, /disabled/);
    h.element('#day').value = '2026-10-31'; h.element('#day').onchange();
    assert.match(h.element('#gantt').innerHTML, /data-date="2026-10-31"/);
    h.element('#skip-weekends').checked = true; h.element('#skip-weekends').onchange();
    assert.match(h.element('#gantt').innerHTML, /data-date="2026-11-02"/); assert.doesNotMatch(h.element('#gantt').innerHTML, /data-date="2026-10-31"/);
    h.ranges[1].click(); assert.match(h.element('#gantt').innerHTML, /團隊工作坊/); assert.doesNotMatch(h.element('#gantt').innerHTML, /設計討論/);
    h.context.showPerson({ dataset: { person: '安安（虛構）' }, setAttribute() {}, getBoundingClientRect: () => ({ left: 20, bottom: 144, top: 100, width: 44 }) });
    assert.equal(h.element('#person-name').textContent, '安安（虛構）');
    h.element('#google-start').click(); h.navigation[1].click();
    assert.equal(h.fetches, 0); assert.equal(h.registrations, 0);
    assert.ok(h.storageReads.every(key => key.startsWith('roomly.demo.'))); assert.ok(h.storageWrites.every(key => key.startsWith('roomly.demo.')));
    assert.doesNotMatch([...h.storageWrites, ...h.storageReads, ...[...h.context.document.querySelectorAll('.view')].map(el => el.innerHTML), h.element('#gantt').innerHTML].join(''), /PRIVATE_/);
  }
});

test('demo server serves a repository subpath and refuses API, mutation and traversal requests', async t => {
  const { output } = await buildFixture(t), server = createDemoServer({ rootDir: output, basePath: '/roomly-demo/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/roomly-demo/'); assert.equal(page.status, 200); assert.match(await page.text(), /虛構資料/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  const script = await fetch(base + '/roomly-demo/demo-bootstrap.js'); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  for (const file of ['use-cases.svg', 'calendar-flow.svg']) {
    const image = await fetch(base + '/roomly-demo/' + file);
    assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await image.text(), /<svg\b/);
  }
  for (const path of ['/api/me', '/roomly-demo/api/calendar/feed', '/roomly-demo/config.js', '/roomly-demo/../package.json', '/roomly-demo/%2e%2e%2fpackage.json', '/roomly-demo/sw.js']) assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + '/roomly-demo/', { method: 'POST', body: 'no mutation' })).status, 405);
  const head = await fetch(base + '/roomly-demo/core.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.throws(() => createDemoServer({ basePath: '/../' }));
});
