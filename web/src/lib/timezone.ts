import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TIME_ZONE } from "../../../shared/timezone";
import { formatDateTime, formatInboxDate } from "./dateTime";

export const TimeZoneContext = createContext<{ timeZone: string; setTimeZone: (value: string) => void }>({
  timeZone: DEFAULT_TIME_ZONE,
  setTimeZone: () => {},
});

export function useTimeZone() {
  return useContext(TimeZoneContext);
}

export function useDateTime() {
  const { timeZone } = useTimeZone();
  const { i18n } = useTranslation();
  const locale = i18n.language === "zh" ? "zh-CN" : "en-US";
  return {
    timeZone,
    formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      formatDateTime(value, timeZone, locale, options),
    formatDate: (value: string | number | Date) => formatDateTime(value, timeZone, locale, { dateStyle: "medium" }),
    formatTime: (value: string | number | Date) => formatDateTime(value, timeZone, locale, { timeStyle: "medium" }),
    formatInboxDate: (value: string) => formatInboxDate(value, timeZone, locale),
  };
}
