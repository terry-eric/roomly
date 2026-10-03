const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../core.js');
const room={id:'forest',name:'主會議室'},start='2026-10-04T23:30:00+08:00';
const copy=(title,end,extra={})=>({id:title,iCalUID:'cross-week-invite',summary:title,location:'主會議室',start:{dateTime:start},end:{dateTime:end},...extra});
const source=(id,event)=>({calendar:{id,name:id,kind:'person'},events:[event]});
const merged=(a,b)=>C.mergeGoogle([source('a@example.test',a),source('z@example.test',b)],{room})[0];
const stableFields=event=>({title:event.title,start:event.startISO,end:event.endISO,allDay:event.allDay,organizer:event.organizer,meet:event.meet});

test('invitation sequence wins before update time and an updated booking can become shorter',()=>{
  const old=copy('舊會議','2026-10-05T12:00:00+08:00',{sequence:2,updated:'2026-10-03T12:00:00Z',attendees:[{email:'a@example.test'}]}),next=copy('更新會議','2026-10-05T10:00:00+08:00',{sequence:3,updated:'2026-10-02T12:00:00Z',attendees:[{email:'z@example.test'}]});
  assert.equal(C.preferGoogleVersion(old,next),next);assert.equal(C.preferGoogleVersion(next,old),next);
  const event=merged(old,next);assert.equal(event.title,'更新會議');assert.equal(Date.parse(event.endISO),Date.parse(next.end.dateTime));assert.equal(event.sources.length,2);assert.equal(event.attendees.length,2);assert.deepEqual(stableFields(event),stableFields(merged(next,old)));
});
test('cross-week duplicate selection uses updated time when sequences match or are absent',()=>{
  for(const sequence of [undefined,0,4]){
    const old=copy('舊會議','2026-10-05T12:00:00+08:00',{sequence,updated:'2026-10-02T12:00:00Z'}),next=copy('新會議','2026-10-05T11:00:00+08:00',{sequence,updated:'2026-10-03T20:00:00+08:00'});
    assert.equal(C.preferGoogleVersion(old,next),next);assert.equal(C.preferGoogleVersion(next,old),next);assert.equal(merged(old,next).title,'新會議');assert.deepEqual(stableFields(merged(old,next)),stableFields(merged(next,old)));
  }
});
test('legacy cross-week copies conservatively keep the later valid end and resolve ties deterministically',()=>{
  const short=copy('短會議','2026-10-05T10:00:00+08:00'),long=copy('長會議','2026-10-05T12:00:00+08:00');
  assert.equal(C.preferGoogleVersion(short,long),long);assert.equal(C.preferGoogleVersion(long,short),long);assert.deepEqual(stableFields(merged(short,long)),stableFields(merged(long,short)));assert.equal(merged(short,long).title,'長會議');
  const a=copy('A meeting','2026-10-05T10:00:00+08:00'),z=copy('Z meeting','2026-10-05T10:00:00+08:00');assert.equal(merged(a,z).title,'A meeting');assert.deepEqual(stableFields(merged(a,z)),stableFields(merged(z,a)));
});
test('malformed version metadata cannot override a valid legacy invitation',()=>{
  const real=copy('真實會議','2026-10-05T12:00:00+08:00');
  for(const invalid of [{sequence:-1},{sequence:2147483648},{sequence:Infinity},{sequence:'999'},{updated:'9999-02-30T12:00:00Z'},{updated:'2026-10-03'},{updated:'2026-10-03T24:00:00Z'},{updated:{value:'2026-10-03T12:00:00Z'}}]){
    const broken=copy('錯誤 metadata','2026-10-05T10:00:00+08:00',invalid);assert.equal(C.preferGoogleVersion(real,broken),real);assert.equal(C.preferGoogleVersion(broken,real),real);
  }
});
test('latest version with omitted details keeps available title and safe Meet data from another copy',()=>{
  const detailed=copy('完整會議','2026-10-05T12:00:00+08:00',{sequence:1,hangoutLink:'https://meet.google.com/abc-defg-hij'}),fresh=copy(undefined,'2026-10-05T10:00:00+08:00',{sequence:2});
  assert.equal(merged(detailed,fresh).title,'完整會議');assert.equal(merged(detailed,fresh).meet,'https://meet.google.com/abc-defg-hij');assert.deepEqual(stableFields(merged(detailed,fresh)),stableFields(merged(fresh,detailed)));
});
test('invalid or reversed meeting times never win version comparison or enter the board',()=>{
  const real=copy('真實會議','2026-10-05T12:00:00+08:00');
  for(const end of ['2026-10-04T23:30:00+08:00','2026-10-04T20:00:00+08:00','bad']){
    const broken=copy('無效會議',end,{sequence:2147483647});assert.equal(C.preferGoogleVersion(real,broken),real);assert.equal(C.preferGoogleVersion(broken,real),real);assert.equal(C.mergeGoogle([source('a',broken)],{room}).length,0);
  }
});
test('new single-invitation snapshots merge changed start times consistently across calendars',()=>{
  const old=copy('原時段','2026-10-05T01:00:00+08:00',{recurringEventId:'',sequence:1}),next=copy('新時段','2026-10-06T11:00:00+08:00',{recurringEventId:'',sequence:2,start:{dateTime:'2026-10-06T10:00:00+08:00'}});
  assert.equal(C.googleEventKey(old,'a'),C.googleEventKey(next,'z'));
  const events=C.mergeGoogle([source('a',old),source('z',next)],{room});assert.equal(events.length,1);assert.equal(events[0].title,'新時段');assert.equal(Date.parse(events[0].startISO),Date.parse(next.start.dateTime));assert.deepEqual(stableFields(events[0]),stableFields(merged(next,old)));
});
test('recurring copies share original occurrence identity even with different local recurring IDs and current times',()=>{
  const old=copy('原 occurrence','2026-10-05T01:00:00+08:00',{recurringEventId:'series_a',originalStartTime:{dateTime:start},sequence:1}),moved=copy('調整 occurrence','2026-10-06T11:00:00+08:00',{recurringEventId:'series_z',originalStartTime:{dateTime:'2026-10-04T15:30:00Z'},start:{dateTime:'2026-10-06T10:00:00+08:00'},sequence:2});
  assert.equal(C.googleEventKey(old,'a'),C.googleEventKey(moved,'z'));assert.equal(C.mergeGoogle([source('a',old),source('z',moved)],{room}).length,1);assert.equal(merged(old,moved).title,'調整 occurrence');assert.deepEqual(stableFields(merged(old,moved)),stableFields(merged(moved,old)));
  const another={...moved,id:'next-occurrence',originalStartTime:{dateTime:'2026-10-11T23:30:00+08:00'}};
  assert.notEqual(C.googleEventKey(moved,'z'),C.googleEventKey(another,'z'));assert.equal(C.mergeGoogle([source('a',old),{calendar:{id:'z',name:'z',kind:'person'},events:[moved,another]}],{room}).length,2);
  assert.notEqual(C.googleEventKey(moved,'z'),C.googleEventKey({...moved,iCalUID:'different-invitation'},'z'));
});
test('all-day occurrences use their original date while legacy snapshots keep UID plus current start',()=>{
  const one=copy('全天','2026-10-05T01:00:00+08:00',{recurringEventId:'series',originalStartTime:{date:'2026-10-04'}}),two={...one,originalStartTime:{date:'2026-10-05'}};
  assert.notEqual(C.googleEventKey(one,'a'),C.googleEventKey(two,'a'));
  const old=copy('舊快取','2026-10-05T01:00:00+08:00'),moved={...old,start:{dateTime:'2026-10-05T10:00:00+08:00'},end:{dateTime:'2026-10-05T11:00:00+08:00'}};
  assert.notEqual(C.googleEventKey(old,'a'),C.googleEventKey(moved,'a'));assert.equal(C.mergeGoogle([source('a',old),source('z',moved)],{room}).length,2);
});
test('invalid occurrence metadata falls back safely and missing shared UIDs stay scoped to their calendars',()=>{
  const legacy=copy('會議','2026-10-05T01:00:00+08:00');
  for(const metadata of [{recurringEventId:'bad id',originalStartTime:{dateTime:start}},{recurringEventId:'x'.repeat(1025),originalStartTime:{dateTime:start}},{recurringEventId:'series',originalStartTime:{date:'2026-02-30'}},{recurringEventId:'series',originalStartTime:{date:'2026-10-04',dateTime:start}},{recurringEventId:'series',originalStartTime:{dateTime:'bad'}},{recurringEventId:null}])assert.equal(C.googleEventKey({...legacy,...metadata},'a'),C.googleEventKey(legacy,'a'));
  const noUid={...legacy,iCalUID:undefined,recurringEventId:''};assert.notEqual(C.googleEventKey(noUid,'a'),C.googleEventKey(noUid,'z'));
});
