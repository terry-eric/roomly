(()=>{
  'use strict';
  const $=selector=>document.querySelector(selector),esc=RoomApp.esc;
  let currentSpace=null,currentInvite=null;
  const date=value=>value?new Intl.DateTimeFormat('zh-TW',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Taipei'}).format(new Date(typeof value==='number'?value*1000:value)):'尚未成功同步';
  const stateLabel={unauthorized:'尚未授權',connected:'已授權',reauthorize:'需要重新授權',success:'同步成功',ready:'同步成功',error:'同步失敗',failed:'同步失敗',pending:'等待同步',missing:'此範圍尚未同步',skipped:'尚未授權',running:'同步中',syncing:'同步中',sharing_disabled:'尚未同意分享'};
  const showError=message=>{for(const selector of ['#community-error','#login-error','#create-error']){$(selector).textContent=message||'';$(selector).hidden=!message;}if(message)RoomApp.notify(message);};
  const act=fn=>async event=>{event?.preventDefault();showError('');try{await fn(event);}catch(error){showError(error.message);}};
  function setCalendar(state){
    const ready=state==='connected';
    $('#calendar-state').textContent=stateLabel[state]||'尚未授權';
    $('#calendar-authorize').hidden=ready;
    $('#calendar-authorize').textContent=state==='reauthorize'?'重新授權我的日曆':'授權我的日曆';
    $('#calendar-disconnect').hidden=!ready;
    $('#calendar-help').textContent=ready?'授權已保留。只有按「同步會議」時才讀取日曆。':'每人需自行允許日曆唯讀存取，其他人才看得到符合空間地點的會議。';
  }
  const client=RoomlyCommunity.createClient({
    fetcher:(...args)=>fetch(...args),app:RoomApp,core:RoomCore,storage:sessionStorage,location,history,delay:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    ui:{
      authorizationNeeded(state){setCalendar(state);RoomApp.view('import');$('#calendar-authorize').focus({preventScroll:false});RoomApp.notify(state==='reauthorize'?'請先重新授權自己的日曆，再回到時間表同步。':'請先授權自己的日曆，再回到時間表同步。');},
      clear(){for(const id of ['detail-dialog','create-dialog'])if($('#'+id)?.open)$('#'+id).close();$('#detail').replaceChildren();$('#person-name').textContent='';try{$('#person-popover').hidePopover();}catch{}},
      session(data){
        $('#login-gate').hidden=!!data;
        $('#community-main').hidden=!data;
        $('#account-controls').hidden=!data;
        if(!data){$('#account-email').textContent='';$('#current-account').textContent='';$('#space-picker').replaceChildren();$('#members-list').replaceChildren();$('#created-invite').hidden=true;$('#invite-link').value='';$('#space-name').value='';$('#space-location').value='';return;}
        $('#account-email').textContent=data.user?.name||data.user?.email||'已登入';
        $('#current-account').textContent=data.user?.email||'';
        $('#space-picker').innerHTML='<option value="">選擇共用空間</option>'+data.spaces.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        if(currentSpace)$('#space-picker').value=currentSpace.id;
        setCalendar(data.calendar?.state||'unauthorized');
        $('#create-space').hidden=data.spaces.filter(s=>s.role==='owner').length>=3;
        $('#empty-spaces').hidden=!!data.spaces.length;
      },
      space(value){
        currentSpace=value;
        if(!value&&$('#board-fullscreen').getAttribute('aria-pressed')==='true')$('#board-fullscreen').click();
        const owner=value?.role==='owner';
        $('#space-picker').value=value?.id||'';
        document.body.dataset.space=value?'selected':'empty';
        $('#google-start').disabled=!value;
        $('#space-settings').hidden=!owner;
        $('#invitation-panel').hidden=!owner;
        $('#leave-space').hidden=!value||owner;
        $('#space-heading').textContent=value?.name||'我的共用空間';
        $('#location-label').textContent=value?.location||'';
        $('#members-list').replaceChildren();$('#pending-invites').replaceChildren();
        $('#created-invite').hidden=true;currentInvite=null;$('#invite-link').value='';$('#invite-target').textContent='';$('#space-name').value='';$('#space-location').value='';$('#sync-job').textContent='';$('#sync-job').hidden=true;
        if(owner){$('#space-name').value=value.name;$('#space-location').value=value.location;}
      },
      members(values){
        $('#member-count').textContent=String(values.length);
        $('#members-list').innerHTML=values.map(m=>`<article class="member-row"><div><strong>${esc(m.name||m.email)}</strong><span class="member-email">${esc(m.email)}</span><span class="member-state">${esc(stateLabel[m.calendarState||m.calendar?.state||m.state]||'尚未授權')}${m.role==='owner'?' · 空間管理員':''}</span></div>${currentSpace?.role==='owner'&&m.role!=='owner'?`<button type="button" class="quiet outlined" data-remove-member="${esc(m.sub)}">移除</button>`:''}</article>`).join('')||'<p class="muted">尚未加入其他成員。</p>';
      },
      invites(values){$('#pending-invites').innerHTML=values.map(invite=>`<article class="member-row"><div><strong>${esc(invite.email)}</strong><span class="member-state">有效至 ${esc(date(invite.expiresAt))}</span></div><button type="button" class="quiet outlined" data-revoke-invite="${esc(invite.id)}">撤銷邀請</button></article>`).join('')||'<p class="muted">目前沒有待接受的邀請。</p>';},
      sources(values){
        $('#shared-summary').textContent=`同步來源 · ${values.length} 位`;
        $('#shared-calendar-list').innerHTML=values.map(s=>`<article class="shared-calendar" data-state="${esc(s.state)}"><div><strong>${esc(s.name||s.email)}</strong><span class="member-email">${esc(s.email)}</span><small>${esc(stateLabel[s.state]||'尚未同步')} · ${Number.isInteger(s.calendarCount)?`${s.calendarCount} 個日曆`:''}</small><small>最後成功同步：${esc(date(s.syncedAt))}</small></div></article>`).join('')||'<p class="muted">按「同步會議」後會顯示每位來源的結果。</p>';
      },
      busy(value){$('#google-start').disabled=value||!currentSpace;$('#google-start').textContent=value?'同步中…':'同步會議';if(value)$('#sync-job').hidden=false;},
      job(job){const status=['complete','completed'].includes(job.status)?'同步完成':job.status==='partial'?'部分來源未完成':['error','failed','cancelled'].includes(job.status)?'同步未完成':'正在同步';$('#sync-job').hidden=false;$('#sync-job').textContent=`${status} · ${job.completed||0}／${job.total||0} 位 · 成功 ${job.succeeded||0} · 未完成 ${job.failed||0}`;},
      message(message){$('#sync-job').hidden=false;$('#sync-job').textContent=message;},
      error:showError,
      invite(invite){
        $('#join-invite').hidden=!invite;
        if(!invite)return;
        $('#join-space-name').textContent=invite.spaceName;
        $('#join-email').textContent=invite.email;
        $('#join-accept').disabled=!invite.canAccept;
        $('#join-help').textContent=invite.canAccept?'請確認分享範圍，再加入這個空間。':'這封邀請指定了另一個 Google 帳號，請改用上方 Email 登入。';
      },
      newInvite(invite){
        currentInvite=invite;$('#created-invite').hidden=!invite;
        if(invite){$('#invite-target').textContent=invite.email;$('#invite-link').value=invite.url;$('#invite-expiry').textContent=`有效至 ${date(invite.expiresAt)}；請自行將連結交給這位成員。`;}else{$('#invite-target').textContent='';$('#invite-link').value='';$('#invite-expiry').textContent='';}
      },
    },
  });
  window.GoogleSync={sync:()=>client.readFeed().catch(error=>showError(error.message))};
  $('#google-login').onclick=()=>client.login();
  $('#sign-out').onclick=act(()=>client.logout());
  $('#space-picker').onchange=act(event=>client.selectSpace(event.target.value));
  $('#google-start').onclick=act(()=>client.manualSync());
  $('#refresh-sources').onclick=act(()=>Promise.all([client.readFeed(),client.members()]));
  $('#calendar-authorize').onclick=act(()=>client.authorize());
  $('#calendar-disconnect').onclick=act(()=>client.disconnect());
  $('#create-space').onclick=()=>$('#create-dialog').showModal();
  $('#close-create').onclick=()=>$('#create-dialog').close();
  $('#create-space-form').onsubmit=act(async event=>{const form=event.target;if(!form.reportValidity())return;await client.createSpace({name:form.elements.name.value.trim(),location:form.elements.location.value.trim(),shareConsent:form.elements.shareConsent.checked});form.reset();$('#create-dialog').close();});
  $('#space-settings-form').onsubmit=act(event=>client.settings({name:$('#space-name').value.trim(),location:$('#space-location').value.trim()}));
  $('#invite-form').onsubmit=act(event=>client.invite(event.target.elements.email.value.trim()));
  $('#copy-invite').onclick=act(async()=>{try{await navigator.clipboard.writeText($('#invite-link').value);RoomApp.notify('邀請連結已複製。');}catch{$('#invite-link').focus();$('#invite-link').select();RoomApp.notify('請長按欄位或使用複製功能。');}});
  $('#revoke-invite').onclick=act(()=>currentInvite&&client.revokeInvite(currentInvite.id));
  $('#pending-invites').onclick=act(event=>{const button=event.target.closest('[data-revoke-invite]');if(button)return client.revokeInvite(button.dataset.revokeInvite);});
  $('#members-list').onclick=act(event=>{const button=event.target.closest('[data-remove-member]');if(button)return client.removeMember(button.dataset.removeMember);});
  $('#leave-space').onclick=act(()=>client.leave());
  $('#join-form').onsubmit=act(()=>client.acceptInvite($('#join-consent').checked));
  $('#join-cancel').onclick=()=>client.cancelInvite();
  $('#refresh-members').onclick=act(()=>Promise.all([client.refreshMe(),client.members()]));
  RoomApp.setLive({events:[],rooms:[],ready:false,availabilityComplete:false,message:'登入後選擇自己的共用空間。'});
  client.init();
})();
