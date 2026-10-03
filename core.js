(function (root) {
  'use strict';
  const holidays=typeof module!=='undefined'&&module.exports?require('./holidays.js'):root.TaiwanHolidays;
  const holiday=day=>holidays?.get(day)||'';
  const holidayYears=holidays?.supportedYears||[];
  const date = value => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value));
  const time = value => new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(value));
  const instant = (day, at) => new Date(`${day}T${at}:00+08:00`).getTime();
  const overlaps = (a,b,c,d) => a < d && c < b;
  const safeMeet = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'meet.google.com' && !u.username && !u.password && !u.port ? u.href : ''; } catch { return ''; } };
  const people = value => [...new Set(String(value || '').split(/[;,，；\n]/).map(v=>v.trim()).filter(Boolean))];
  function validate(item, existing = [], { workingHours = false } = {}) {
    if (!item.title?.trim() || !item.organizer?.trim()) throw new Error('請填寫會議名稱與主辦人。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(instant(item.date,'00:00')) || date(instant(item.date,'00:00')) !== item.date) throw new Error('日期格式不正確。');
    if (![item.start,item.end].every(v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) || item.end <= item.start) throw new Error('結束時間必須晚於開始時間；跨日會議請在 Google 日曆建立。');
    if (workingHours && (item.start < '09:00' || item.end > '19:00')) throw new Error('會議預約時間為 09:00–19:00，請調整起訖時間。');
    if (!['forest','light','island'].includes(item.room)) throw new Error('找不到此會議室，請使用主會議室。');
    if (item.meet && !safeMeet(item.meet)) throw new Error('請輸入有效的 https://meet.google.com/ 連結。');
    if (existing.some(e=>e.room===item.room && e.date===item.date && overlaps(item.start,item.end,e.start,e.end))) throw new Error('此會議室在該時段已有預約，請選擇其他時段。');
    return item;
  }
  function parseCSV(text) {
    const rows=[];let row=[],cell='',quoted=false,closed=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
      if(c==='"'){if(cell || closed)throw new Error('CSV 引號格式不正確。');quoted=true;}
      else if(c===','){row.push(cell);cell='';closed=false;}
      else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';closed=false;}
      else {if(closed)throw new Error('CSV 引號後有多餘文字。');cell+=c;}
    }
    if(quoted)throw new Error('CSV 引號未關閉。');
    row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
    if(!rows.length)throw new Error('CSV 檔案是空的。');
    const header=rows.shift().map(v=>v.trim());
    const required=['title','date','start','end','room','organizer','attendees','meet'];
    if(required.some(v=>!header.includes(v)) || new Set(header).size!==header.length)throw new Error('CSV 欄位不符，請先下載範本。');
    return rows.map((row,i)=>{if(row.length!==header.length)throw new Error(`第 ${i+2} 列欄位數不正確。`);return Object.fromEntries(header.map((key,j)=>[key,row[j].trim()]));});
  }
  function googleRoomMatch(event, room) {
    const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase();
    const names=new Set([room.name,...(room.aliases||[])].map(normalize).filter(Boolean));
    const resourceIds=new Set((room.resourceIds||[]).map(normalize).filter(Boolean));
    const matches=value=>{const text=normalize(value);return [...names].some(name=>text.includes(name));};
    const resources=(event.attendees||[]).filter(a=>a.resource&&(matches(a.displayName)||resourceIds.has(normalize(a.email))));
    // A room that explicitly declined the invitation was not reserved.
    if(resources.length)return resources.some(a=>a.responseStatus!=='declined');
    return matches(event.location);
  }
  function googleTimestamp(value) {
    if(typeof value!=='string'||value.length>50||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return null;
    const day=value.slice(0,10),midnight=Date.parse(day+'T00:00:00Z'),at=Date.parse(value);
    return Number.isFinite(midnight)&&new Date(midnight).toISOString().slice(0,10)===day&&Number.isFinite(at)?at:null;
  }
  function googleEventKey(event,calendarId='') {
    const scope=/^[a-f0-9]{64}$/.test(event.calendarKey||'')?`${calendarId}:${event.calendarKey}`:calendarId;
    const identity=event.iCalUID||`${scope}:${event.id}`;
    // New snapshots explicitly distinguish single invitations from occurrences.
    // Older snapshots keep UID + current start until they are refreshed.
    if(Object.prototype.hasOwnProperty.call(event,'recurringEventId')){
      if(event.recurringEventId==='')return `${identity}|single`;
      if(typeof event.recurringEventId==='string'&&/^[A-Za-z0-9_-]{1,1024}$/.test(event.recurringEventId)){
        const original=event.originalStartTime;
        if(original?.dateTime&&!original.date){const at=googleTimestamp(original.dateTime);if(at!==null)return `${identity}|occurrence:${at}`;}
        if(typeof original?.date==='string'&&!original.dateTime&&/^\d{4}-\d{2}-\d{2}$/.test(original.date)){
          const at=Date.parse(original.date+'T00:00:00Z');if(Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===original.date)return `${identity}|occurrence-date:${original.date}`;
        }
      }
    }
    const start=event.start?.dateTime||(event.start?.date&&event.start.date+'T00:00:00+08:00');
    return `${identity}|${Date.parse(start)}`;
  }
  function googleVersion(event) {
    const sequence=Number.isInteger(event.sequence)&&event.sequence>=0&&event.sequence<=2147483647?event.sequence:null,at=googleTimestamp(event.updated);
    const start=Date.parse(event.start?.dateTime||(event.start?.date&&event.start.date+'T00:00:00+08:00')),end=Date.parse(event.end?.dateTime||(event.end?.date&&event.end.date+'T00:00:00+08:00'));
    const primary={title:event.summary||'私人 / 忙碌時段',organizer:event.organizer?.displayName||event.organizer?.email||'未提供',location:event.location||'',meet:safeMeet(event.hangoutLink||event.conferenceData?.entryPoints?.find(p=>p.entryPointType==='video')?.uri)};
    return {sequence:sequence??0,updated:at??-Infinity,known:sequence!==null||at!==null,valid:Number.isFinite(start)&&Number.isFinite(end)&&end>start,start,end,primary,tie:JSON.stringify([primary.title==='私人 / 忙碌時段',primary.title,primary.organizer==='未提供',primary.organizer,primary.location,primary.meet,!!event.start?.date])};
  }
  function preferGoogleVersion(old,next) {
    const a=googleVersion(next),b=googleVersion(old);
    if(!a.valid)return old;if(!b.valid)return next;
    if(a.sequence!==b.sequence)return a.sequence>b.sequence?next:old;
    if(a.updated!==b.updated)return a.updated>b.updated?next:old;
    if(a.known!==b.known)return a.known?next:old;
    if(a.end!==b.end)return a.end>b.end?next:old;
    if(a.start!==b.start)return a.start<b.start?next:old;
    return a.tie<b.tie?next:old;
  }
  function mergeGoogle(sources, { room } = {}) {
    const merged=new Map(),versions=new Map();
    for(const {calendar,events} of sources) for(const e of events) {
      if(e.status==='cancelled' || e.attendees?.some(a=>a.self && a.responseStatus==='declined'))continue;
      const start=e.start?.dateTime || (e.start?.date && `${e.start.date}T00:00:00+08:00`);
      const end=e.end?.dateTime || (e.end?.date && `${e.end.date}T00:00:00+08:00`);
      if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.parse(start))continue;
      const key=googleEventKey(e,calendar.id);
      const attendees=(e.attendees||[]).filter(a=>!a.resource).map(a=>({key:(a.email||a.displayName||'未命名').toLowerCase(),name:a.displayName||a.email||'未命名',email:a.email||'',status:a.responseStatus||'needsAction'}));
      const roomIds=room?(googleRoomMatch(e,room)?[room.id]:[]):calendar.kind==='room'?[calendar.id]:[];
      const busyRoomIds=e.transparency==='transparent'?[]:roomIds;
      const candidate={id:key,title:e.summary||'私人 / 忙碌時段',startISO:new Date(start).toISOString(),endISO:new Date(end).toISOString(),allDay:!!e.start.date,organizer:e.organizer?.displayName||e.organizer?.email||'未提供',attendeeDetails:attendees,attendees:attendees.map(a=>a.name),roomIds,busyRoomIds,meet:safeMeet(e.hangoutLink || e.conferenceData?.entryPoints?.find(p=>p.entryPointType==='video')?.uri),source:'google',sources:[calendar.name],location:e.location||'',attendeesOmitted:!!e.attendeesOmitted};
      if(!merged.has(key)){merged.set(key,candidate);versions.set(key,e);continue;}
      const old=merged.get(key);
      const previous={title:old.title,organizer:old.organizer,meet:old.meet,location:old.location};
      // Updated copies can shorten a booking; legacy caches without version
      // metadata conservatively keep the later end. Email ordering is irrelevant.
      if(preferGoogleVersion(versions.get(key),e)===e){for(const field of ['title','startISO','endISO','allDay','organizer','meet','location'])old[field]=candidate[field];versions.set(key,e);}
      for(const field of ['roomIds','busyRoomIds','sources'])old[field]=[...new Set([...old[field],...candidate[field]])];
      const personMap=new Map(old.attendeeDetails.map(a=>[a.key,a]));
      for(const p of attendees)personMap.set(p.key,p);
      old.attendeeDetails=[...personMap.values()];old.attendees=old.attendeeDetails.map(a=>a.name);
      const primary=googleVersion(versions.get(key)).primary;
      for(const [field,empty] of [['title','私人 / 忙碌時段'],['organizer','未提供'],['meet',''],['location','']]){
        old[field]=primary[field]!==empty?primary[field]:[previous[field],candidate[field]].filter(value=>value!==empty).sort()[0]||empty;
      }
      old.attendeesOmitted ||= candidate.attendeesOmitted;
    }
    return [...merged.values()].sort((a,b)=>Date.parse(a.startISO)-Date.parse(b.startISO));
  }
  // Keep the actual time precision; 30 minutes is the grid, not rounding of events.
  function timelineLayout(events, day, fromMinute = 480, toMinute = 1080) {
    const midnight=instant(day,'00:00');
    const from=midnight+fromMinute*60000,to=midnight+toMinute*60000;
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)throw Error('無效的時間軸範圍。');
    const candidates=events.map(event=>({event,start:Date.parse(event.startISO),end:Date.parse(event.endISO)}))
      .filter(e=>Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.end>e.start&&overlaps(e.start,e.end,from,to))
      .sort((a,b)=>a.start-b.start||b.end-a.end);
    const laneEnds=[];
    const bars=candidates.map(({event,start,end})=>{
      const visibleStart=Math.max(start,from),visibleEnd=Math.min(end,to);
      let lane=laneEnds.findIndex(last=>last<=visibleStart);
      if(lane<0)lane=laneEnds.length;
      laneEnds[lane]=visibleEnd;
      return {event,lane,left:100*(visibleStart-from)/(to-from),width:100*(visibleEnd-visibleStart)/(to-from),continuesBefore:start<from,continuesAfter:end>to};
    });
    return {bars,lanes:Math.max(1,laneEnds.length)};
  }
  function weekDays(day) {
    const midnight=instant(day,'00:00');
    const weekday=new Date(midnight+8*3600000).getUTCDay();
    const monday=midnight-((weekday+6)%7)*86400000;
    return Array.from({length:7},(_,i)=>date(monday+i*86400000));
  }
  function currentSlot(now, fromMinute=0, toMinute=1440) {
    const day=date(now),minute=(new Date(now).getTime()-instant(day,'00:00'))/60000;
    const start=Math.floor(minute/30)*30,end=start+30;
    return {day,minute,start,end,label:time(now),visible:minute>=fromMinute&&minute<toMinute,
      left:100*(start-fromMinute)/(toMinute-fromMinute),width:100*30/(toMinute-fromMinute),
      nowLeft:100*(minute-fromMinute)/(toMinute-fromMinute)};
  }
  function boardDays(day, skipWeekends=false, skipHolidays=false) {
    const start=instant(day,'00:00');
    if(!Number.isFinite(start)||date(start)!==day)throw Error('日期格式不正確。');
    const days=[];
    for(let stamp=start;days.length<5;stamp+=86400000){
      const weekday=new Date(stamp+8*3600000).getUTCDay();
      const day=date(stamp);
      if((!skipWeekends||(weekday!==0&&weekday!==6))&&(!skipHolidays||!holiday(day)))days.push(day);
    }
    return days;
  }
  function shiftBoard(day, amount, skipWeekends=false, skipHolidays=false) {
    let stamp=instant(boardDays(day,skipWeekends,skipHolidays)[0],'00:00');
    const direction=Math.sign(amount);
    for(let count=0;count<Math.abs(amount);){
      stamp+=direction*86400000;
      const weekday=new Date(stamp+8*3600000).getUTCDay();
      if((!skipWeekends||(weekday!==0&&weekday!==6))&&(!skipHolidays||!holiday(date(stamp))))count++;
    }
    return date(stamp);
  }
  function overlapsDays(start,end,days) {
    return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&days.some(day=>{
      const midnight=instant(day,'00:00');
      return overlaps(start,end,midnight,midnight+86400000);
    });
  }
  function centeredScroll(point, viewport, frozen, maximum) {
    return Math.min(Math.max(0,maximum),Math.max(0,point-(viewport+frozen)/2));
  }
  const removeDemoBookings=records=>records.filter(e=>e?.source!=='demo'&&!/^demo-\d+$/.test(e?.id||''));
  const api={date,time,instant,overlaps,safeMeet,people,validate,parseCSV,googleRoomMatch,googleEventKey,preferGoogleVersion,mergeGoogle,timelineLayout,weekDays,boardDays,shiftBoard,overlapsDays,currentSlot,centeredScroll,removeDemoBookings,holiday,holidayYears};
  if(typeof module!=='undefined')module.exports=api;else root.RoomCore=api;
})(typeof window!=='undefined'?window:globalThis);
