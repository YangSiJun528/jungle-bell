export const MINUTE_MS = 60_000;
export const EXPECTED_LG_REFRESH_SECONDS = 300;
export const OVERDUE_LG_REFRESH_SECONDS = 360;

export function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function minuteEpoch(date: Date): number {
  return Math.floor(date.getTime() / MINUTE_MS);
}

export function compactUtcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replaceAll("-", "").replace(":", "") + "Z";
}

export function parseCompactUtcMinute(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00.000Z`);
  if (Number.isNaN(date.getTime()) || compactUtcMinute(date) !== value) return null;
  return date;
}

export function snapshotPath(source: string, scheduledAt: Date, sha: string): string {
  const iso = scheduledAt.toISOString();
  const [day, time] = iso.split("T");
  if (!day || !time) throw new Error("Invalid scheduled time");
  const [year, month, date] = day.split("-");
  return `raw/${source}/${year}/${month}/${date}/${time.replaceAll(":", "").replace(".000Z", "Z")}-${sha}.json`;
}

export function datedObjectPath(prefix: string, date: Date, name: string): string {
  const [day] = date.toISOString().split("T");
  if (!day) throw new Error("Invalid date");
  const [year, month, datePart] = day.split("-");
  return `${prefix}/${year}/${month}/${datePart}/${name}`;
}

export function latestCollectionCommitPath(source: string): string {
  return `collector/latest/${source}.json`;
}
