/* Taiwan government-office holiday dates, retrieved 2026-10-04.
 * Source: 行政院人事行政總處 / data.gov.tw dataset 14718.
 * Government Data Open License v1: https://data.gov.tw/license
 * Each official CSV has all 365 dates and fields 西元日期 / 星期 / 是否放假 / 備註.
 * Include rows with 是否放假=2 and a named 備註 (holidays and substitute holidays);
 * ordinary Saturday/Sunday rows have an empty 備註 and are deliberately excluded.
 * Labels are preserved from the official CSV; 補假 is not assigned a guessed name.
 * 2027-12-31 is included because the official 2027 CSV marks it as 補假.
 * 2026 CSV SHA-256: 0edd80d368626eb73caa05b6c33400ec9d87691b46834d03936efb91e6a0f00d
 * 2027 CSV SHA-256: e30df188649bf5347db3ec43fa989af2cc8d93d793fbe5c9891601e6cce4acf3
 * This published government-office calendar is a reference, not a company leave policy.
 * Unsupported years return an empty label; consult supportedYears before assuming coverage.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaiwanHolidays = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const holidays = Object.freeze({
    "2026-01-01": "開國紀念日",
    "2026-02-15": "小年夜",
    "2026-02-16": "農曆除夕",
    "2026-02-17": "春節",
    "2026-02-18": "春節",
    "2026-02-19": "春節",
    "2026-02-20": "補假",
    "2026-02-27": "補假",
    "2026-02-28": "和平紀念日",
    "2026-04-03": "補假",
    "2026-04-04": "兒童節",
    "2026-04-05": "清明節",
    "2026-04-06": "補假",
    "2026-05-01": "勞動節",
    "2026-06-19": "端午節",
    "2026-09-25": "中秋節",
    "2026-09-28": "孔子誕辰紀念日/教師節",
    "2026-10-09": "補假",
    "2026-10-10": "國慶日",
    "2026-10-25": "臺灣光復暨金門古寧頭大捷紀念日",
    "2026-10-26": "補假",
    "2026-12-25": "行憲紀念日",
    "2027-01-01": "開國紀念日",
    "2027-02-04": "小年夜",
    "2027-02-05": "農曆除夕",
    "2027-02-06": "春節",
    "2027-02-07": "春節",
    "2027-02-08": "春節",
    "2027-02-09": "補假",
    "2027-02-10": "補假",
    "2027-02-28": "和平紀念日",
    "2027-03-01": "補假",
    "2027-04-04": "兒童節",
    "2027-04-05": "清明節",
    "2027-04-06": "補假",
    "2027-04-30": "補假",
    "2027-05-01": "勞動節",
    "2027-06-09": "端午節",
    "2027-09-15": "中秋節",
    "2027-09-28": "孔子誕辰紀念日/教師節",
    "2027-10-10": "國慶日",
    "2027-10-11": "補假",
    "2027-10-25": "臺灣光復暨金門古寧頭大捷紀念日",
    "2027-12-24": "補假",
    "2027-12-25": "行憲紀念日",
    "2027-12-31": "補假"
  });
  const supportedYears = Object.freeze([2026, 2027]);
  const sources = Object.freeze([
    "https://data.gov.tw/dataset/14718",
    "https://www.dgpa.gov.tw/FileConversion?filename=dgpa%2Ffiles%2F202506%2Fa52331bd-a189-466b-b0f0-cae3062bbf74.csv&name=115%E5%B9%B4%E4%B8%AD%E8%8F%AF%E6%B0%91%E5%9C%8B%E6%94%BF%E5%BA%9C%E8%A1%8C%E6%94%BF%E6%A9%9F%E9%97%9C%E8%BE%A6%E5%85%AC%E6%97%A5%E6%9B%86%E8%A1%A8.csv&nfix=",
    "https://www.dgpa.gov.tw/FileConversion?filename=dgpa%2Ffiles%2F202607%2Ff538b1ff-ba60-4c63-9477-10db8e6612d1.csv&name=116%E5%B9%B4%E4%B8%AD%E8%8F%AF%E6%B0%91%E5%9C%8B%E6%94%BF%E5%BA%9C%E8%A1%8C%E6%94%BF%E6%A9%9F%E9%97%9C%E8%BE%A6%E5%85%AC%E6%97%A5%E6%9B%86%E8%A1%A8_utf8bom.csv&nfix="
  ]);
  function get(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    return holidays[day] || '';
  }
  return Object.freeze({ get, supportedYears, sources });
});
