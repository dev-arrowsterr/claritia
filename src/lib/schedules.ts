// How schedules read in the app. The times themselves are worked out in the database (schedule_next).

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const two = (n: number) => String(n).padStart(2, "0");

/** "Every day at 09:00 (Asia/Tokyo)" */
export function describeSchedule(s: { every: "hour" | "day" | "weekday" | "week"; at_hour: number; at_minute: number; weekday: number; timezone: string }) {
  const time = `${two(s.at_hour)}:${two(s.at_minute)}`;
  if (s.every === "hour") return `Every hour at :${two(s.at_minute)}`;
  if (s.every === "day") return `Every day at ${time} (${s.timezone})`;
  if (s.every === "weekday") return `Weekdays at ${time} (${s.timezone})`;
  return `Every ${DAYS[s.weekday]} at ${time} (${s.timezone})`;
}
