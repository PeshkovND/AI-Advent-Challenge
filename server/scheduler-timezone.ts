const fallbackTimeZone = 'Asia/Omsk'

/** The explicit default used only when a user did not name a timezone. */
export function getDefaultSchedulerTimeZone() {
  const candidate = process.env.AGENT_TIME_ZONE?.trim() || fallbackTimeZone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format()
    return candidate
  } catch {
    return fallbackTimeZone
  }
}
