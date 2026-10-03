const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
const booking={title:'測試',organizer:'小明',date:'2026-10-01',start:'10:00',end:'11:00',room:'forest',meet:''};
test('sample cleanup removes shipped demo records and preserves manually entered or imported bookings',()=>{
 const local={...booking,id:'real-local',source:'local',attendees:['同事']},csv={...booking,id:'real-csv',source:'csv'},legacy={...booking,id:'old-user-entry'};
 const records=[{...booking,id:'demo-0',source:'demo'},{...booking,id:'demo-1'},local,csv,legacy];
 assert.deepEqual(C.removeDemoBookings(records),[local,csv,legacy]);assert.equal(records.length,5);assert.deepEqual(C.removeDemoBookings([{id:'demo-2',source:'demo'}]),[]);assert.deepEqual(C.removeDemoBookings([]),[]);
});
test('new bookings enforce 09:00–19:00 while legacy records remain readable',()=>{
 assert.doesNotThrow(()=>C.validate({...booking,start:'09:00',end:'19:00'},[],{workingHours:true}));
 assert.throws(()=>C.validate({...booking,start:'08:59'},[],{workingHours:true}),/09:00–19:00/);
 assert.throws(()=>C.validate({...booking,end:'19:01'},[],{workingHours:true}),/09:00–19:00/);
 assert.doesNotThrow(()=>C.validate({...booking,start:'08:00',end:'09:00'}));
 assert.equal(C.currentSlot('2026-10-01T09:00:00+08:00',540,1140).visible,true);
 assert.equal(C.currentSlot('2026-10-01T19:00:00+08:00',540,1140).visible,false);
});
test('adjacent bookings allowed, overlapping bookings rejected',()=>{assert.doesNotThrow(()=>C.validate({...booking,start:'11:00',end:'12:00'},[booking]));assert.throws(()=>C.validate({...booking,start:'10:30',end:'11:30'},[booking]),/已有預約/);assert.doesNotThrow(()=>C.validate({...booking,room:'island'},[booking]));});
test('invalid ranges and calendar dates rejected',()=>{for(const change of [{date:'2026-02-30'},{start:'24:00'},{end:'09:00'},{end:'10:00'},{date:''}])assert.throws(()=>C.validate({...booking,...change}));});
test('Google Meet links must use exact HTTPS hostname',()=>{for(const link of ['javascript:alert(1)','https://meet.google.com.evil.test/x','http://meet.google.com/a','https://u:p@meet.google.com/a'])assert.equal(C.safeMeet(link),'');assert.equal(C.safeMeet('https://meet.google.com/abc-defg-hij'),'https://meet.google.com/abc-defg-hij');});
test('CSV supports BOM, CRLF, quotes, comma and multiline cells',()=>{const rows=C.parseCSV('\ufefftitle,date,start,end,room,organizer,attendees,meet\r\n"A, B",2026-10-01,10:00,11:00,森,"王""明","甲\n乙",\r\n');assert.equal(rows[0].title,'A, B');assert.equal(rows[0].organizer,'王"明');assert.deepEqual(C.people(rows[0].attendees),['甲','乙']);});
test('CSV rejects missing/duplicate columns, malformed quotes and row widths',()=>{for(const csv of ['title,date\na,b','title,date,start,end,room,organizer,attendees,meet\n"bad','title,date,start,end,room,organizer,attendees,meet\na,b','title,title,date,start,end,room,organizer,attendees,meet'])assert.throws(()=>C.parseCSV(csv));});
const event={id:'g1',iCalUID:'uid1',summary:'Team',start:{dateTime:'2026-10-01T01:00:00Z'},end:{dateTime:'2026-10-01T02:00:00Z'},attendees:[{email:'a@example.com',displayName:'A',responseStatus:'accepted'}]};
const source=(id,kind,events)=>({calendar:{id,kind,name:id},events});
const room={id:'forest',name:'主會議室',aliases:['Meeting Room A'],resourceIds:['room@example.com']};

