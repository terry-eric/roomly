(()=>{
  'use strict';
  const button=document.querySelector('#pwa-install');let promptEvent=null;
  // Replace the former worker at this scope; only public static assets may be cached.
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/roomly/community-sw.js',{scope:'/roomly/',updateViaCache:'none'}).catch(()=>{});
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();promptEvent=event;button.hidden=false;});
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(ios&&!matchMedia('(display-mode: standalone)').matches){button.hidden=false;button.textContent='加入主畫面';}
  button.onclick=async()=>{if(promptEvent){await promptEvent.prompt();promptEvent=null;button.hidden=true;return;}let help=document.querySelector('#install-help');if(!help){help=document.createElement('p');help.id='install-help';help.hidden=true;help.setAttribute('role','status');help.textContent='在 Safari 按分享 → 加入主畫面。其他瀏覽器可在選單選擇「安裝應用程式」或「加入主畫面」。';document.querySelector('.google-entry').after(help);}help.hidden=!help.hidden;};
  window.addEventListener('appinstalled',()=>{promptEvent=null;button.hidden=true;});
})();
