import {test} from 'node:test';
import assert from 'node:assert/strict';
import {minimizeEvent} from '../src/calendar.ts';
const meeting={id:'invite',summary:'會議',location:'主會議室',start:{dateTime:'2026-10-05T10:00:00+08:00'},end:{dateTime:'2026-10-05T11:00:00+08:00'}};
test('Calendar cache preserves only validated sequence and updated metadata',()=>{
  const safe=minimizeEvent({...meeting,sequence:5,updated:'2026-10-03T20:15:00+08:00',description:'private',attachments:['private'],customVersion:'private'},'主會議室');
  assert.equal(safe.sequence,5);assert.equal(safe.updated,'2026-10-03T12:15:00.000Z');assert.equal(safe.description,undefined);assert.equal(safe.attachments,undefined);assert.equal(safe.customVersion,undefined);
  for(const sequence of [-1,2147483648,Infinity,2.5,'999',null])assert.equal(minimizeEvent({...meeting,sequence},'主會議室').sequence,undefined);
  for(const updated of ['2026-02-30T12:00:00Z','2026-10-03','2026-10-03T24:00:00Z','2026-10-03T12:99:00Z','x'.repeat(51),{value:'2026-10-03T12:00:00Z'},null])assert.equal(minimizeEvent({...meeting,updated},'主會議室').updated,undefined);
});
test('new cache distinguishes singles and safely preserves recurring occurrence identity',()=>{
  const single=minimizeEvent(meeting,'主會議室');assert.equal(single.recurringEventId,'');assert.equal(single.originalStartTime,undefined);
  const recurring=minimizeEvent({...meeting,recurringEventId:'local_series_123',originalStartTime:{dateTime:'2026-10-05T10:00:00+08:00',timeZone:'Asia/Taipei',description:'private'}},'主會議室');assert.equal(recurring.recurringEventId,'local_series_123');assert.deepEqual(recurring.originalStartTime,{dateTime:'2026-10-05T02:00:00.000Z'});
  assert.deepEqual(minimizeEvent({...meeting,recurringEventId:'series',originalStartTime:{date:'2026-10-05'}},'主會議室').originalStartTime,{date:'2026-10-05'});
  for(const recurringEventId of ['bad id','x'.repeat(1025),{},42])assert.equal(minimizeEvent({...meeting,recurringEventId},'主會議室').recurringEventId,undefined);
  for(const originalStartTime of [{date:'2026-02-30'},{dateTime:'2026-10-05T24:00:00Z'},{dateTime:'bad'},{date:'2026-10-05',dateTime:'2026-10-05T10:00:00Z'},{description:'private'},null])assert.equal(minimizeEvent({...meeting,recurringEventId:'series',originalStartTime},'主會議室').originalStartTime,undefined);
});