test('shared calendar namespaces preserve local ID collisions while shared invitation UIDs still merge',()=>{
 const same={...event,iCalUID:'',location:'主會議室',recurringEventId:''},a={...same,calendarKey:'a'.repeat(64)},b={...same,calendarKey:'b'.repeat(64)};
 assert.equal(C.mergeGoogle([source('person','person',[same,a,b])],{room}).length,3);
 assert.equal(C.mergeGoogle([source('person','person',[{...a,iCalUID:'common'},{...b,iCalUID:'common'}])],{room}).length,1);
});
test('location search matches contained text, whitespace and full-width letters',()=>{
 for(const location of ['主會議室','台北辦公室，主會議室','二樓\n主會議室','Ｍｅｅｔｉｎｇ　Ｒｏｏｍ　Ａ'])assert.equal(C.googleRoomMatch({location},room),true);
 for(const e of [{location:'其他會議室'},{summary:'主會議室',description:'主會議室'},{hangoutLink:'https://meet.google.com/abc-defg-hij'},{attendees:[{displayName:'主會議室'}]}])assert.equal(C.googleRoomMatch(e,room),false);
 assert.equal(C.googleRoomMatch({location:'anywhere'},{name:'',aliases:[]}),false);
});
test('matching resource names or IDs identify the room, but declined rooms do not',()=>{
 assert.equal(C.googleRoomMatch({attendees:[{resource:true,displayName:'二樓主會議室',responseStatus:'accepted'}]},room),true);
 assert.equal(C.googleRoomMatch({attendees:[{resource:true,email:'ROOM@example.com'}]},room),true);
 assert.equal(C.googleRoomMatch({location:'主會議室',attendees:[{resource:true,email:'room@example.com',responseStatus:'declined'}]},room),false);
});
test('personal invitations merge room, participant and Meet details from separate copies',()=>{
 const [e]=C.mergeGoogle([source('a','person',[event]),source('b','person',[{...event,location:'主會議室',hangoutLink:'https://meet.google.com/abc-defg-hij',attendees:[{email:'b@example.com',displayName:'B'},{resource:true,displayName:'主會議室'}]}])],{room});
 assert.deepEqual(e.roomIds,['forest']);assert.deepEqual(e.attendees,['A','B']);assert.equal(e.location,'主會議室');assert.ok(e.meet);assert.equal(e.sources.length,2);
 const [transparent]=C.mergeGoogle([source('a','person',[{...event,location:'主會議室',transparency:'transparent'}])],{room});assert.deepEqual(transparent.busyRoomIds,[]);
});
test('duplicates from people and room calendars merge by UID and instant',()=>{const [e]=C.mergeGoogle([source('a','person',[event]),source('room','room',[{...event,id:'g2',start:{dateTime:'2026-10-01T09:00:00+08:00'},attendees:[...event.attendees,{email:'b@example.com',displayName:'B'}]}])]);assert.deepEqual(e.roomIds,['room']);assert.deepEqual(e.attendees,['A','B']);assert.equal(e.sources.length,2);});
test('recurring occurrences with same UID but different start are not merged',()=>{assert.equal(C.mergeGoogle([source('a','person',[event,{...event,start:{dateTime:'2026-10-02T01:00:00Z'},end:{dateTime:'2026-10-02T02:00:00Z'}}])]).length,2);});
test('cancelled and self-declined events excluded',()=>{assert.equal(C.mergeGoogle([source('a','person',[{...event,status:'cancelled'},{...event,attendees:[{self:true,responseStatus:'declined'}]}])]).length,0);});
test('transparent room meetings do not block availability',()=>{const [e]=C.mergeGoogle([source('room','room',[{...event,transparency:'transparent'}])]);assert.deepEqual(e.roomIds,['room']);assert.deepEqual(e.busyRoomIds,[]);});
test('all-day end date is exclusive in Taipei',()=>{const [e]=C.mergeGoogle([source('room','room',[{id:'all',start:{date:'2026-10-01'},end:{date:'2026-10-02'}}])]);assert.equal(e.allDay,true);assert.equal(Date.parse(e.endISO)-Date.parse(e.startISO),86400000);assert.equal(C.overlaps(Date.parse(e.startISO),Date.parse(e.endISO),C.instant('2026-10-02','00:00'),C.instant('2026-10-02','01:00')),false);});
test('cross-midnight room meeting blocks next morning',()=>{const [e]=C.mergeGoogle([source('room','room',[{...event,start:{dateTime:'2026-10-01T23:00:00+08:00'},end:{dateTime:'2026-10-02T02:00:00+08:00'}}])]);assert.ok(C.overlaps(Date.parse(e.startISO),Date.parse(e.endISO),C.instant('2026-10-02','01:00'),C.instant('2026-10-02','03:00')));});
test('private data stays explicitly unnamed, conference entries handled safely',()=>{const [e]=C.mergeGoogle([source('a','person',[{...event,summary:undefined,attendees:undefined,conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}}])]);assert.equal(e.title,'私人 / 忙碌時段');assert.deepEqual(e.attendees,[]);assert.ok(e.meet);});
test('Taipei day and time are independent of system timezone',()=>{assert.equal(C.date('2026-09-30T17:00:00Z'),'2026-10-01');assert.equal(C.time('2026-09-30T17:00:00Z'),'01:00');});
const timed=(start,end)=>({startISO:`2026-10-01T${start}:00+08:00`,endISO:`2026-10-01T${end}:00+08:00`});
test('timeline preserves quarter-hour times on a half-hour grid',()=>{const {bars}=C.timelineLayout([timed('09:15','09:45')],'2026-10-01');assert.equal(bars[0].left,12.5);assert.equal(bars[0].width,5);});
test('overlapping meetings occupy separate lanes, adjacent meetings reuse a lane',()=>{const {bars,lanes}=C.timelineLayout([timed('09:00','10:00'),timed('09:30','10:30'),timed('10:00','11:00')],'2026-10-01');assert.equal(lanes,2);assert.deepEqual(bars.map(b=>b.lane),[0,1,0]);});
test('timeline clips cross-day events and excludes exact edge events',()=>{const previous={startISO:'2026-09-30T23:00:00+08:00',endISO:'2026-10-01T09:00:00+08:00'};const {bars}=C.timelineLayout([previous,timed('07:00','08:00'),timed('18:00','19:00')],'2026-10-01');assert.equal(bars.length,1);assert.equal(bars[0].continuesBefore,true);assert.equal(bars[0].left,0);assert.equal(bars[0].width,10);});
test('all-day timeline fills exactly the visible range',()=>{const {bars}=C.timelineLayout([{startISO:'2026-10-01T00:00:00+08:00',endISO:'2026-10-02T00:00:00+08:00'}],'2026-10-01',0,1440);assert.equal(bars[0].width,100);assert.equal(bars[0].continuesAfter,false);});
test('Monday-based weeks span years and Sunday remains in the current week',()=>{assert.deepEqual(C.weekDays('2027-01-03'),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);assert.equal(C.weekDays('2027-01-04')[0],'2027-01-04');});
test('current half-hour changes exactly at the boundary in Taipei',()=>{
 const before=C.currentSlot('2026-10-01T01:29:59+08:00'),after=C.currentSlot('2026-10-01T01:30:00+08:00');
 assert.equal(before.start,60);assert.equal(before.end,90);assert.equal(after.start,90);assert.equal(after.label,'01:30');
 assert.equal(C.currentSlot('2026-10-01T12:00:00+08:00',480,720).visible,false);
 assert.equal(C.currentSlot('2026-10-01T12:00:00+08:00',720,1080).visible,true);
});
test('current day and slot roll over at Taipei midnight',()=>{
 const before=C.currentSlot('2026-10-04T15:59:59Z'),after=C.currentSlot('2026-10-04T16:00:00Z');
 assert.equal(before.day,'2026-10-04');assert.equal(before.start,1410);assert.equal(before.end,1440);
 assert.equal(after.day,'2026-10-05');assert.equal(after.start,0);assert.equal(after.nowLeft,0);
});
test('centering accounts for frozen date column and midnight padding',()=>{
 const viewport=800,frozen=100,padding=(viewport-frozen)/2;
 for(const minute of [0,15,720,1439]){
   const position=frozen+padding+minute/30*56;
   const scroll=C.centeredScroll(position,viewport,frozen,2800);
   assert.equal(position-scroll,(viewport+frozen)/2);
 }
 assert.equal(C.centeredScroll(-10,800,100,200),0);
 assert.equal(C.centeredScroll(3000,800,100,200),200);
});
test('five-day board starts at the requested Taipei date and crosses weeks, months and years',()=>{
 assert.deepEqual(C.boardDays('2026-10-03'),['2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07']);
 assert.deepEqual(C.boardDays('2026-12-30'),['2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
 assert.deepEqual(C.boardDays('2028-02-28'),['2028-02-28','2028-02-29','2028-03-01','2028-03-02','2028-03-03']);
});
test('five-day board rejects invalid calendar dates',()=>{
 for(const day of ['2026-02-30','invalid','2026-13-01'])assert.throws(()=>C.boardDays(day));
});
test('weekday board keeps five dates and skips weekends across month and year boundaries',()=>{
 assert.deepEqual(C.boardDays('2026-10-03',true),['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09']);
 assert.deepEqual(C.boardDays('2026-10-02',true),['2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08']);
 assert.deepEqual(C.boardDays('2026-12-31',true),['2026-12-31','2027-01-01','2027-01-04','2027-01-05','2027-01-06']);
 assert.throws(()=>C.boardDays('2026-02-30',true));
});
test('weekday paging has no duplicated or missing working dates',()=>{
 for(const start of ['2026-10-02','2026-10-03','2026-10-06','2026-12-31']){
   const days=C.boardDays(start,true),next=C.shiftBoard(start,5,true);
   assert.equal(C.shiftBoard(next,-5,true),days[0]);
   assert.equal(new Set([...days,...C.boardDays(next,true)]).size,10);
 }
 assert.equal(C.shiftBoard('2026-10-03',5),'2026-10-08');
});
test('hidden weekend meetings are excluded while cross-midnight meetings reach visible Monday',()=>{
 const days=C.boardDays('2026-10-02',true);
 const check=(start,end)=>C.overlapsDays(Date.parse(start+'+08:00'),Date.parse(end+'+08:00'),days);
 assert.equal(check('2026-10-03T10:00:00','2026-10-03T11:00:00'),false);
 assert.equal(check('2026-10-04T23:00:00','2026-10-05T10:00:00'),true);
 assert.equal(check('2026-10-08T18:00:00','2026-10-08T19:00:00'),true);
 assert.equal(check('2026-10-08T18:00:00','2026-10-08T17:00:00'),false);
 assert.equal(C.overlapsDays(NaN,NaN,days),false);
});

test('Taiwan national holidays and substitute days are distinct from ordinary weekends',()=>{
 assert.deepEqual(C.holidayYears,[2026,2027]);
 for(const [day,name] of [['2026-02-15','小年夜'],['2026-02-16','農曆除夕'],['2026-02-19','春節'],['2026-02-20','補假'],['2026-10-09','補假'],['2026-10-10','國慶日'],['2027-01-01','開國紀念日'],['2027-02-04','小年夜'],['2027-02-09','補假'],['2027-02-10','補假'],['2027-12-31','補假']])assert.equal(C.holiday(day),name,day);
 for(const day of ['2026-02-14','2026-02-21','2026-02-22','2026-10-03','2026-02-30','invalid','2028-01-01'])assert.equal(C.holiday(day),'',day);
});
test('holiday-only skipping preserves ordinary weekends and still returns five dates across a long break',()=>{
 assert.deepEqual(C.boardDays('2026-02-13',false,true),['2026-02-13','2026-02-14','2026-02-21','2026-02-22','2026-02-23']);
 assert.deepEqual(C.boardDays('2026-02-15',false,true),['2026-02-21','2026-02-22','2026-02-23','2026-02-24','2026-02-25']);
 assert.deepEqual(C.boardDays('2026-10-08',false,true),['2026-10-08','2026-10-11','2026-10-12','2026-10-13','2026-10-14']);
 assert.deepEqual(C.boardDays('2026-02-13',false,false),['2026-02-13','2026-02-14','2026-02-15','2026-02-16','2026-02-17']);
});
test('weekend and holiday exclusions combine across substitute holidays, months and years',()=>{
 assert.deepEqual(C.boardDays('2026-02-13',true,true),['2026-02-13','2026-02-23','2026-02-24','2026-02-25','2026-02-26']);
 assert.deepEqual(C.boardDays('2026-02-26',true,true),['2026-02-26','2026-03-02','2026-03-03','2026-03-04','2026-03-05']);
 assert.deepEqual(C.boardDays('2026-12-31',false,true),['2026-12-31','2027-01-02','2027-01-03','2027-01-04','2027-01-05']);
 assert.deepEqual(C.boardDays('2026-12-31',true,true),['2026-12-31','2027-01-04','2027-01-05','2027-01-06','2027-01-07']);
 assert.deepEqual(C.boardDays('2027-02-03',true,true),['2027-02-03','2027-02-11','2027-02-12','2027-02-15','2027-02-16']);
});
test('holiday paging is reversible and adjacent pages neither repeat nor omit eligible dates',()=>{
 for(const skipWeekends of [false,true])for(const start of ['2026-02-13','2026-02-15','2026-02-26','2026-10-09','2026-12-31','2027-02-04']){
  const days=C.boardDays(start,skipWeekends,true),next=C.shiftBoard(start,5,skipWeekends,true),following=C.boardDays(next,skipWeekends,true);
  assert.equal(C.shiftBoard(next,-5,skipWeekends,true),days[0],start);
  assert.equal(new Set([...days,...following]).size,10,start);
  assert.ok(following[0]>days.at(-1),start);
  assert.equal(C.shiftBoard(days.at(-1),1,skipWeekends,true),following[0],start);
  for(const day of [...days,...following])assert.equal(C.holiday(day),'',day);
 }
});
test('holiday filtering excludes hidden dates but keeps meetings extending into a visible day',()=>{
 const holidayOnly=C.boardDays('2026-02-13',false,true),workingDays=C.boardDays('2026-02-13',true,true);
 const check=(start,end,days=holidayOnly)=>C.overlapsDays(Date.parse(start+'+08:00'),Date.parse(end+'+08:00'),days);
 assert.equal(check('2026-02-20T10:00:00','2026-02-20T11:00:00'),false);
 assert.equal(check('2026-02-20T00:00:00','2026-02-21T00:00:00'),false);
 assert.equal(check('2026-02-21T10:00:00','2026-02-21T11:00:00'),true);
 assert.equal(check('2026-02-21T10:00:00','2026-02-21T11:00:00',workingDays),false);
 assert.equal(check('2026-02-20T23:30:00','2026-02-21T10:00:00'),true);
 assert.equal(check('2026-02-22T23:30:00','2026-02-23T10:00:00',workingDays),true);
 assert.equal(check('2026-02-27T10:00:00','2026-02-27T11:00:00',workingDays),false);
});
