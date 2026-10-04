// Atomic server-side coalescing also covers concurrent tabs and devices.
// A manual request may upgrade a small regular job to an all-source batch.
// Neither admission nor expiry changes a source's real completion timestamp.
export async function reserveCalendarEnqueue(env:Env,week:string,manual:boolean,time:number){
  const claimed=await env.DB.prepare(`INSERT INTO calendar_enqueue_gates(week_start,regular_until,manual_until) VALUES(?,?,?) ON CONFLICT(week_start) DO UPDATE SET regular_until=MAX(calendar_enqueue_gates.regular_until,excluded.regular_until),manual_until=MAX(calendar_enqueue_gates.manual_until,excluded.manual_until) WHERE ${manual?'calendar_enqueue_gates.manual_until<=?':'calendar_enqueue_gates.regular_until<=? AND calendar_enqueue_gates.manual_until<=?'} RETURNING week_start`).bind(week,time+180,manual?time+30:0,time,...(manual?[]:[time])).first();
  return !!claimed;
}
