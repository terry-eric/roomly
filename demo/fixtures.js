(function (root) {
  'use strict';
  const room = Object.freeze({ id: 'demo-room', name: '示範會議室', aliases: [] });
  const people = Object.freeze(['安安（虛構）', '柏宇（虛構）', '晨曦（虛構）', '方晴（虛構）', '樂樂（虛構）']);
  const meetings = Object.freeze([
    { title: '設計討論', start: '09:00', end: '10:30', participants: 3 },
    { title: '專案交流', start: '11:00', end: '12:00', participants: 2 },
    { title: '團隊工作坊', start: '14:00', end: '16:00', participants: 5 },
    { title: '進度回顧', start: '16:30', end: '18:30', participants: 4 }
  ]);

  function create(core, days) {
    if (!Array.isArray(days) || days.length > 31 || new Set(days).size !== days.length) throw new Error('Invalid demo dates');
    const events = days.flatMap((day, dayIndex) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || core.date(core.instant(day, '00:00')) !== day) throw new Error('Invalid demo date');
      return meetings.map((meeting, index) => {
        const attendees = Array.from({ length: meeting.participants }, (_, n) => people[(n + dayIndex + index) % people.length]);
        return {
          id: `fictional-${day}-${index}`, title: meeting.title,
          startISO: new Date(core.instant(day, meeting.start)).toISOString(),
          endISO: new Date(core.instant(day, meeting.end)).toISOString(),
          organizer: attendees[0], attendees,
          attendeeDetails: attendees.map(name => ({ name, status: 'accepted' })),
          roomIds: [room.id], busyRoomIds: [room.id], location: room.name,
          meet: '', allDay: false, source: 'fictional', sources: ['虛構資料']
        };
      });
    });
    return { rooms: [{ ...room, aliases: [] }], events };
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoomlyDemoFixtures = api;
})(typeof window !== 'undefined' ? window : globalThis);
