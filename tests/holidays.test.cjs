'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('../holidays.js');

// Independent fixture: all weekday rows with 是否放假=2, read from the complete
// official 2026/2027 CSVs linked in H.sources. This includes every 補假.
const officialWeekdayOff = {
  "2026": "01-01 02-16 02-17 02-18 02-19 02-20 02-27 04-03 04-06 05-01 06-19 09-25 09-28 10-09 10-26 12-25",
  "2027": "01-01 02-04 02-05 02-08 02-09 02-10 03-01 04-05 04-06 04-30 06-09 09-15 09-28 10-11 10-25 12-24 12-31"
};
// Named statutory holidays which land on a weekend; ordinary weekly rest is excluded.
const officialNamedWeekendHolidays = {
  "2026": "02-15 02-28 04-04 04-05 10-10 10-25",
  "2027": "02-06 02-07 02-28 04-04 05-01 10-10 12-25"
};

test('official holiday labels include Lunar New Year, restored holidays and substitutes', () => {
  const expected = {
    '2026-01-01': '開國紀念日',
    '2026-02-15': '小年夜',
    '2026-02-16': '農曆除夕',
    '2026-02-17': '春節',
    '2026-02-19': '春節',
    '2026-02-20': '補假',
    '2026-02-27': '補假',
    '2026-04-03': '補假',
    '2026-04-04': '兒童節',
    '2026-04-05': '清明節',
    '2026-04-06': '補假',
    '2026-05-01': '勞動節',
    '2026-06-19': '端午節',
    '2026-09-25': '中秋節',
    '2026-09-28': '孔子誕辰紀念日/教師節',
    '2026-10-09': '補假',
    '2026-10-10': '國慶日',
    '2026-10-25': '臺灣光復暨金門古寧頭大捷紀念日',
    '2026-10-26': '補假',
    '2026-12-25': '行憲紀念日',
    '2027-01-01': '開國紀念日',
    '2027-02-04': '小年夜',
    '2027-02-05': '農曆除夕',
    '2027-02-06': '春節',
    '2027-02-08': '春節',
    '2027-02-09': '補假',
    '2027-02-10': '補假',
    '2027-03-01': '補假',
    '2027-04-06': '補假',
    '2027-04-30': '補假',
    '2027-06-09': '端午節',
    '2027-09-15': '中秋節',
    '2027-10-11': '補假',
    '2027-12-24': '補假',
    '2027-12-25': '行憲紀念日',
    '2027-12-31': '補假'
  };
  for (const [day, label] of Object.entries(expected)) assert.equal(H.get(day), label, day);
});

for (const year of [2026, 2027]) {
  test(`every date in ${year} agrees with official weekday-off and named-weekend fixtures`, () => {
    const weekdays = new Set(officialWeekdayOff[year].split(' ').map(day => `${year}-${day}`));
    const weekends = new Set(officialNamedWeekendHolidays[year].split(' ').map(day => `${year}-${day}`));
    let namedCount = 0;
    const cursor = new Date(`${year}-01-01T00:00:00Z`);
    while (cursor.getUTCFullYear() === year) {
      const day = cursor.toISOString().slice(0, 10);
      const fixture = [0, 6].includes(cursor.getUTCDay()) ? weekends : weekdays;
      assert.equal(Boolean(H.get(day)), fixture.has(day), day);
      if (H.get(day)) namedCount++;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    assert.equal(namedCount, year === 2026 ? 22 : 24);
  });
}

test('ordinary weekends, adjacent Lunar New Year weekends and workdays are not holidays', () => {
  for (const day of ['2026-01-03', '2026-01-04', '2026-02-13', '2026-02-14',
    '2026-02-21', '2026-02-22', '2026-10-03', '2026-10-04', '2026-10-08',
    '2027-01-02', '2027-01-03', '2027-02-11', '2027-02-13', '2027-02-14']) {
    assert.equal(H.get(day), '', day);
  }
});

test('unsupported years and malformed input return no invented holiday', () => {
  for (const day of [undefined, null, 20260101, new Date('2026-01-01'), '', '2026-1-1',
    '2026-01-01T00:00:00Z', '2026-02-30', '2026-13-01', 'constructor',
    '2025-01-01', '2028-01-01']) assert.equal(H.get(day), '');
  assert.deepEqual(H.supportedYears, [2026, 2027]);
  assert.ok(H.sources.includes('https://data.gov.tw/dataset/14718'));
  assert.equal(H.sources.filter(url => url.startsWith('https://www.dgpa.gov.tw/FileConversion?')).length, 2);
});

test('standalone browser script exports the same API without CommonJS or network access', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../holidays.js'), 'utf8'), sandbox);
  assert.equal(sandbox.window.TaiwanHolidays.get('2027-12-31'), '補假');
  assert.equal(sandbox.window.TaiwanHolidays.get('2026-10-04'), '');
  assert.deepEqual(Array.from(sandbox.window.TaiwanHolidays.supportedYears), [2026, 2027]);
  assert.ok(Object.isFrozen(sandbox.window.TaiwanHolidays.supportedYears));
});
