(function(root){
  'use strict';
  function createClient({fetcher,app,core,ui,storage,location,history,delay}){
    const prefix='/roomly/api/';
    let me=null,space=null,generation=0,accountVersion=0,spaceVersion=0,running=false,manualRun=null,pendingInvite='';
    const signal=(name,value)=>ui[name]?.(value);
    const context=()=>({account:accountVersion,space:spaceVersion,id:space?.id||null});
    const valid=state=>state.account===accountVersion&&state.space===spaceVersion&&state.id===(space?.id||null);
    const range=()=>{const days=app.days(),last=new Date(days.at(-1)+'T00:00:00Z');last.setUTCDate(last.getUTCDate()+1);return {start:days[0],end:last.toISOString().slice(0,10)};};
    function empty(message='請按「同步會議」取得最新會議。'){
      signal('clear');
      app.setLive({events:[],rooms:space?[{id:space.id,name:space.name,meta:space.location,style:''}]:[],ready:false,availabilityComplete:false,message});
      signal('sources',[]);
    }
    function reset(){accountVersion++;spaceVersion++;generation++;running=false;manualRun=null;space=null;me=null;empty('登入後選擇自己的共用空間。');signal('session',null);signal('space',null);signal('busy',false);}
    function forgetInvite(){pendingInvite='';try{storage.removeItem('roomly.public.invite');}catch{}history.replaceState(null,'',location.pathname);signal('invite',null);}
    async function api(path,{method='GET',body}={}){
      const requested=context();
      const response=await fetcher(prefix+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
      let data;try{data=await response.json();}catch{throw Error('伺服器暫時無法回應，請稍後再試。');}
      if(!response.ok){if(response.status===401&&requested.account===accountVersion)reset();if(response.status===403&&valid(requested)){spaceVersion++;generation++;running=false;manualRun=null;space=null;empty('你已無法存取這個空間，請重新選擇。');signal('space',null);signal('members',[]);signal('busy',false);}const error=Error(data.error||'操作未完成，請稍後再試。');error.status=response.status;throw error;}
      return data;
    }
    async function previewInvite(){if(!pendingInvite||!me)return;const requested=context(),token=pendingInvite,data=await api('invites/preview',{method:'POST',body:{token}});if(valid(requested)&&token===pendingInvite)signal('invite',data.invite);return valid(requested)?data.invite:null;}
    async function refreshMe(){const account=accountVersion,data=await api('me');if(account!==accountVersion)return null;me=data;signal('session',me);if(pendingInvite)await previewInvite();if(account!==accountVersion)return null;if(space&&!me.spaces.some(s=>s.id===space.id)){spaceVersion++;generation++;running=false;manualRun=null;space=null;empty('你已不在這個空間內。');signal('space',null);signal('members',[]);signal('busy',false);}return me;}
    async function members(){if(!space)return;const requested=context(),data=await api(`spaces/${encodeURIComponent(space.id)}/members`);if(valid(requested)){signal('members',data.members||[]);signal('invites',data.invites||[]);}}
    async function readFeed(){
      if(!me||!space)return;const selected={...space},requested=context(),version=++generation,currentRange=range();empty('載入已同步的會議…');
      try{
        const data=await api(`spaces/${encodeURIComponent(selected.id)}/feed?${new URLSearchParams(currentRange)}`);
        if(version!==generation||!valid(requested))return;
        if(data.space&&data.space.id!==selected.id)throw Error('資料與目前空間不符，請稍後重新讀取。');
        if(data.space)space={...space,...data.space};
        const events=core.mergeGoogle([{calendar:{id:selected.id,name:space.name,kind:'room'},events:data.events||[]}]);
        const missing=!!data.rangeMissing,failed=(data.sources||[]).some(s=>!['ready','success','connected'].includes(s.state));
        app.setLive({events,rooms:[{id:selected.id,name:space.name,meta:space.location,style:''}],ready:true,availabilityComplete:!missing&&!failed,message:missing?'這個日期範圍尚未同步，請按「同步會議」。':'顯示最後成功取得的資料。新增或變更會議後，請按「同步會議」。'});
        signal('sources',data.sources||[]);signal('space',space);signal('feed',data);
      }catch(error){if(version===generation)empty('暫時無法讀取會議。請稍後重試。');throw error;}
    }
    async function selectSpace(id){spaceVersion++;generation++;running=false;manualRun=null;signal('busy',false);space=me?.spaces.find(s=>s.id===id)||null;empty();signal('space',space);if(space)await Promise.all([readFeed(),members()]);}
    async function manualSync(){
      if(!space||running)return;
      if(me?.calendar?.state!=='connected'){signal('authorizationNeeded',me?.calendar?.state||'unauthorized');return;}
      const selected=space.id,requested=context(),run={};manualRun=run;running=true;signal('busy',true);
      try{
        const data=await api(`spaces/${encodeURIComponent(selected)}/sync`,{method:'POST',body:range()});
        let job=data.job;
        if(!job?.id)throw Error('同步工作未建立，請稍後再試。');
        for(let tries=0;tries<90;tries++){
          if(manualRun!==run||!valid(requested))return;
          signal('job',job);
          if(['complete','completed','partial','failed','error','cancelled'].includes(job.status)){await readFeed();if(valid(requested))await members();if(valid(requested))await refreshMe();return job;}
          await delay(2000);
          if(manualRun!==run||!valid(requested))return;
          job=(await api(`spaces/${encodeURIComponent(selected)}/jobs/${encodeURIComponent(job.id)}`)).job;
          if(!job?.id)throw Error('暫時無法取得同步結果，請稍後按「查看同步結果」。');
        }
        if(valid(requested))signal('message','同步仍在處理中。稍後按「查看同步結果」即可讀取已完成的資料。');
      }finally{if(manualRun===run){manualRun=null;running=false;signal('busy',false);}}
    }
    async function createSpace(values){const requested=context(),data=await api('spaces',{method:'POST',body:values});if(!valid(requested))return;await refreshMe();if(!valid(requested))return;await selectSpace(data.space.id);return requested.account===accountVersion&&space?.id===data.space.id?data.space:null;}
    async function settings(values){if(!space)return;const requested=context();await api(`spaces/${encodeURIComponent(space.id)}/settings`,{method:'POST',body:values});if(!valid(requested))return;await refreshMe();if(!valid(requested))return;space=me.spaces.find(s=>s.id===requested.id);signal('space',space);await readFeed();}
    async function invite(email){if(!space)return;const requested=context(),data=await api(`spaces/${encodeURIComponent(space.id)}/invites`,{method:'POST',body:{email}});if(valid(requested)){signal('newInvite',data.invite);await members();}return valid(requested)?data.invite:null;}
    async function revokeInvite(id){if(!space)return;const requested=context();await api(`spaces/${encodeURIComponent(space.id)}/invites/${encodeURIComponent(id)}/revoke`,{method:'POST',body:{}});if(valid(requested)){signal('newInvite',null);await members();}}
    async function removeMember(sub){if(!space)return;const requested=context();await api(`spaces/${encodeURIComponent(space.id)}/members/${encodeURIComponent(sub)}`,{method:'DELETE'});if(!valid(requested))return;await members();if(valid(requested))await readFeed();}
    async function acceptInvite(consent){if(!consent)throw Error('請先同意在這個空間分享符合地點的會議。');const requested=context(),token=pendingInvite,data=await api('invites/accept',{method:'POST',body:{token,shareConsent:true}});if(!valid(requested)||token!==pendingInvite)return;forgetInvite();await refreshMe();if(valid(requested))await selectSpace(data.space?.id||data.spaceId);}
    async function leave(){if(!space)return;const requested=context();await api(`spaces/${encodeURIComponent(space.id)}/leave`,{method:'POST',body:{}});if(!valid(requested))return;spaceVersion++;space=null;generation++;running=false;manualRun=null;empty();signal('space',null);signal('busy',false);await refreshMe();}
    async function authorize(){const requested=context(),data=await api('calendar/start',{method:'POST',body:{}});if(!valid(requested))return;const target=new URL(data.url);if(target.protocol!=='https:'||target.hostname!=='accounts.google.com')throw Error('授權網址無效。');location.assign(target.href);}
    async function disconnect(){const requested=context();await api('calendar/disconnect',{method:'POST',body:{}});if(!valid(requested))return;generation++;empty('日曆授權已移除，其他成員不會再看到你的會議。');await refreshMe();if(valid(requested)&&space)await Promise.all([readFeed(),members()]);}
    async function logout(){reset();forgetInvite();await api('logout',{method:'POST',body:{}});}
    async function init(){
      reset();
      const parameters=new URLSearchParams(location.search),token=parameters.get('invite');
      const authorizationMessages={cancelled:'你取消了 Google 授權。需要時可在空間設定重新授權。',failed:'Google 授權未完成，請在空間設定重試。',permissions:'請勾選完整的日曆唯讀與日曆清單權限，再重新授權。',wrong_account:'授權帳號與登入帳號不同，請選擇目前登入的 Google 帳號。',refresh_required:'Google 未提供持續授權，請在空間設定重新授權。',expired:'授權流程已過期，請重新開始。'};
      const authorizationMessage=authorizationMessages[parameters.get('calendar')]||authorizationMessages[parameters.get('login')];
      if(token&&/^[a-f0-9]{64,128}$/.test(token)){pendingInvite=token;try{storage.setItem('roomly.public.invite',token);}catch{}}
      else try{pendingInvite=storage.getItem('roomly.public.invite')||'';}catch{}
      // Strip OAuth status and secret invitation tokens before any navigation or external links.
      history.replaceState(null,'',location.pathname);
      const account=accountVersion;
      try{await refreshMe();if(account!==accountVersion)return;if(me.spaces.length&&!pendingInvite)await selectSpace(me.spaces[0].id);if(authorizationMessage&&account===accountVersion)signal('error',authorizationMessage);}catch(error){if(error.status===401&&!authorizationMessage&&!me){signal('error','');return;}if(account===accountVersion||!me)signal('error',authorizationMessage||error.message);}
    }
    function login(){location.assign(prefix+'login/start');}
    return {init,login,logout,refreshMe,selectSpace,readFeed,manualSync,createSpace,settings,invite,revokeInvite,removeMember,acceptInvite,leave,authorize,disconnect,members,cancelInvite:forgetInvite};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={createClient};else root.RoomlyCommunity={createClient};
})(typeof globalThis!=='undefined'?globalThis:this);
