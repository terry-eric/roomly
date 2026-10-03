'use strict';
(() => {
  const A=window.RoomlyAccess,status=text=>document.querySelector('#access-status').textContent=text;
  const element=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
  function emailCard(entry){
    const box=element('article','','member-card'),details=element('div',''),actions=element('div','','member-actions');
    details.append(element('h3',entry.email),element('p',entry.status==='approved'?(entry.member_sub?'已加入白名單 · 已登入':'已加入白名單 · 等待首次登入'):'已移除白名單','member-meta'));
    if(entry.name)details.append(element('p',entry.name));
    const button=element('button',entry.status==='approved'?'移除資格':'重新加入',entry.status==='approved'?'secondary':'');button.type='button';button.onclick=async()=>{
      button.disabled=true;try{await A.request(`admin/allowlist/${entry.status==='approved'?'remove':'add'}`,{email:entry.email});await load();status(`${entry.email} 已${entry.status==='approved'?'移除資格':'加入白名單'}。`);}catch(error){status(error.message);button.disabled=false;}
    };actions.append(button);box.append(details,actions);return box;
  }
  function card(member){
    const box=element('article','','member-card'),details=element('div',''),actions=element('div','','member-actions');
    details.append(element('h3',member.name),element('p',member.email));
    const labels={pending:'待審核',approved:'已核准',rejected:'未核准'};
    const at=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(member.requested_at*1000));
    details.append(element('p',`${labels[member.status]} · ${at} 申請${member.role==='admin'?' · 管理員':''}`,'member-meta'));
    if(member.notification)details.append(element('p',member.notification==='sent'?'Email 通知已送交寄信服務':'Email 通知等待寄送／重試中','member-meta'));
    if(member.role!=='admin')for(const [decision,label]of [['approved','核准'],['rejected',member.status==='approved'?'移除資格':'拒絕']]){
      if(member.status===decision)continue;const button=element('button',label,decision==='rejected'?'secondary':'');button.type='button';button.addEventListener('click',async()=>{
        for(const b of actions.querySelectorAll('button'))b.disabled=true;
        try{await A.request('admin/review',{sub:member.sub,status:decision});await load();status(`${member.email} 已${decision==='approved'?'核准':'取消使用資格'}。`);}catch(error){status(error.message);for(const b of actions.querySelectorAll('button'))b.disabled=false;}
      });actions.append(button);
    }
    box.append(details,actions);return box;
  }
  async function load(){
    try{const [data,allowlist]=await Promise.all([A.request('admin/members'),A.request('admin/allowlist')]),pending=data.members.filter(m=>m.status==='pending'),approvedEmails=allowlist.emails.filter(entry=>entry.status==='approved');document.querySelector('#pending-heading').textContent=`待審核 · ${pending.length}`;
      document.querySelector('#allowlist-members').replaceChildren(...(approvedEmails.length?approvedEmails.map(emailCard):[element('p','目前沒有自行新增的白名單 Email。','empty-list')]));
      for(const [id,members]of [['pending-members',pending],['reviewed-members',data.members.filter(m=>m.status==='approved')]]){
        const list=document.querySelector('#'+id);list.replaceChildren(...(members.length?members.map(card):[element('p','目前沒有名單。','empty-list')]));
      }status('名單已更新。');
    }catch(error){status(error.message);}
  }
  document.querySelector('#refresh-members').onclick=load;
  document.querySelector('#allowlist-form').onsubmit=async e=>{
    e.preventDefault();const button=document.querySelector('#allowlist-add'),input=document.querySelector('#allowlist-email');button.disabled=true;
    try{const result=await A.request('admin/allowlist/add',{email:input.value});input.value='';await load();status(`${result.email} 已加入白名單。`);}catch(error){status(error.message);}finally{button.disabled=false;}
  };
  document.querySelector('#retry-mail').onclick=async e=>{e.target.disabled=true;try{await A.request('admin/retry-notifications',{});await load();}catch(error){status(error.message);}finally{e.target.disabled=false;}};
  void A.ready.then(allowed=>{if(allowed){document.querySelector('#allowlist-add').disabled=false;return load();}});
  setInterval(()=>{if(!document.hidden)void load();},60000);
})();
