/** Today's calendar date (YYYY-MM-DD) in the business's timezone, not the browser's or UTC. Between midnight and 5 am in Karachi, UTC still says yesterday. */
export function businessToday(timezone = "Asia/Karachi", now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: timezone });
}
