export type CalendarInterval = {
  startsAt: string
  endsAt: string
}

export type FreeSlotSearchInput = {
  events: CalendarInterval[]
  from: string
  to: string
  durationMinutes: number
  workdayStart: string
  workdayEnd: string
  timeZone: string
  weekdays: number[]
  limit: number
}

export type FreeCalendarSlot = CalendarInterval

type LocalDate = { year: number; month: number; day: number; hour: number; minute: number }

function localParts(date: Date, timeZone: string): LocalDate {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {})
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) }
}

function parseClock(value: string) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value)
  if (!match) throw new Error('Время рабочего дня должно быть в формате HH:MM.')
  const [hour, minute] = value.split(':').map(Number)
  return { hour, minute }
}

/** Converts a local IANA date/time to its instant without relying on server timezone. */
function zonedInstant(date: LocalDate, timeZone: string) {
  let timestamp = Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute)
  const expected = Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute)
  // The offset may change around DST. Re-evaluate until the formatted local
  // time matches the requested wall-clock value.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(timestamp), timeZone)
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const correction = expected - actualAsUtc
    if (correction === 0) return new Date(timestamp)
    timestamp += correction
  }
  const result = new Date(timestamp)
  const resolved = localParts(result, timeZone)
  if (resolved.year !== date.year || resolved.month !== date.month || resolved.day !== date.day || resolved.hour !== date.hour || resolved.minute !== date.minute) {
    throw new Error('Указанное местное время не существует в выбранном часовом поясе.')
  }
  return result
}

function dateAtMidnight(date: LocalDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day))
}

function nextDay(date: Date) {
  return new Date(date.getTime() + 24 * 60 * 60 * 1_000)
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged[merged.length - 1]
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

/**
 * Calculates candidate gaps from event intervals. It is intentionally pure:
 * CalDAV reads happen in get_calendar_events and writes in create_calendar_event.
 */
export function findFreeCalendarSlots(input: FreeSlotSearchInput): FreeCalendarSlot[] {
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new Error('Период поиска свободных окон некорректен.')
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1) throw new Error('Длительность должна быть положительным числом минут.')
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error('Лимит окон должен быть положительным числом.')
  // Validates the IANA identifier before using it in formatting.
  new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format(from)
  const workdayStart = parseClock(input.workdayStart)
  const workdayEnd = parseClock(input.workdayEnd)
  if (workdayEnd.hour * 60 + workdayEnd.minute <= workdayStart.hour * 60 + workdayStart.minute) throw new Error('Конец рабочего дня должен быть позже начала.')

  const durationMs = input.durationMinutes * 60 * 1_000
  const busy = input.events.flatMap((event) => {
    const start = new Date(event.startsAt).getTime()
    const end = new Date(event.endsAt).getTime()
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : []
  })
  const results: FreeCalendarSlot[] = []
  let day = dateAtMidnight(localParts(from, input.timeZone))

  while (results.length < input.limit) {
    const localDay = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }
    const dayStart = zonedInstant({ ...localDay, ...workdayStart }, input.timeZone)
    const dayEnd = zonedInstant({ ...localDay, ...workdayEnd }, input.timeZone)
    if (dayStart >= to) break
    if (input.weekdays.includes(day.getUTCDay())) {
      const start = Math.max(dayStart.getTime(), from.getTime())
      const end = Math.min(dayEnd.getTime(), to.getTime())
      if (end - start >= durationMs) {
        const occupied = mergeIntervals(busy
          .filter((interval) => interval.start < end && interval.end > start)
          .map((interval) => ({ start: Math.max(start, interval.start), end: Math.min(end, interval.end) })))
        let cursor = start
        for (const interval of occupied) {
          if (interval.start - cursor >= durationMs) {
            results.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(cursor + durationMs).toISOString() })
            if (results.length >= input.limit) return results
          }
          cursor = Math.max(cursor, interval.end)
        }
        if (end - cursor >= durationMs) results.push({ startsAt: new Date(cursor).toISOString(), endsAt: new Date(cursor + durationMs).toISOString() })
      }
    }
    day = nextDay(day)
  }
  return results
}
