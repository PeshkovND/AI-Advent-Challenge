import assert from 'node:assert/strict'
import test from 'node:test'
import { findFreeCalendarSlots } from './calendar-slots'

const base = {
  from: '2026-09-28T00:00:00+06:00',
  to: '2026-09-29T00:00:00+06:00',
  durationMinutes: 60,
  workdayStart: '09:00',
  workdayEnd: '18:00',
  timeZone: 'Asia/Omsk',
  weekdays: [1, 2, 3, 4, 5],
  limit: 3,
}

test('findFreeCalendarSlots passes calendar events into deterministic free gaps', () => {
  const slots = findFreeCalendarSlots({
    ...base,
    events: [
      { startsAt: '2026-09-28T10:00:00+06:00', endsAt: '2026-09-28T11:00:00+06:00' },
      { startsAt: '2026-09-28T12:00:00+06:00', endsAt: '2026-09-28T13:30:00+06:00' },
    ],
  })
  assert.deepEqual(slots.map((slot) => [slot.startsAt, slot.endsAt]), [
    ['2026-09-28T03:00:00.000Z', '2026-09-28T04:00:00.000Z'],
    ['2026-09-28T05:00:00.000Z', '2026-09-28T06:00:00.000Z'],
    ['2026-09-28T07:30:00.000Z', '2026-09-28T08:30:00.000Z'],
  ])
})

test('findFreeCalendarSlots merges overlapping events and skips weekends', () => {
  const slots = findFreeCalendarSlots({
    ...base,
    from: '2026-10-03T00:00:00+06:00',
    to: '2026-10-06T00:00:00+06:00',
    events: [
      { startsAt: '2026-10-05T09:00:00+06:00', endsAt: '2026-10-05T10:00:00+06:00' },
      { startsAt: '2026-10-05T09:30:00+06:00', endsAt: '2026-10-05T11:00:00+06:00' },
    ],
  })
  assert.equal(slots[0]?.startsAt, '2026-10-05T05:00:00.000Z')
  assert.equal(slots[0]?.endsAt, '2026-10-05T06:00:00.000Z')
})
