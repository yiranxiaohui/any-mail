import { describe, expect, test } from "bun:test";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "../shared/timezone";
import {
  formatDateTime, formatInboxDate, fromDateTimeInput, parseUtcDate, toDateTimeInput,
} from "../web/src/lib/dateTime";

describe("date/time display", () => {
  test("parses D1 timestamps and timezone-less ISO timestamps as UTC", () => {
    for (const value of ["2026-10-09 06:30:00", "2026-10-09T06:30:00", "2026-10-09T06:30:00Z", "2026-10-09T14:30:00+08:00"]) {
      expect(parseUtcDate(value).toISOString()).toBe("2026-10-09T06:30:00.000Z");
      expect(toDateTimeInput(value, DEFAULT_TIME_ZONE)).toBe("2026-10-09T14:30");
    }
  });

  test("uses UTC+8 by default and can display a different selected zone", () => {
    expect(formatDateTime("2026-10-09 06:30:00")).toContain("14:30:00");
    expect(toDateTimeInput("2026-10-09T06:30:00Z", "UTC")).toBe("2026-10-09T06:30");
    expect(formatDateTime("invalid")).toBe("—");
  });

  test("decides whether mail arrived today using the selected zone across UTC midnight", () => {
    const now = "2026-10-09T00:15:00Z";
    const received = "2026-10-08T23:30:00Z";
    expect(formatInboxDate(received, DEFAULT_TIME_ZONE, "en-US", now)).toBe("07:30 AM");
    expect(formatInboxDate(received, "UTC", "en-US", now)).toBe("Oct 8");
  });
});

describe("expiration input", () => {
  test("round-trips selected UTC+8 and fractional-offset times", () => {
    expect(fromDateTimeInput("2026-10-09T14:30", DEFAULT_TIME_ZONE)).toBe("2026-10-09T06:30:00.000Z");
    expect(fromDateTimeInput("2026-10-09T14:30", "UTC")).toBe("2026-10-09T14:30:00.000Z");
    expect(fromDateTimeInput("2026-10-09T14:30", "Asia/Kathmandu")).toBe("2026-10-09T08:45:00.000Z");
  });

  test("uses daylight saving offsets and rejects nonexistent times", () => {
    expect(fromDateTimeInput("2026-01-09T14:30", "America/New_York")).toBe("2026-01-09T19:30:00.000Z");
    expect(fromDateTimeInput("2026-07-09T14:30", "America/New_York")).toBe("2026-07-09T18:30:00.000Z");
    expect(() => fromDateTimeInput("2026-03-08T02:30", "America/New_York")).toThrow(RangeError);
    expect(() => fromDateTimeInput("2026-02-30T12:00", DEFAULT_TIME_ZONE)).toThrow(RangeError);
  });

  test("preserves unchanged expiration seconds and the original occurrence of a repeated DST time", () => {
    const original = "2026-11-01T06:30:45.123Z";
    const input = toDateTimeInput(original, "America/New_York");
    expect(input).toBe("2026-11-01T01:30");
    expect(fromDateTimeInput(input, "America/New_York", original)).toBe(original);
    expect(fromDateTimeInput(input, "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });
});

test("time zone validation accepts recognized zones and rejects malformed values", () => {
  for (const zone of [DEFAULT_TIME_ZONE, "UTC", "America/New_York"]) expect(isValidTimeZone(zone)).toBe(true);
  for (const zone of ["", " ", "UTC+8", "Invalid/Zone", null, 8]) expect(isValidTimeZone(zone)).toBe(false);
});
