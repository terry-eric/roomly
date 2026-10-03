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
  $('#calendar-settings').innerHTML = `
    <h2>實際應用：門外平板與手機 App</h2>
    <p>把平板固定在會議室門外，以全螢幕顯示目前預約、預約結束時間與下一場會議。其他成員可以從手機查看同一看板，出發前先確認有沒有空檔。</p>
    <figure class="demo-explainer"><img src="use-cases.svg" width="1080" height="600" alt="使用情境示意：會議室門外的平板與成員手機共用預約看板"><figcaption>門口看目前預約，手機查預約空檔；圖中資料皆為虛構示意。</figcaption></figure>
    <h3>正式版如何使用</h3>
    <p>管理員設定會議室地點與白名單；成員首次登入並同意日曆唯讀授權。之後在 Google 日曆建立或修改預約，Roomly 依地點彙整，讓平板與手機查看同一份時間表。</p>
    <figure class="demo-explainer"><img src="calendar-flow.svg" width="1080" height="700" loading="lazy" alt="同步流程：本人授權 Google 日曆，Roomly 依會議室地點彙整，再提供平板與手機查看"><figcaption>完整版本需部署後端；手機可將正式版加入主畫面，以 App（PWA）方式開啟。</figcaption></figure>
    <p class="muted">使用狀況依據日曆預約，並非現場感測；空白時段代表目前已同步來源中沒有符合地點的預約。新增與修改會議仍在 Google 日曆操作。</p>
    <h3>試用此展示頁</h3>
    <p class="muted">所有會議、人員及會議室皆為虛構資料，隨所選日期在本機產生。</p>
    <p class="muted">可切換日期與顯示時段、略過六日／國定假日、點會議查看詳細、點圓圈查看姓名，以及開啟全螢幕預覽。</p>
    <div class="demo-disabled-actions"><button type="button" disabled>Google 登入（示範版停用）</button><button type="button" disabled>日曆授權與同步（示範版停用）</button></div>
    <p class="small muted">真實部署需另外設定後端與 Google 授權；此頁沒有連接任何帳號，也不會儲存會議。</p>`;
  document.querySelectorAll('#booking-form input, #booking-form select, #booking-form textarea, #booking-form button').forEach(control => { control.disabled = true; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderDemo(); });
  renderDemo();
  // Start with useful morning reservations visible even outside working hours.
  document.querySelector('[data-range="day"]').click();
})();
