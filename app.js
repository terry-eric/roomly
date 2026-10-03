'use strict';
const C=RoomCore, $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localRooms=[{id:'forest',name:'主會議室',english:'',meta:'單一會議室',style:''}];
let today=C.date(Date.now());
const storageKey='roomly.single-room.bookings.v2';
let bookings=[],mode='local',liveEvents=[],liveRooms=[],liveReady=false,availabilityComplete=false,liveStart='',renderedStart='',toastTimer,timelineRange='day',agendaDay=null,followNow=true,centerFrame=0;
try{
  const saved=localStorage.getItem(storageKey),legacy=localStorage.getItem('roomly.bookings.v1');
  const stored=JSON.parse(saved||legacy||'null');
  if(Array.isArray(stored)){
    bookings=C.removeDemoBookings(stored).map(e=>{C.validate(e);if(!Array.isArray(e.attendees))throw Error();return {...e,originalRoom:e.originalRoom||e.room,room:'forest'};});
    localStorage.setItem(storageKey,JSON.stringify(bookings));
  }
}catch{ /* A corrupt local store leaves the board empty; no samples are regenerated. */ }
try{const legacy=JSON.parse(localStorage.getItem('roomly.bookings.v1')||'null');if(Array.isArray(legacy))localStorage.setItem('roomly.bookings.v1',JSON.stringify(C.removeDemoBookings(legacy)));}catch{}
$('#day').value=today;
for(const id of ['skip-weekends','skip-holidays'])try{$('#'+id).checked=localStorage.getItem('roomly.'+id)==='true';}catch{}
const boardDays=()=>C.boardDays($('#day').value,$('#skip-weekends').checked,$('#skip-holidays').checked);
const boardRange=()=>boardDays().join(',');
let followedScrollLeft=0;
const getRooms=()=>mode==='google'?liveRooms:localRooms;
const asEvent=e=>({...e,roomIds:['forest'],busyRoomIds:['forest'],startISO:`${e.date}T${e.start}:00+08:00`,endISO:`${e.date}T${e.end}:00+08:00`});
const inDay=(e,day)=>C.overlaps(Date.parse(e.startISO),Date.parse(e.endISO),C.instant(day,'00:00'),C.instant(day,'00:00')+86400000);
const getBoardEvents=()=>{
  const days=boardDays();
  const events=mode==='google'?liveEvents.filter(e=>getRooms().some(r=>e.roomIds.includes(r.id))):bookings.map(asEvent);
  return events.filter(e=>C.overlapsDays(Date.parse(e.startISO),Date.parse(e.endISO),days));
};
const getEvents=()=>getBoardEvents().filter(e=>inDay(e,boardDays()[0]));
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);}
function persist(next){try{localStorage.setItem(storageKey,JSON.stringify(next));bookings=next;return true;}catch{notify('瀏覽器無法儲存資料，這次變更未儲存。');return false;}}
function view(name){document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===name));$('#breadcrumb').textContent={overview:'預約總覽',people:'使用名單',import:'設定'}[name];renderPeople();if(name==='overview')refreshNow();}
function roomLabel(e){return e.roomIds.map(id=>getRooms().find(r=>r.id===id)?.name||id).join('、')||e.location||'未指定 / 線上';}
function eventTime(e,day=$('#day').value){if(e.allDay)return '全天';return `${C.date(e.startISO)!==day?C.date(e.startISO)+' ':''}${C.time(e.startISO)} — ${C.date(e.endISO)!==day?C.date(e.endISO)+' ':''}${C.time(e.endISO)}`;}
function render(){
  $('#room-name').textContent=getRooms()[0]?.name||'尚未指定會議室日曆';
  renderTable();renderPeople();
}
function renderTable(){renderGantt(getBoardEvents());}
function renderGantt(items){
  hidePerson();
  const [from,to]=({morning:[540,720],afternoon:[720,1140],day:[540,1140]})[timelineRange];
  const slots=(to-from)/30,room=getRooms()[0],known=(mode==='google'?liveReady:bookings.length>0)&&!!room;
  const days=boardDays(),weekdays=['週日','週一','週二','週三','週四','週五','週六'];
  if(renderedStart!==boardRange()){$('#gantt-scroll').scrollTop=0;renderedStart=boardRange();}
  const filtered=$('#skip-weekends').checked||$('#skip-holidays').checked;
  $('#week-label').textContent=`${days[0].replaceAll('-','/')} – ${days[4].slice(5).replace('-','/')} · ${filtered?'五個顯示日':'五天'} · 台北時間`;
  $('#prev-date').setAttribute('aria-label',filtered?'前五個顯示日':'前五天');
  $('#next-date').setAttribute('aria-label',filtered?'後五個顯示日':'後五天');
  const holidayYears=C.holidayYears||[],unknownYears=[...new Set(days.map(day=>Number(day.slice(0,4))))].filter(year=>!holidayYears.includes(year));
  $('#holiday-scope').textContent=`台灣國定假日／補假 · ${holidayYears.length?holidayYears.join('、'):'尚無資料'}${unknownYears.length?`；${unknownYears.join('、')} 無假日資料`:''}${days[0]!==$('#day').value?`；起始日已略過，從 ${days[0].replaceAll('-','/')} 顯示`:''}`;
  $('#meeting-count').textContent=`· ${items.length} 場`;
  const label=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
  const ticks=Array.from({length:slots},(_,i)=>`<span data-minute="${from+i*30}" class="gantt-tick ${i%2?'half-hour':''}">${label(from+i*30)}</span>`).join('');
  const visible=new Set();
  const content=days.map(day=>{
    const weekday=new Date(`${day}T12:00:00+08:00`).getUTCDay(),weekend=weekday===0||weekday===6,holiday=C.holiday(day);
    const daily=items.filter(e=>inDay(e,day)),layout=C.timelineLayout(daily,day,from,to);
    const bars=layout.bars.map(bar=>{
      const e=bar.event,nonBlocking=!e.busyRoomIds.includes(room?.id);visible.add(e.id);
      const time=eventTime(e,day),description=`${day} ${e.title}，${time}，${e.attendees.length} 位參與者${nonBlocking?'，不占用時段':''}`;
      const people=[...new Set(e.attendees.map(name=>name.trim()).filter(Boolean))];
      const avatars=people.map(name=>{
        const color=[...name].reduce((sum,c)=>sum+c.codePointAt(0),0)%5;
        return `<button type="button" class="person-dot tone-${color}" data-person="${esc(name)}" aria-label="查看 ${esc(name)} 的姓名" aria-controls="person-popover" aria-expanded="false"><span>${esc([...name][0].toLocaleUpperCase())}</span></button>`;
      }).join('');
      return `<div class="gantt-bar ${nonBlocking?'non-blocking':''}" data-start="${Date.parse(e.startISO)}" data-end="${Date.parse(e.endISO)}" style="left:${bar.left}%;width:${bar.width}%;top:${10+bar.lane*128}px"><button class="gantt-event-button" data-detail="${esc(e.id)}" title="${esc(description)}" aria-label="${esc(description)}"><strong>${bar.continuesBefore?'‹ ':''}${esc(e.title)}${bar.continuesAfter?' ›':''}</strong><span>${esc(time.replaceAll(' — ','–'))}</span></button><div class="booking-people" role="group" aria-label="${people.length} 位參與者，可左右滑動">${avatars||'<span class="no-people">未提供名單</span>'}</div></div>`;
    }).join('');
    return `<div data-date="${day}" class="gantt-row ${day===today?'is-today':''} ${weekend?'weekend':''} ${holiday?'is-holiday':''}" style="--row-height:${layout.lanes*128+12}px"><button class="gantt-room day-button" data-day="${day}" aria-label="查看 ${day} ${weekdays[weekday]}${holiday?`（${esc(holiday)}）`:weekend?'（週末）':''} 的會議" ${day===today?'aria-current="date"':''}><strong>${weekdays[weekday]}${day===today?' <em>今天</em>':''}</strong><span>${day.slice(5).replace('-',' / ')}</span>${holiday?`<span class="holiday-badge">${esc(holiday)}</span>`:''}</button><div class="gantt-track ${known?'':'unknown'}"><div class="gantt-track-body">${day===today?'<div class="now-slot" hidden aria-hidden="true"></div><div class="now-line" hidden><span></span></div>':''}${bars}${!layout.bars.length?`<span class="gantt-row-empty">${daily.length?`另有 ${daily.length} 場 · 點日期查看`:''}</span>`:''}</div></div></div>`;
  }).join('');
  $('#gantt').dataset.followLayout=String(followNow);
  $('#gantt').style.setProperty('--slots',slots);
  $('#gantt').dataset.from=from;$('#gantt').dataset.to=to;
  $('#gantt').innerHTML=`<div class="gantt-grid"><div class="gantt-axis"><div class="gantt-corner">日期 <small>台北時間</small></div><div class="gantt-ticks">${ticks}<span class="gantt-end">${label(to)}</span></div></div>${content}</div>`;
  const outside=items.filter(e=>!visible.has(e.id)).length;
  $('#gantt-note').textContent=`${outside?`另有 ${outside} 場不在此時段；點日期查看整天。`:'實心色塊是預約，虛線色塊不占用時段。'}${timelineRange==='day'?' 全日 09:00–19:00 可左右滑動。':''}`;
  refreshNow();
}
function followControls(){
  $('#follow-now').classList.toggle('active',followNow);
  $('#follow-now').setAttribute('aria-pressed',String(followNow));
  $('#follow-now').setAttribute('aria-label',`${followNow?'正在跟隨':'回到'}現在 ${C.time(Date.now())}`);
  if(followNow)document.querySelectorAll('[data-range]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');});
}
function pauseFollowing(){followNow=false;cancelAnimationFrame(centerFrame);followControls();}
function centerCurrentTime(){
  if(!followNow||$('#overview').hidden||document.querySelector('dialog[open]')||personOpen())return;
  const host=$('#gantt-scroll'),line=$('.now-line:not([hidden])');
  const todayRow=document.querySelector(`.gantt-row[data-date="${today}"]`);
  if(host.clientWidth===0)return;
  if(!todayRow){$('#gantt').dataset.followLayout='false';$('#gantt').style.setProperty('--now-edge','0px');followedScrollLeft=0;host.scrollTo({left:0,top:host.scrollTop,behavior:'instant'});return;}
  const labelWidth=$('.gantt-corner').getBoundingClientRect().width;
  $('#gantt').dataset.followLayout=String(!!line);
  $('#gantt').style.setProperty('--now-edge',`${line?Math.max(0,(host.clientWidth-labelWidth)/2):0}px`);
  const rect=host.getBoundingClientRect();
  const x=line?C.centeredScroll(line.getBoundingClientRect().left-rect.left+host.scrollLeft,host.clientWidth,labelWidth,host.scrollWidth-host.clientWidth)
    :(C.currentSlot(Date.now(),540,1140).minute<540?0:host.scrollWidth-host.clientWidth);
  // Follow the time horizontally while preserving the dates the user scrolled to.
  followedScrollLeft=x;
  host.scrollTo({left:x,top:host.scrollTop,behavior:'instant'});
}
function refreshNow(){
  fitCalendar();
  const now=Date.now(),currentDay=C.date(now);
  $('#now-clock').textContent=C.time(now);
  if(currentDay!==today){
    const previousDay=today;today=currentDay;
    if(followNow||$('#day').value===previousDay){$('#day').value=today;dayChanged();}else renderTable();
    return;
  }
  const grid=$('#gantt');
  if(!grid.dataset.from)return;
  const info=C.currentSlot(now,Number(grid.dataset.from),Number(grid.dataset.to));
  const inWorkingHours=info.minute>=540&&info.minute<1140;
  $('#hours-state').textContent=inWorkingHours?'會議時段 09:00–19:00':'目前為非會議時段 · 09:00–19:00 開放';
  const inRange=boardDays().includes(info.day),visible=info.visible&&inRange;
  document.querySelectorAll('.gantt-tick').forEach(t=>{
    const active=visible&&Number(t.dataset.minute)===info.start;
    t.classList.toggle('is-current',active);
    if(active)t.setAttribute('aria-current','time');else t.removeAttribute('aria-current');
  });
  const slot=$('.now-slot'),line=$('.now-line');
  if(slot&&line){
    slot.hidden=line.hidden=!visible;
    slot.style.left=`${info.left}%`;slot.style.width=`${info.width}%`;
    line.style.left=`${info.nowLeft}%`;line.querySelector('span').textContent=`現在 ${info.label}`;
  }
  document.querySelectorAll('.gantt-bar').forEach(bar=>{
    const running=Number(bar.dataset.start)<=now&&now<Number(bar.dataset.end);
    bar.classList.toggle('is-running',running);
  });
  followControls();
  if(followNow){cancelAnimationFrame(centerFrame);centerFrame=requestAnimationFrame(centerCurrentTime);}
}
function resumeFollowing(){
  followNow=true;timelineRange='day';today=C.date(Date.now());$('#day').value=today;$('#gantt-scroll').scrollTop=0;
  followControls();dayChanged();
}
function fitCalendar(){
  if($('#overview').hidden)return;
  const host=$('#gantt-scroll'),caption=$('.gantt-caption');
  if(document.body.classList.contains('board-fullscreen')){host.style.removeProperty('--calendar-height');return;}
  const viewport=window.visualViewport?.height||window.innerHeight;
  const minimum=parseFloat(getComputedStyle(host).minHeight)||240;
  const height=Math.max(minimum,viewport-(host.getBoundingClientRect().top+window.scrollY)-caption.offsetHeight-96);
  host.style.setProperty('--calendar-height',`${height}px`);
}
let personAnchor=null;
function personOpen(){return $('#person-popover').dataset.open==='true';}
function resetPersonButtons(){document.querySelectorAll('[data-person][aria-expanded="true"]').forEach(b=>b.setAttribute('aria-expanded','false'));}
function hidePerson(restoreFocus=false){
  const popover=$('#person-popover');
  if(!personOpen())return;
  if(popover.dataset.fallback==='true'){
    popover.hidden=true;popover.dataset.open='false';resetPersonButtons();
    if(restoreFocus===true&&personAnchor?.isConnected)personAnchor.focus({preventScroll:true});
    refreshNow();
  }else popover.hidePopover();
}
function showPerson(button){
  const popover=$('#person-popover');
  hidePerson();
  $('#person-name').textContent=button.dataset.person;
  personAnchor=button;
  if(popover.dataset.fallback==='true')popover.hidden=false;else popover.showPopover();
  popover.dataset.open='true';
  button.setAttribute('aria-expanded','true');
  const anchor=button.getBoundingClientRect(),bubble=popover.getBoundingClientRect();
  popover.style.left=`${Math.max(8,Math.min(window.innerWidth-bubble.width-8,anchor.left+anchor.width/2-bubble.width/2))}px`;
  const top=anchor.bottom+8;
  popover.style.top=`${Math.max(8,Math.min(window.innerHeight-bubble.height-8,top+bubble.height<window.innerHeight?top:anchor.top-bubble.height-8))}px`;
  if(popover.dataset.fallback==='true')popover.querySelector('button').focus({preventScroll:true});
}
function renderPeople(){const map=new Map();for(const e of getEvents())for(const name of new Set([e.organizer,...e.attendees].filter(n=>n!=='未提供'))){if(!map.has(name))map.set(name,[]);map.get(name).push(e);}$('#people-list').innerHTML=[...map].map(([name,events])=>`<article class="person"><span class="avatar">${esc([...name][0])}</span><h3>${esc(name)}</h3><p>所選日期 · ${events.length} 場會議</p><p>${esc([...new Set(events.map(roomLabel))].join(' · '))}</p></article>`).join('')||'<p class="muted">所選日期目前沒有參與名單。</p>';}
function openBooking(room){if(mode==='google')return;const f=$('#booking-form');f.reset();f.elements.room.innerHTML=localRooms.map(r=>`<option value="${r.id}">${r.name} ${r.english}</option>`).join('');f.elements.date.value=$('#day').value;f.elements.start.value=timelineRange==='afternoon'?'13:00':'10:00';f.elements.end.value=timelineRange==='afternoon'?'14:00':'11:00';if(room)f.elements.room.value=room;$('#form-error').textContent='';$('#booking-dialog').showModal();}
function showDay(day){
  agendaDay=day;
  const events=getBoardEvents().filter(e=>inDay(e,day)).sort((a,b)=>Date.parse(a.startISO)-Date.parse(b.startISO));
  const heading=new Intl.DateTimeFormat('zh-TW',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Taipei'}).format(new Date(`${day}T12:00:00+08:00`));
  $('#detail').innerHTML=`<h2>${esc(heading)}</h2><p class="agenda-note">整天的會議 · 點一下查看參與名單</p><div class="agenda-list">${events.map(e=>`<button class="agenda-item" data-detail="${esc(e.id)}"><div><strong>${esc(e.title)}</strong><span>${esc(eventTime(e,day))} · ${e.attendees.length} 位</span></div><i aria-hidden="true">›</i></button>`).join('')||'<p class="agenda-empty">此日沒有可顯示的會議。</p>'}</div>`;
  $('#back-to-day').hidden=true;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
function showDetail(id){const e=getBoardEvents().find(e=>e.id===id);if(!e)return;const status={accepted:'已接受',declined:'已婉拒',tentative:'暫定',needsAction:'尚未回覆'};$('#detail').innerHTML=`<p class="eyebrow">MEETING DETAILS</p><h2>${esc(e.title)}</h2><div class="detail-info"><span>日期與時間（台北）</span>${C.date(e.startISO)} · ${eventTime(e,C.date(e.startISO))}</div><div class="detail-info"><span>主辦人</span>${esc(e.organizer)}</div><div class="detail-info"><span>受邀參與者（不代表實際出席）</span>${e.attendeeDetails?e.attendeeDetails.map(p=>`${esc(p.name)} · ${esc(status[p.status]||p.status)}`).join('<br>'):esc(e.attendees.join('、')||'尚未提供')}${e.attendeesOmitted?'<p>Google 僅提供部分參與者名單。</p>':''}</div>${C.safeMeet(e.meet)?`<p><a class="meet-link" href="${esc(C.safeMeet(e.meet))}" target="_blank" rel="noopener noreferrer">加入 Google Meet ↗</a></p>`:''}${mode==='local'?`<button class="quiet delete-button" id="remove-booking" data-id="${esc(e.id)}">刪除此筆本機預約</button>`:''}`;$('#back-to-day').hidden=!agendaDay;if(!$('#detail-dialog').open)$('#detail-dialog').showModal();}
function setLive({events=[],rooms=[],ready=false,message='',availabilityComplete:complete=true}){mode='google';availabilityComplete=complete;liveEvents=events;liveRooms=rooms;liveReady=ready;if(ready)liveStart=boardRange();$('.demo-label').textContent='Google 日曆';$('#new-booking').hidden=true;$('#overview .notice').textContent=message||'每 10 分鐘自動同步';$('.sidebar-bottom').innerHTML='<span class="connection-dot"></span>Google 日曆模式<small>預約請於 Google 日曆建立</small>';render();}
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>view(b.dataset.view));
$('#new-booking').onclick=()=>openBooking();
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>$('#booking-dialog').close());$('.close-detail').onclick=()=>$('#detail-dialog').close();$('#back-to-day').onclick=()=>showDay(agendaDay);
document.addEventListener('click',e=>{const person=e.target.closest('[data-person]');if(person){showPerson(person);return;}const book=e.target.closest('[data-room]'),detail=e.target.closest('[data-detail]'),del=e.target.closest('#remove-booking');const dayButton=e.target.closest('[data-day]');if(dayButton){pauseFollowing();showDay(dayButton.dataset.day);}if(book)openBooking(book.dataset.room);if(detail){if(!detail.closest('#detail-dialog'))agendaDay=null;showDetail(detail.dataset.detail);}if(del&&persist(bookings.filter(b=>b.id!==del.dataset.id))){$('#detail-dialog').close();render();notify('已刪除本機預約。');}});
$('#booking-form').onsubmit=e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{C.validate(values,bookings,{workingHours:true});const next={...values,id:crypto.randomUUID(),attendees:C.people(values.attendees),source:'local'};if(!persist([...bookings,next]))return;if(values.date!==today)pauseFollowing();$('#day').value=values.date;$('#booking-dialog').close();render();notify('已建立本機預約。');}catch(error){$('#form-error').textContent=error.message;}};
function dayChanged(forceSync=false){if(!$('#day').value)$('#day').value=today;if(mode==='google'&&(forceSync||!liveReady||liveStart!==boardRange())){render();window.GoogleSync?.sync();}else render();}
$('#day').onchange=()=>{pauseFollowing();dayChanged();};$('#today').onclick=resumeFollowing;
for(const [id,amount] of [['prev-date',-5],['next-date',5]])$('#'+id).onclick=()=>{pauseFollowing();$('#day').value=C.shiftBoard($('#day').value,amount,$('#skip-weekends').checked,$('#skip-holidays').checked);dayChanged();};
for(const id of ['skip-weekends','skip-holidays'])$('#'+id).onchange=()=>{try{localStorage.setItem('roomly.'+id,String($('#'+id).checked));}catch{}dayChanged(true);};
document.querySelectorAll('[data-range]').forEach(button=>button.onclick=()=>{
  pauseFollowing();timelineRange=button.dataset.range;
  document.querySelectorAll('[data-range]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
  $('#gantt-scroll').scrollLeft=0;renderTable();
});
$('#follow-now').onclick=resumeFollowing;
let touchOrigin=null;
$('#gantt-scroll').addEventListener('touchstart',e=>{const t=e.touches[0];touchOrigin=t?{x:t.clientX,y:t.clientY}:null;},{passive:true});
$('#gantt-scroll').addEventListener('touchmove',e=>{const t=e.touches[0];if(t&&touchOrigin){const x=Math.abs(t.clientX-touchOrigin.x),y=Math.abs(t.clientY-touchOrigin.y);if(x>12&&x>y)pauseFollowing();}},{passive:true});
$('#gantt-scroll').addEventListener('wheel',e=>{if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY))pauseFollowing();},{passive:true});
$('#gantt-scroll').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key))pauseFollowing();});
const personPopover=$('#person-popover');
if(typeof personPopover.showPopover==='function'&&typeof personPopover.hidePopover==='function'){
  personPopover.addEventListener('beforetoggle',e=>{personPopover.dataset.open=String(e.newState==='open');if(e.newState==='closed')resetPersonButtons();});
  personPopover.addEventListener('toggle',e=>{if(e.newState==='closed')refreshNow();});
}else{
  personPopover.dataset.fallback='true';personPopover.dataset.open='false';personPopover.hidden=true;
  personPopover.querySelector('button').onclick=()=>hidePerson(true);
  document.addEventListener('click',e=>{if(personOpen()&&!personPopover.contains(e.target)&&!e.target.closest('[data-person]'))hidePerson();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&personOpen()){e.preventDefault();e.stopImmediatePropagation();hidePerson(true);}});
}
$('#gantt-scroll').addEventListener('scroll',()=>{hidePerson();if(followNow&&Math.abs($('#gantt-scroll').scrollLeft-followedScrollLeft)>1)pauseFollowing();},{passive:true});
window.addEventListener('resize',()=>{hidePerson();refreshNow();});
window.visualViewport?.addEventListener('resize',fitCalendar);
window.addEventListener('roomly:previewchange',()=>{hidePerson();refreshNow();});
if(typeof ResizeObserver==='function'){
  const calendarSizer=new ResizeObserver(fitCalendar);
  for(const selector of ['.sidebar','.tablet-heading','.google-entry','.location-filter','.shared-calendars','.tablet-toolbar','.gantt-caption'])calendarSizer.observe($(selector));
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshNow();});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('close',refreshNow));
setInterval(()=>{if(!document.hidden)refreshNow();},15000);
window.RoomApp={setLive,view,day:()=>$('#day').value,days:boardDays,esc,notify,showDemo:()=>{mode='local';$('.demo-label').textContent='本機資料';$('#new-booking').hidden=false;$('#overview .notice').textContent='本機資料 · 僅儲存在這台裝置';$('.sidebar-bottom').innerHTML='<span class="connection-dot"></span>本機資料<small>資料僅儲存在此瀏覽器</small>';render();}};
render();
