import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "../../../shared/timezone";
import { apiMe } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TimeZoneContext } from "@/lib/timezone";

export default function TimeZoneProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  return <SessionTimeZone key={token ?? "anonymous"} authenticated={!!token}>{children}</SessionTimeZone>;
}

function SessionTimeZone({ children, authenticated }: { children: ReactNode; authenticated: boolean }) {
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const changed = useRef(false);
  const updateTimeZone = useCallback((value: string) => {
    changed.current = true;
    setTimeZone(resolveTimeZone(value));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    apiMe().then((res) => {
      if (!cancelled && !changed.current) setTimeZone(resolveTimeZone(res.time_zone));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  return (
    <TimeZoneContext.Provider value={{ timeZone, setTimeZone: updateTimeZone }}>
      {children}
    </TimeZoneContext.Provider>
  );
}
