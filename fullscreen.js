/* Keep the preview usable even on browsers without native fullscreen. */
(()=>{
  'use strict';
  const button=document.querySelector('#board-fullscreen');
  if(!button)return;
  let active=false,native=false,busy=false,scrollPosition={left:0,top:0};
  function preview(value){
    active=value;
    document.body.classList.toggle('board-fullscreen',value);
    button.textContent=value?'退出全螢幕':'全螢幕';
    button.setAttribute('aria-pressed',String(value));
    button.setAttribute('aria-label',value?'退出全螢幕預覽':'開啟全螢幕預覽');
    window.dispatchEvent(new Event('roomly:previewchange'));
    if(!value){window.scrollTo({...scrollPosition,behavior:'instant'});button.focus({preventScroll:true});}
  }
  button.onclick=async()=>{
    if(busy)return;
    if(active){
      if(native&&document.fullscreenElement){
        busy=button.disabled=true;
        try{await document.exitFullscreen();if(active)preview(false);}
        catch{ /* Keep the exit control available for another attempt. */ }
        finally{busy=button.disabled=false;}
      }else preview(false);
      return;
    }
    scrollPosition={left:window.scrollX,top:window.scrollY};
    preview(true);
    if(typeof document.documentElement.requestFullscreen==='function'&&document.fullscreenEnabled!==false){
      busy=button.disabled=true;
      try{await document.documentElement.requestFullscreen();}
      catch{ /* The CSS preview still fills the available viewport. */ }
      finally{busy=button.disabled=false;}
    }
  };
  document.addEventListener('fullscreenchange',()=>{
    if(document.fullscreenElement===document.documentElement)native=true;
    else if(native){native=false;if(active)preview(false);}
  });
  document.addEventListener('keydown',event=>{
    const overlay=document.querySelector('dialog[open]')||document.querySelector('#person-popover')?.dataset?.open==='true';
    if(event.key==='Escape'&&active&&!busy&&!document.fullscreenElement&&!overlay)preview(false);
  });
})();
