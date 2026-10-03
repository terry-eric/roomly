'use strict';
(() => {
  const button=document.querySelector('#pwa-install');
  const standalone=window.matchMedia('(display-mode: standalone)'),fullscreen=window.matchMedia('(display-mode: fullscreen)');
  let prompt=null,installing=false,installed=false,guide=null;
  const inApp=()=>installed||standalone.matches||fullscreen.matches||navigator.standalone===true;
  const render=()=>{if(button){button.hidden=inApp();button.disabled=installing;button.textContent=installing?'正在安裝…':'安裝 App';}};
  function showGuide(){
    if(!guide){
      guide=document.createElement('dialog');guide.id='pwa-guide';guide.setAttribute('aria-labelledby','pwa-guide-title');
      guide.innerHTML=`<div class="pwa-guide-heading"><img src="/roomly/icon-192.png" width="48" height="48" alt=""><h2 id="pwa-guide-title">安裝 Roomly</h2></div><div class="pwa-guide-body"><p>加入主畫面後，從 Roomly 圖示開啟，就能以 App 方式顯示、隱藏網址列。</p><h3>iPad / iPhone</h3><ol><li>用 Safari 開啟這個網站。</li><li>點「分享」→「加入主畫面」。</li><li>如有「打開為網頁 App」選項，請開啟，再點「加入」。</li></ol><h3>Android 平板 / 手機</h3><ol><li>用 Chrome 開啟這個網站。</li><li>點選單「⋮」→「安裝應用程式」或「加入主畫面」，完成安裝。</li></ol><p class="pwa-guide-note">電腦：使用 Chrome 或 Edge 的網址列安裝圖示，或選單中的安裝功能。</p></div><button id="pwa-guide-close" type="button">知道了</button>`;
      document.body.append(guide);guide.querySelector('#pwa-guide-close').onclick=()=>guide.close();
    }
    if(!guide.open)guide.showModal();
  }
  async function install(){
    if(installing||inApp())return;
    if(!prompt){showGuide();return;}
    const current=prompt;prompt=null;installing=true;render();
    try{await current.prompt();const choice=await current.userChoice;if(choice.outcome==='accepted')installed=true;}
    catch{showGuide();}
    finally{installing=false;render();}
  }
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;render();});
  window.addEventListener('appinstalled',()=>{installed=true;prompt=null;if(guide?.open)guide.close();render();});
  standalone.addEventListener?.('change',render);fullscreen.addEventListener?.('change',render);
  if(button)button.onclick=install;
  render();
  if('serviceWorker' in navigator)window.addEventListener('load',()=>{
    void navigator.serviceWorker.register('/roomly/sw.js',{scope:'/roomly/'}).catch(()=>{});
  },{once:true});
})();
