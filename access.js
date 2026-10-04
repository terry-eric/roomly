'use strict';
(() => {
  const page=document.body.dataset.page;
  if(!['gate','board','admin'].includes(page))return;
  const api='/roomly/api/';let info=null,loginBusy=false,loginStarted=false,loginPreparedAt=0,signInWidth=0,signInSizer=null,loginMode='',refreshGeneration=0;
  const status=text=>{const el=document.querySelector('#access-status');if(el)el.textContent=text;};
  async function request(path,body){
    const timeout=path.startsWith('calendar/')?60000:15000,message='暫時無法連線，請稍後重試。';
    let signal,timer=null,deadline=null;
    if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')signal=AbortSignal.timeout(timeout);
    else{
      const controller=typeof AbortController==='function'?new AbortController():null;
      if(controller)signal=controller.signal;
      // Keep the entire response bounded even without fetch cancellation.
      deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{try{if(controller)controller.abort();}finally{reject(Error(message));}},timeout);});
    }
    try{
      let response;try{
        const pending=fetch(api+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal});
        response=deadline?await Promise.race([pending,deadline]):await pending;
      }catch{throw Error(message);}
      const pendingJSON=response.json(),data=deadline?await Promise.race([pendingJSON,deadline]):await pendingJSON;
      if(!response.ok){const error=Error(data.error||'操作未完成。');error.status=response.status;throw error;}return data;
    }finally{if(timer!==null)clearTimeout(timer);}
  }
  async function logout(){
    try{await request('logout',{});if(window.google&&window.google.accounts&&window.google.accounts.id)window.google.accounts.id.disableAutoSelect();location.replace('/roomly/');}catch(error){status(error.message);if(page==='board')alert(error.message);}
  }
  const signOut=document.querySelector('#sign-out');if(signOut)signOut.addEventListener('click',logout);
  function showSignIn(mode){
    const server=document.querySelector('#server-sign-in');if(server){server.href=api+'login/start';server.hidden=mode!=='server';}
    const host=document.querySelector('#sign-in-button');if(host)host.hidden=mode!=='gis';
    const fallback=document.querySelector('#sign-in-fallback');if(fallback)fallback.hidden=true;
  }
  function loginStatus(){
    const matched=/(?:^\?|&)login=(expired|cancelled|failed)(?:&|$)/.exec(location.search||''),outcome=matched?matched[1]:undefined;
    status(outcome==='expired'?'登入已失效，請再按一次 Google 登入。':outcome==='cancelled'?'你已取消登入，可以再試一次。':outcome==='failed'?'Google 登入暫時未完成，請再試一次。':'登入後會確認白名單資格。');
  }
  function renderSignIn(){
    const host=document.querySelector('#sign-in-button');if(loginMode!=='gis'||!host||host.hidden)return;
    const width=Math.min(300,Math.floor(host.clientWidth));if(width<1||width===signInWidth)return;
    host.replaceChildren();window.google.accounts.id.renderButton(host,{type:'standard',theme:'outline',size:'large',text:'signin_with',width:String(width),locale:'zh_TW'});signInWidth=width;
  }
  function prepareGIS(challenge){
    const initialize=()=>{
      if(loginMode!=='gis'||info)return;
      // Only deployments without server login need the browser GIS flow.
      const options={client_id:challenge.clientId,nonce:challenge.nonce,auto_select:false};
      if(challenge.loginUri)Object.assign(options,{ux_mode:'redirect',login_uri:challenge.loginUri});
      else Object.assign(options,{ux_mode:'popup',callback:async result=>{
        if(loginBusy)return;loginBusy=true;status('正在登入…');
        try{await request('login',{credential:result.credential,nonce:challenge.nonce});location.replace('/roomly/?login=success');}
        catch(error){loginBusy=false;loginStarted=false;await signIn();status(error.message+' 請再按一次 Google 登入。');}
      }});
      window.google.accounts.id.initialize(options);signInWidth=0;renderSignIn();
      if(typeof ResizeObserver==='function'&&!signInSizer){signInSizer=new ResizeObserver(renderSignIn);signInSizer.observe(document.querySelector('#sign-in-button'));}
      loginStatus();
    };
    if(window.google&&window.google.accounts&&window.google.accounts.id){initialize();return;}
    const script=document.querySelector('#gis');if(script){script.addEventListener('load',initialize,{once:true});
    script.addEventListener('error',()=>{if(loginMode==='gis'&&!info)status('Google 登入元件無法載入，請確認網路後重新整理。');},{once:true});}
    status('正在載入 Google 登入…');
  }
  async function signIn(){
    if(loginBusy)return;
    if(loginStarted&&Date.now()-loginPreparedAt<8*60000){if(loginMode)showSignIn(loginMode);return;}
    loginStarted=true;loginPreparedAt=Date.now();
    try{
      const challenge=await request('challenge');
      if(info){loginStarted=false;return;}
      if(challenge.loginStartUri){
        if(challenge.loginStartUri!==location.origin+api+'login/start'){showSignIn('');throw Error('Google 登入設定不正確，請聯絡管理員。');}
        // A native same-window link creates fresh state/PKCE only on user click.
        // It works without GIS and returns through a first-party GET callback.
        loginMode='server';showSignIn(loginMode);loginStatus();return;
      }
      loginMode='gis';showSignIn(loginMode);prepareGIS(challenge);
    }catch(error){loginStarted=false;status(error.message);}
  }
  function readySignIn(){void signIn();}
  function displayGate(user){
    loginMode='';loginStarted=false;const server=document.querySelector('#server-sign-in');if(server)server.hidden=true;
    document.querySelector('#sign-in-button').hidden=true;document.querySelector('#pending-actions').hidden=false;
    const fallback=document.querySelector('#sign-in-fallback');if(fallback)fallback.hidden=true;
    const account=document.querySelector('#gate-account');account.hidden=false;account.textContent=user.email;
    document.querySelector('#gate-title').textContent=user.status==='pending'?'等待管理員核准':'尚未取得使用資格';
    document.querySelector('#gate-description').textContent=user.status==='pending'?'加入申請已送出。管理員核准後，就可以進入會議室看板。':'管理員尚未核准這個帳號。你可以聯絡管理員，或登出後更換帳號。';
    status(user.status==='pending'?(user.notification==='disabled'?'申請已保存，請聯絡管理員在白名單管理中核准。':user.notification==='sent'?'管理員的 Email 通知已送交寄信服務。':'申請已保存，管理員 Email 通知正在安排寄送。'):'目前無法開啟看板。');
  }
  async function refresh(){
    const run=++refreshGeneration;
    try{
      const user=await request('me');if(run!==refreshGeneration)return !!info&&info.status==='approved';
      const previous=info;info=user;
      if(info.status!=='approved'){
        if(page!=='gate'){location.replace('/roomly/');return false;}displayGate(info);return false;
      }
      if(page==='gate'){location.replace('/roomly/?login=success');return true;}
      if(page==='admin'&&!info.isAdmin){location.replace('/roomly/');return false;}
      for(const selector of ['#admin-link','#settings-admin-link']){const link=document.querySelector(selector);if(link){link.hidden=!info.isAdmin;link.textContent=info.pending?`白名單管理（${info.pending} 筆待審核）`:'白名單管理';}}
      const account=document.querySelector('#current-account');if(account)account.textContent=info.email;
      const role=document.querySelector('#account-role');if(role)role.textContent=info.isAdmin?'管理員 · 可設定地點與管理白名單':'一般成員 · 地點與白名單由管理員設定';
      if(page==='board'&&previous&&previous.status==='approved'&&typeof window.dispatchEvent==='function'&&typeof CustomEvent==='function'){
        if(typeof previous.sourcesRevision==='string'&&typeof info.sourcesRevision==='string'&&previous.sourcesRevision!==info.sourcesRevision)window.dispatchEvent(new CustomEvent('roomly:sourceschanged',{detail:{sourcesRevision:info.sourcesRevision}}));
        else if(typeof previous.calendarRevision==='string'&&typeof info.calendarRevision==='string'&&previous.calendarRevision!==info.calendarRevision)window.dispatchEvent(new CustomEvent('roomly:calendarchanged',{detail:{calendarRevision:info.calendarRevision}}));
      }
      return true;
    }catch(error){
      if(run!==refreshGeneration)return !!info&&info.status==='approved';
      if(error.status===401){if(page==='gate'){info=null;readySignIn();return false;}location.replace('/roomly/');return false;}
      status(error.message);return false;
    }
  }
  const checkAccess=document.querySelector('#check-access');if(checkAccess)checkAccess.addEventListener('click',()=>{void refresh();});
  const initial=refresh();
  window.RoomlyAccess={request,ensureAllowed:refresh,ready:initial,user:()=>info};
  setInterval(()=>{if(!document.hidden)void refresh();},page==='gate'?30000:60000);
})();
