'use strict';
(() => {
  const A=RoomApp,access=window.RoomlyAccess,$=s=>document.querySelector(s);
  let feed=null,generation=0,activeRun=0,busy=false,live=true,authorizing=false,locationDirty=false,locationSaving=false,locationFeedback=null,cachedRefreshPending=false,statusRefreshPending=false;
  const manualQueuedAt=new Map();
  const syncMessage='日曆變更時自動同步，每 10 分鐘補查';
  const callbackMessages={connected:'我的日曆已完整授權，後端會自動同步符合會議室地點的邀請。',cancelled:'你已取消日曆授權，仍可查看已同步的共用會議。',scope:'請同意日曆活動唯讀及日曆清單唯讀兩項權限，才能完成授權。',account:'請授權與網站登入相同的 Google 帳號。',refresh:'尚未取得背景同步授權，請重新授權。',failed:'Google 日曆授權未完成，請稍後重試。'};
  const returnParams=new URLSearchParams(location.search||''),calendarOutcome=returnParams.get('calendar');
  let callbackMessage=callbackMessages[calendarOutcome]||'',autoAuthorizePending=returnParams.get('login')==='success'&&!returnParams.has('calendar');
  if(returnParams.get('login')==='success'){
    returnParams.delete('login');
    const remaining=returnParams.toString();
    try{if(typeof window.history?.replaceState!=='function')throw Error();window.history.replaceState(null,'',(location.pathname||'/roomly/')+(remaining?'?'+remaining:'')+(location.hash||''));}
    catch{autoAuthorizePending=false;}
  }
  const panel=$('#calendar-settings');
  panel.innerHTML=`<span class="integration-icon google">G</span><span class="pill neutral" id="google-badge">共用看板</span><h2>我的日曆授權</h2><p class="muted">首次登入並通過白名單後，須完整同意 Google 日曆活動唯讀及日曆清單唯讀兩項權限；授權有效時不用重複同意。主要日曆及列表中未隱藏、可讀取活動詳情的共用日曆，會依會議室地點彙整到同一個看板。</p><div class="google-actions"><button class="primary" id="google-connect" hidden>重新授權日曆</button><button class="quiet outlined" id="google-demo">本機資料</button></div><p id="google-shared-hint" class="small muted" hidden>日曆授權尚未完成或需要更新。請在 Google 同意頁完整同意「日曆活動唯讀」及「日曆清單唯讀」兩項權限；少任何一項都無法完成授權。若曾取消或未完成，可按「重新授權日曆」再試一次。只有你在 Google 同意後，才會分享符合地點的活動。</p><p id="google-status" class="google-status" role="status">正在載入共用看板…</p><div class="google-actions"><button class="primary" id="google-sync">同步</button><button class="quiet" id="google-disconnect" disabled>停止分享我的日曆</button></div><p class="small muted">日曆變更時自動同步，每 10 分鐘補查，關閉網頁後仍會更新。看板每分鐘檢查後端是否有新資料。按「同步」可安排更新，完成後來源時間會更新；30 秒內不會重複安排。預約請在 <a href="https://calendar.google.com/" target="_blank" rel="noopener noreferrer">Google 日曆</a>建立。<a href="privacy.html" target="_blank" rel="noopener">日曆分享與隱私說明 ↗</a></p>`;
  panel.parentElement.prepend(panel);
  $('#shared-calendars').hidden=false;$('#location-filter').hidden=false;
  $('#people .notice').textContent='依所選日期彙整主辦人與受邀參與者。受邀與回覆狀態不代表實際出席。';
  const status=text=>$('#google-status').textContent=text;
  const room=()=>({id:'forest',name:feed?.location||'主會議室',meta:'共用 Google 日曆邀請'});
  const labels={unauthorized:'尚未授權自己的日曆',reauthorize:'Google 授權已失效，請本人重新授權',waiting:'等待首次同步',error:'同步失敗，暫時無法確認最新預約',stale:'資料逾時，等待重新同步'};
  function successTime(source){
    if(!source||['unauthorized','reauthorize'].includes(source.state)||!Number.isFinite(source.syncedAt)||source.syncedAt<=0)return '';
    const at=new Date(source.syncedAt*1000);if(!Number.isFinite(at.getTime()))return '';
    const parts=Object.fromEntries(new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at).map(part=>[part.type,part.value]));
    return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  function renderOwnStatus(source,warning=''){
    const element=$('#own-sync-status');element.hidden=!source;
    if(!source){element.textContent='';return;}
    const time=successTime(source),result=warning||(source.state==='ready'&&time?'同步成功':labels[source.state]||'等待同步');
    element.dataset.state=warning?'error':source.state;
    element.textContent=`我的來源：${result}${time?` · 最後成功 ${time}`:''}`;
  }
  function renderLocation(){
    const input=$('#room-location'),button=$('#location-apply'),message=$('#location-status'),admin=!!feed?.isAdmin;
    if(feed&&(!locationDirty&&!locationSaving||!admin)){input.value=feed.location;if(!admin)locationDirty=false;}
    input.disabled=!admin||locationSaving;
    button.hidden=!!feed&&!admin;button.disabled=!admin||locationSaving;
    button.textContent=locationSaving?'儲存中…':feed?.location?'儲存地點':'新增地點';
    const hint=!feed?'正在載入地點設定…':!admin?`地點由管理員設定。你目前登入的是 ${feed.email}。`:!feed.location?'輸入 Google 邀請的地點文字，再點「新增地點」。':'';
    message.textContent=locationFeedback?.text||hint;
    message.dataset.state=locationFeedback?.state||'info';message.hidden=!message.textContent;
  }
  function locationNotice(text,state='info'){locationFeedback={text,state};renderLocation();}
  function authorization(source){
    if(source.state==='unauthorized')return {key:'missing',label:'未授權',order:0};
    if(source.state==='reauthorize')return {key:'expired',label:'授權失效',order:1};
    if(['ready','waiting','error','stale'].includes(source.state))return source.sharedCalendars===false?{key:'primary',label:'需完整授權',order:2}:{key:'connected',label:'已授權',order:3};
    return {key:'unknown',label:'狀態待確認',order:4};
  }
  function renderSources(){
    const sources=feed.sources;
    const counts=sources.reduce((result,source)=>{result[authorization(source).key]++;return result;},{missing:0,expired:0,primary:0,connected:0,unknown:0});
    $('#shared-summary').textContent=`已登入帳號 · ${sources.length} 位${counts.missing?` · ${counts.missing} 位未授權`:''}${counts.expired?` · ${counts.expired} 位授權失效`:''}${counts.primary?` · ${counts.primary} 位需完整授權`:''}`;
    $('#shared-calendar-list').innerHTML=[...sources].sort((a,b)=>authorization(a).order-authorization(b).order).map(s=>{
      const grant=authorization(s);
      const time=successTime(s);
      const days=A.days?A.days():RoomCore.boardDays(A.day());
      const count=RoomCore.mergeGoogle([{calendar:{id:s.email,name:s.email,kind:'person'},events:s.events}],{room:room()}).filter(e=>e.roomIds.length&&RoomCore.overlapsDays(Date.parse(e.startISO),Date.parse(e.endISO),days)).length;
      const calendars=Number.isInteger(s.calendarCount)&&s.calendarCount>=0?` · ${s.calendarCount} 個日曆`:'';
      const primaryOnly=s.sharedCalendars===false&&!['unauthorized','reauthorize'].includes(s.state)?' · 目前僅主要日曆':'';
      const text=(s.state==='ready'&&time?`同步成功 · 這五天 ${count} 場${calendars}`:labels[s.state]||'等待首次同步')+primaryOnly;
      const success=time?`最後成功同步：${time}`:'尚無成功同步紀錄';
      return `<div class="shared-calendar" data-state="${s.state==='ready'?'ready':'error'}" data-authorization="${grant.key}" data-own="${s.email===feed.email}"><div><strong>${A.esc(s.email)}${s.email===feed.email?'（我）':''}</strong><small class="shared-sync-state">${A.esc(text)}</small><small class="shared-sync-time">${A.esc(success)}</small></div><span class="shared-authorization">${grant.label}</span></div>`;
    }).join('');
    $('#shared-calendar-status').textContent='時間為台北時間；跨週時顯示所選範圍中最早的成功同步時間，所有週次都成功才會顯示同步成功。未授權或授權失效的帳號排在前面，需本人完成 Google 同意。「需完整授權」須本人完整同意日曆活動唯讀及日曆清單唯讀兩項權限。只列已登入且通過白名單的帳號；只顯示符合會議室地點的活動，空白時段不保證會議室可用。';
    renderLocation();
    const own=sources.find(s=>s.email===feed.email),connected=own&&!['unauthorized','reauthorize'].includes(own.state);
    renderOwnStatus(own);
    const incomplete=!!own&&(!connected||own.sharedCalendars===false),retry=!!calendarOutcome&&calendarOutcome!=='connected'&&(!own||incomplete);
    $('#google-connect').textContent='重新授權日曆';
    $('#google-connect').hidden=authorizing||!(incomplete||retry);
    $('#google-connect').disabled=!feed.configured||authorizing;
    $('#google-shared-hint').hidden=!(incomplete||retry);
    $('#google-disconnect').disabled=!connected;
    $('#google-badge').textContent=connected?'我的日曆已連接':'我的日曆未授權';
  }
  async function sync(show=false,manual=false,cached=false){
    if(!access?.request){status('共用看板需要從正式網站登入使用。');return;}
    if(authorizing)return;
    if(manual&&(busy||locationSaving))return;
    const manualKey=manual?[...new Set((A.days?A.days():RoomCore.boardDays(A.day())).map(day=>RoomCore.weekDays(day)[0]))].join(','):'';
    if(manual&&manualQueuedAt.has(manualKey)&&Date.now()-manualQueuedAt.get(manualKey)<30000){A.notify?.('同步已安排，完成後會更新來源時間。請稍候再試。');return;}
    const run=++generation;activeRun=run;live=true;busy=true;
    $('#google-sync').disabled=$('#google-start').disabled=$('#refresh-sources').disabled=true;
    $('#google-start').textContent='同步中…';
    try{
      if(!await access.ensureAllowed()){if(run===generation)A.setLive({message:'請確認登入與白名單資格。',availabilityComplete:false});return;}
      const days=A.days?A.days():RoomCore.boardDays(A.day()),day=days[0],weeks=[...new Set(days.map(date=>RoomCore.weekDays(date)[0]))];
      const feeds=[];
      // One account's grant spans the visible weeks; finish its first sync before
      // requesting the next week so neither request is skipped by the lease.
      for(const [index,week]of weeks.entries()){
        if(run!==generation)return;
        const date=index===0?day:week;
        const data=await (manual?access.request('calendar/sync',{day:date}):access.request('calendar/feed?day='+encodeURIComponent(date)+(cached?'&cached=1':'')));
        if(run!==generation)return;
        feeds.push(data);
      }
      if(run!==generation)return;
      if(feeds.some((data,index)=>!Array.isArray(data.sources)||data.week!==weeks[index]||typeof data.location!=='string'||data.location!==feeds[0].location||data.configured!==feeds[0].configured||data.email!==feeds[0].email||data.isAdmin!==feeds[0].isAdmin||(data.syncQueued!==undefined&&typeof data.syncQueued!=='boolean')))throw Error('共用看板回應不正確，請再試一次。');
      const sourcesForRange=[];
      for(const source of feeds[0].sources){
        const parts=feeds.map(data=>data.sources.find(s=>s.email===source.email));
        // A source removed in either response must not keep sharing old events.
        if(parts.some(s=>!s))continue;
        const state=['unauthorized','reauthorize','error','stale','waiting'].find(state=>parts.some(s=>s.state===state))||'ready';
        const events=new Map();
        if(!['unauthorized','reauthorize'].includes(state))for(const part of parts)for(const event of part.events){
          const start=event.start?.dateTime||(event.start?.date&&event.start.date+'T00:00:00+08:00');
          const end=event.end?.dateTime||(event.end?.date&&event.end.date+'T00:00:00+08:00');
          if(Number.isFinite(Date.parse(start))&&Date.parse(end)>Date.parse(start)){
            const key=RoomCore.googleEventKey(event,source.email),previous=events.get(key);
            events.set(key,previous?RoomCore.preferGoogleVersion(previous,event):event);
          }
        }
        const sharedCalendars=parts.some(s=>s.sharedCalendars===false)?false:parts.every(s=>s.sharedCalendars===true)?true:undefined;
        const calendarCount=parts.every(s=>Number.isInteger(s.calendarCount)&&s.calendarCount>=0)?Math.min(...parts.map(s=>s.calendarCount)):undefined;
        sourcesForRange.push({...source,state,sharedCalendars,calendarCount,syncedAt:Math.min(...parts.map(s=>s.syncedAt||0))||null,events:[...events.values()]});
      }
      const data={...feeds[0],syncQueued:feeds.some(data=>data.syncQueued===true),sources:sourcesForRange};
      if(manual&&data.syncQueued)manualQueuedAt.set(manualKey,Date.now());
      feed=data;statusRefreshPending=false;renderSources();
      const sources=data.sources.map(s=>({calendar:{id:s.email,name:s.email,kind:'person'},events:s.events}));
      const events=RoomCore.mergeGoogle(sources,{room:room()}).filter(e=>e.roomIds.length&&RoomCore.overlapsDays(Date.parse(e.startISO),Date.parse(e.endISO),days));
      const unresolved=data.sources.filter(s=>s.state!=='ready').length;
      const detail=!data.configured?'管理員尚未完成後端日曆授權設定。':!data.location?'可先授權自己的日曆；管理員設定會議室地點後，符合地點的邀請會開始同步。':`${events.length} 場會議 · ${unresolved?`${unresolved} 個來源尚未完成授權或同步 · `:''}${syncMessage}。`;
      A.setLive({rooms:[room()],events,ready:!!data.location&&data.configured,availabilityComplete:false,message:syncMessage});
      const queuedMessage='已安排背景同步，完成後會更新各來源的成功時間。';
      status(callbackMessage||(data.syncQueued?queuedMessage:detail));if(callbackMessage){A.notify?.(callbackMessage);callbackMessage='';}
      if(manual&&data.syncQueued)A.notify?.(queuedMessage);
      if(manual&&data.sources.some(s=>['error','reauthorize'].includes(s.state)))A.notify?.('部分日曆需要重新授權或重試，請查看「已登入帳號」。');
      if(show)A.view('overview');
      if(autoAuthorizePending&&!cached){
        autoAuthorizePending=false;
        const own=data.sources.find(source=>source.email===data.email);
        if(data.configured&&own&&(['unauthorized','reauthorize'].includes(own.state)||own.sharedCalendars===false))await authorize();
      }
      return true;
    }catch(error){
      if(run!==generation)return;
      const message=error.message||'共用看板載入失敗。';status(message);
      if(!manual&&error.status===400)A.notify?.(message);
      if((manual||cached&&feed)&&error.status!==401&&error.status!==403){$('#shared-calendar-status').textContent=message;renderOwnStatus(feed?.sources.find(s=>s.email===feed.email),manual?'本次同步失敗':'狀態讀取失敗');if(manual)A.notify?.(message);return false;}
      feed=null;$('#shared-calendar-list').innerHTML='';$('#shared-summary').textContent='已登入帳號';$('#shared-calendar-status').textContent=message;$('#google-connect').disabled=true;$('#google-shared-hint').hidden=true;$('#google-disconnect').disabled=true;
      renderOwnStatus();
      A.setLive({rooms:[room()],message:syncMessage,availabilityComplete:false});
      renderLocation();return false;
    }
    finally{if(run===activeRun){busy=false;$('#google-sync').disabled=$('#google-start').disabled=$('#refresh-sources').disabled=false;$('#google-start').textContent='同步';flushCachedRefresh();}}
  }
  async function authorize(bootstrap=false){
    if(!access||(!feed?.configured&&bootstrap!==true)||authorizing)return;
    authorizing=true;$('#google-connect').disabled=true;$('#google-connect').hidden=true;
    try{status('正在開啟 Google 日曆授權…');const data=await access.request('calendar/authorize',{});const url=new URL(data.url);if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth')throw Error('Google 授權網址不正確。');location.assign(url.href);}
    catch(error){const message=error.message||'Google 日曆授權未完成，請稍後重試。';if(bootstrap===true)callbackMessage=message;status(message);if(bootstrap!==true)A.notify?.(message);authorizing=false;$('#google-connect').disabled=!feed?.configured;$('#google-connect').hidden=false;flushCachedRefresh();}
  }
  $('#google-connect').onclick=()=>authorize();
  const needsStatusRefresh=()=>!!feed?.configured&&!!feed?.sources.some(source=>['ready','stale','waiting','error'].includes(source.state));
  function flushCachedRefresh(){
    if((cachedRefreshPending||statusRefreshPending)&&!busy&&!locationSaving&&!authorizing&&live&&!document.hidden){
      // A successful feed read consumes queued timestamp checks. Notifications
      // still require their own cache read to cover later changes.
      const needed=cachedRefreshPending||needsStatusRefresh();
      cachedRefreshPending=statusRefreshPending=false;
      if(needed)void sync(false,false,true);
    }
  }
  window.addEventListener?.('roomly:calendarchanged',()=>{if(live){cachedRefreshPending=true;flushCachedRefresh();}});
  window.addEventListener?.('roomly:sourceschanged',()=>{
    if(!live)return;
    generation++;cachedRefreshPending=true;
    const rooms=[room()];feed=null;
    renderOwnStatus();
    $('#shared-calendar-list').innerHTML='';$('#shared-summary').textContent='已登入帳號';$('#shared-calendar-status').textContent='正在更新使用資格…';$('#google-connect').hidden=true;$('#google-disconnect').disabled=true;
    A.setLive({rooms,events:[],ready:false,availabilityComplete:false,message:syncMessage});
    flushCachedRefresh();
  });
  $('#google-start').onclick=()=>sync(true,true);
  $('#google-sync').onclick=()=>sync(true,true);$('#refresh-sources').onclick=()=>sync(false,true);
  $('#google-disconnect').onclick=async()=>{try{await access.request('calendar/disconnect',{});await sync();status('已停止分享；後端授權與我的會議快取已移除。可於 Google 第三方連線設定撤銷授權。');}catch(error){status(error.message);}};
  $('#google-demo').onclick=()=>{generation++;activeRun=0;busy=false;live=false;cachedRefreshPending=statusRefreshPending=false;renderOwnStatus();$('#google-sync').disabled=$('#google-start').disabled=$('#refresh-sources').disabled=false;$('#google-start').textContent='同步';A.showDemo();A.view('overview');status('目前查看這台裝置的本機資料；共用日曆仍由後端同步。');};
  $('#room-location').oninput=()=>{locationDirty=$('#room-location').value!==feed?.location;locationFeedback=null;renderLocation();};
  $('#location-filter').onsubmit=async e=>{
    e.preventDefault();if(locationSaving)return;
    if(!feed?.isAdmin){locationNotice(feed?'目前帳號沒有地點設定權限，請以管理員帳號登入。':'看板尚未載入，請點「同步」後再試一次。','error');return;}
    const value=$('#room-location').value.trim(),previousFeed=feed;
    if(!value||value.length>100){locationNotice('請輸入 1–100 字的會議室地點。','error');return;}
    locationSaving=true;locationDirty=true;locationNotice('正在儲存共用地點…');
    try{
      await access.request('calendar/location',{location:value});
      feed={...(feed||previousFeed),location:value};$('#room-location').value=value;locationDirty=false;generation++;
      A.setLive({rooms:[room()],events:[],ready:false,availabilityComplete:false,message:syncMessage});
      locationNotice(`地點已儲存：${value}`,'success');
      if(!await sync())locationNotice('地點已儲存，但看板更新失敗，請點「同步」重試。','error');
    }catch(error){locationNotice(error.message||'地點儲存失敗，請稍後重試。','error');}
    finally{locationSaving=false;renderLocation();flushCachedRefresh();}
  };
  renderLocation();
  window.GoogleSync={sync};
  if(access?.ready)void access.ready.then(async allowed=>{
    if(!allowed)return;
    const user=access.user?.();
    // The identity response is cheap: required consent must not wait behind
    // every member's calendar synchronization before opening Google's page.
    if(autoAuthorizePending&&typeof user?.calendarAuthorizationRequired==='boolean'){
      autoAuthorizePending=false;
      if(user.status==='approved'&&user.calendarConfigured===true&&user.calendarAuthorizationRequired===true){await authorize(true);if(authorizing)return;}
    }
    return sync();
  }).catch(()=>status('請先登入正式網站。'));
  setInterval(()=>{if(!document.hidden&&live&&!busy&&!locationSaving&&!authorizing)void sync();},10*60*1000);
  // Successful unchanged syncs advance syncedAt without changing calendarRevision.
  // Read committed timestamps for connected sources even when meetings are unchanged.
  setInterval(()=>{if(!document.hidden&&live&&!authorizing&&needsStatusRefresh()){statusRefreshPending=true;flushCachedRefresh();}},60*1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&live&&!busy&&!locationSaving&&!authorizing){if(cachedRefreshPending||statusRefreshPending)flushCachedRefresh();else void sync();}});
})();
