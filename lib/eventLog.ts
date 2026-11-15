// Allow-listed fields only: IDs, status, outcome, redacted suffix.
// Never add bodies, full numbers, signatures, tokens, recordings or transcripts here.
export type LogEntry = { ts: string; evt: string; eventId?: string; status?: string; from?: string; outcome: string };
const entries: LogEntry[] = [];

export function logEvent(e: Omit<LogEntry, "ts">) {
  const entry: LogEntry = { ts: new Date().toISOString(), ...e };
  entries.push(entry);
  if (entries.length > 1000) entries.shift();
  if (process.env.NODE_ENV !== "test") console.log(JSON.stringify(entry));
}
export const getEventLog = () => entries.slice();
export const clearEventLog = () => { entries.length = 0; };
