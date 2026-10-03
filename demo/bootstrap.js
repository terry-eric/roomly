/* Loaded only by the standalone demo build; never by the production board. */
(() => {
  'use strict';
  const app = window.RoomApp, core = window.RoomCore;
  const $ = selector => document.querySelector(selector);
  if (!app || !core || !window.RoomlyDemoFixtures) throw new Error('Demo assets are incomplete');

  function renderDemo() {
    const data = window.RoomlyDemoFixtures.create(core, app.days());
    app.setLive({ ...data, ready: true, availabilityComplete: true, message: '互動示範 · 所有會議與人員均為虛構，沒有連接 Google 或後端。' });
    $('.demo-label').textContent = '虛構資料';
    $('.sidebar-bottom').innerHTML = '<span class="connection-dot"></span>互動示範<small>不登入、不讀取真實日曆</small>';
  }

  // The existing date controls use this local adapter instead of a network sync.
  window.GoogleSync = Object.freeze({ sync: renderDemo });
  $('#google-start').onclick = () => {
    renderDemo();
    app.notify('已重新載入虛構範例，沒有連接 Google。');
  };
  $('#current-account').textContent = '示範訪客（虛構）';
  $('#account-role').textContent = '此示範不會要求登入或授權';
  $('#calendar-settings').innerHTML = '<h2>靜態互動示範</h2><p class="muted">所有會議、人員及會議室皆為虛構資料，隨所選日期在本機產生。</p><p class="muted">可切換日期與顯示時段、略過六日／國定假日、點會議查看詳細、點圓圈查看姓名，以及開啟全螢幕預覽。</p><div class="demo-disabled-actions"><button type="button" disabled>Google 登入（示範版停用）</button><button type="button" disabled>日曆授權與同步（示範版停用）</button></div><p class="small muted">真實部署需另外設定後端與 Google 授權；此頁沒有連接任何帳號，也不會儲存會議。</p>';
  document.querySelectorAll('#booking-form input, #booking-form select, #booking-form textarea, #booking-form button').forEach(control => { control.disabled = true; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderDemo(); });
  renderDemo();
  // Start with useful morning reservations visible even outside working hours.
  document.querySelector('[data-range="day"]').click();
})();
