const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),RoomCore=require('../core.js');

function harness(native=false,{stored={},now}={}){
  const elements=new Map(),documentEvents={},windowEvents={},frames=[],focuses=[],storage=new Map(Object.entries(stored));
  const element=id=>{
    if(elements.has(id))return elements.get(id);
    const events={},attrs={},styles={};
    const el={id,value:'',checked:false,hidden:false,dataset:{},innerHTML:'',textContent:'',clientWidth:400,scrollWidth:1500,scrollLeft:0,scrollTop:0,isConnected:true,
      style:{setProperty:(key,value)=>styles[key]=value,removeProperty:key=>delete styles[key]},classList:{toggle(){},remove(){},add(){},contains:()=>false},
      setAttribute:(key,value)=>attrs[key]=value,removeAttribute:key=>delete attrs[key],getAttribute:key=>attrs[key],
      addEventListener:(name,fn)=>events[name]=fn,getBoundingClientRect:()=>({left:20,top:100,bottom:144,width:44,height:44}),
      querySelector:()=>element('close-name'),contains:target=>target===el||target===element('close-name'),
      matches:()=>{throw new SyntaxError('unsupported pseudo-class');},focus:()=>focuses.push(id),scrollTo:position=>{el.scrollLeft=position.left;el.scrollTop=position.top;},
      offsetHeight:30,events,attrs,styles};
    elements.set(id,el);return el;
  };
  const popover=element('#person-popover');
  if(native){
    popover.showPopover=()=>{popover.events.beforetoggle({newState:'open'});popover.events.toggle({newState:'open'});};
    popover.hidePopover=()=>{popover.events.beforetoggle({newState:'closed'});popover.events.toggle({newState:'closed'});};
  }
  const document={body:{classList:{contains:()=>false}},documentElement:{clientWidth:400},hidden:false,
    querySelector:selector=>['dialog[open]','.now-slot','.now-line','.now-line:not([hidden])'].includes(selector)?null:element(selector),
    querySelectorAll:selector=>selector==='[data-person][aria-expanded="true"]'?[...elements.values()].filter(el=>el.attrs['aria-expanded']==='true'):[],
    addEventListener:(name,fn)=>{(documentEvents[name]||=[]).push(fn);}};
  const TestDate=now?class extends Date{static now(){return Date.parse(now);}}:Date;
  const context={RoomCore,document,localStorage:{getItem:key=>storage.has(key)?storage.get(key):null,setItem:(key,value)=>storage.set(key,String(value))},Date:TestDate,Intl,crypto,innerWidth:400,innerHeight:800,scrollY:0,
    getComputedStyle:()=>({minHeight:'240px'}),requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},setInterval(){},setTimeout(){},clearTimeout(){},
    addEventListener:(name,fn)=>windowEvents[name]=fn};context.window=context;
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8'),context);
  const person=element('person');person.dataset.person='小明';person.closest=selector=>selector==='[data-person]'?person:null;
  return {context,element,popover,person,focuses,documentEvents,storage};
}

test('a browser without Popover renders the whole board and opens a touch-accessible name fallback',()=>{
  const h=harness();assert.match(h.element('#gantt').innerHTML,/gantt-grid/);assert.equal(h.popover.hidden,true);assert.equal(h.context.personOpen(),false);
  h.context.showPerson(h.person);assert.equal(h.popover.hidden,false);assert.equal(h.element('#person-name').textContent,'小明');assert.equal(h.person.attrs['aria-expanded'],'true');assert.equal(h.context.personOpen(),true);assert.equal(h.focuses.at(-1),'close-name');
  h.element('close-name').onclick();assert.equal(h.popover.hidden,true);assert.equal(h.person.attrs['aria-expanded'],'false');assert.equal(h.focuses.at(-1),'person');
});

test('fallback Escape closes the name first and outside taps dismiss it without stealing focus',()=>{
  const h=harness();h.context.showPerson(h.person);let prevented=false,stopped=false;
  for(const handler of h.documentEvents.keydown)handler({key:'Escape',preventDefault:()=>prevented=true,stopImmediatePropagation:()=>stopped=true});
  assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(h.context.personOpen(),false);assert.equal(h.focuses.at(-1),'person');
  h.context.showPerson(h.person);const count=h.focuses.length;
  for(const handler of h.documentEvents.click.slice(1))handler({target:{closest:()=>null}});
  assert.equal(h.context.personOpen(),false);assert.equal(h.focuses.length,count);
});

test('native Popover light dismissal updates state and accessibility without evaluating unsupported selectors',()=>{
  const h=harness(true);assert.equal(h.popover.dataset.fallback,undefined);h.context.showPerson(h.person);assert.equal(h.context.personOpen(),true);
  h.popover.hidePopover();assert.equal(h.context.personOpen(),false);assert.equal(h.person.attrs['aria-expanded'],'false');assert.doesNotThrow(()=>h.context.hidePerson());
});
test('vertical calendar scrolling preserves follow mode and manual horizontal scrolling pauses it',()=>{
 const h=harness(),host=h.element('#gantt-scroll');h.context.centerCurrentTime();
 host.scrollTop=264;host.events.scroll();assert.equal(h.element('#follow-now').attrs['aria-pressed'],'true');
 h.context.centerCurrentTime();assert.equal(host.scrollTop,264);
 host.scrollLeft+=40;host.events.scroll();assert.equal(h.element('#follow-now').attrs['aria-pressed'],'false');
});
test('changing weekend preference on the same start date reloads the matching shared range',()=>{
 const h=harness();h.element('#day').value='2026-10-02';h.context.RoomApp.setLive({events:[],rooms:[{id:'forest',name:'會議室'}],ready:true});
 let syncs=0;h.context.GoogleSync={sync:()=>syncs++};h.element('#skip-weekends').checked=true;h.element('#skip-weekends').onchange();
 assert.equal(syncs,1);assert.deepEqual(Array.from(h.context.RoomApp.days()),['2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08']);
});

