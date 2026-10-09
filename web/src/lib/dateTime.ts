import { DEFAULT_TIME_ZONE } from "../../../shared/timezone";

type DateValue = string | number | Date;

/** D1's datetime('now') and timezone-less provider timestamps are UTC. */
export function parseUtcDate(value: DateValue): Date {
  if (typeof value !== "string") return new Date(value);
  const normalized = value.trim().replace(" ", "T");
  return new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)
    ? `${normalized}Z`
    : normalized);
}

export function formatDateTime(
  value: DateValue,
  timeZone = DEFAULT_TIME_ZONE,
  locale = "zh-CN",
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "medium" },
): string {
  const date = parseUtcDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
}

function zonedParts(value: DateValue, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(parseUtcDate(value));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function toDateTimeInput(value: DateValue, timeZone: string): string {
  const p = zonedParts(value, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interpret datetime-local in the selected zone, including DST and fractional offsets. */
export function fromDateTimeInput(value: string, timeZone: string, original?: string): string {
  // Preserve seconds and the original occurrence of an ambiguous DST time if unchanged.
  if (original && value === toDateTimeInput(original, timeZone)) {
    return parseUtcDate(original).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new RangeError("invalid date/time");
  const wallTime = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wallTime)) throw new RangeError("invalid date/time");

  // Sample offsets on either side of the requested day to cover DST transitions.
  const offsets = [-36, 0, 36].map((hours) => {
    const instant = wallTime + hours * 3600000;
    const p = zonedParts(instant, timeZone);
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - instant;
  });
  const candidates = [...new Set(offsets)].map((offset) => wallTime - offset).sort((a, b) => a - b);
  const match = candidates.find((instant) => toDateTimeInput(instant, timeZone) === value);
  // A wall time inside a DST gap does not exist; require the user to choose another time.
  if (match === undefined) throw new RangeError("invalid date/time");
  return new Date(match).toISOString();
}

export function formatInboxDate(value: DateValue, timeZone: string, locale: string, now: DateValue = new Date()): string {
  const date = parseUtcDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  const isToday = toDateTimeInput(date, timeZone).slice(0, 10) === toDateTimeInput(now, timeZone).slice(0, 10);
  return formatDateTime(date, timeZone, locale, isToday
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

export function availableTimeZones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [
    "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Asia/Dubai",
    "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Australia/Sydney",
  ];
  return [...new Set([DEFAULT_TIME_ZONE, "UTC", ...zones])];
}

export function timeZoneOffsetLabel(timeZone: string): string {
  const label = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return label.replace("GMT", "UTC");
}