test('holiday and weekend preferences restore independently and still render five dates after a skipped start date',()=>{
 const h=harness(false,{stored:{'roomly.skip-weekends':'true','roomly.skip-holidays':'true'},now:'2026-10-09T11:00:00+08:00'});
 assert.equal(h.element('#skip-weekends').checked,true);assert.equal(h.element('#skip-holidays').checked,true);assert.equal(h.element('#day').value,'2026-10-09');assert.deepEqual(Array.from(h.context.RoomApp.days()),['2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16']);assert.match(h.element('#week-label').textContent,/2026\/10\/12/);assert.match(h.element('#holiday-scope').textContent,/起始日已略過，從 2026\/10\/12 顯示/);
 const onlyHolidays=harness(false,{stored:{'roomly.skip-holidays':'true'},now:'2026-10-09T11:00:00+08:00'});assert.equal(onlyHolidays.element('#skip-weekends').checked,false);assert.deepEqual(Array.from(onlyHolidays.context.RoomApp.days()),['2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15']);
});

test('both skip options persist, combine and apply to forward and backward date paging',()=>{
 const h=harness(false,{now:'2026-10-08T11:00:00+08:00'});assert.deepEqual(Array.from(h.context.RoomApp.days()),['2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12']);
 h.element('#skip-holidays').checked=true;h.element('#skip-holidays').onchange();assert.equal(h.storage.get('roomly.skip-holidays'),'true');assert.deepEqual(Array.from(h.context.RoomApp.days()),['2026-10-08','2026-10-11','2026-10-12','2026-10-13','2026-10-14']);
 h.element('#skip-weekends').checked=true;h.element('#skip-weekends').onchange();assert.equal(h.storage.get('roomly.skip-weekends'),'true');const first=Array.from(h.context.RoomApp.days());assert.deepEqual(first,['2026-10-08','2026-10-12','2026-10-13','2026-10-14','2026-10-15']);
 h.element('#next-date').onclick();const next=Array.from(h.context.RoomApp.days());assert.deepEqual(next,['2026-10-16','2026-10-19','2026-10-20','2026-10-21','2026-10-22']);assert.equal(new Set([...first,...next]).size,10);h.element('#prev-date').onclick();assert.deepEqual(Array.from(h.context.RoomApp.days()),first);
 h.element('#skip-holidays').checked=false;h.element('#skip-holidays').onchange();assert.equal(h.storage.get('roomly.skip-holidays'),'false');assert.equal(h.element('#skip-weekends').checked,true);assert.equal(h.storage.get('roomly.skip-weekends'),'true');assert.deepEqual(Array.from(h.context.RoomApp.days()),['2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14']);
});

test('every skip preference change reloads Google even if the five visible dates happen to stay the same',()=>{
 const h=harness(false,{now:'2026-10-12T11:00:00+08:00'});h.context.RoomApp.setLive({events:[],rooms:[{id:'forest',name:'會議室'}],ready:true});const days=Array.from(h.context.RoomApp.days());let syncs=0;h.context.GoogleSync={sync:()=>syncs++};
 for(const id of ['#skip-holidays','#skip-weekends']){h.element(id).checked=true;h.element(id).onchange();assert.deepEqual(Array.from(h.context.RoomApp.days()),days);}
 assert.equal(syncs,2);h.element('#skip-holidays').checked=false;h.element('#skip-holidays').onchange();assert.equal(syncs,3);
});

test('a holiday date keeps its name, accessible description and today marker while weekend rows stay marked',()=>{
 const h=harness(false,{now:'2026-10-09T11:00:00+08:00'}),name=RoomCore.holiday('2026-10-09'),markup=h.element('#gantt').innerHTML;assert.ok(name);
 const todayRow=markup.split('<div data-date="2026-10-09"')[1].split('<div data-date=')[0];assert.match(todayRow,/is-today/);assert.match(todayRow,/is-holiday/);assert.match(todayRow,/aria-current="date"/);assert.match(todayRow,/<em>今天<\/em>/);assert.ok(todayRow.includes('class="holiday-badge">'+name));assert.ok(todayRow.includes('aria-label="查看 2026-10-09 週五（'+name+'） 的會議"'));
 const saturday=markup.split('<div data-date="2026-10-10"')[1].split('<div data-date=')[0];assert.match(saturday,/weekend/);assert.match(saturday,/is-holiday/);
 h.element('#day').value='2028-01-04';h.element('#day').onchange();assert.match(h.element('#holiday-scope').textContent,/2028 無假日資料/);assert.equal(h.element('#gantt').innerHTML.includes('holiday-badge'),false);
});
