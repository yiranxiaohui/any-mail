import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";

const BASE = import.meta.env.VITE_API_BASE ?? "";

const KEY_STORAGE = "anymail_receive_key";
const TO_STORAGE = "anymail_receive_to";
const REGEX_STORAGE = "anymail_receive_regex";
const WINDOW_MINUTES = 10;
const POLL_INTERVAL_MS = 5000;

interface ReceivedEmail {
  id: string;
  from_address: string;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string;
  received_at: string;
  code?: string | null;
}

export default function Receive() {
  const { t, i18n } = useTranslation();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");
  const [to, setTo] = useState(() => localStorage.getItem(TO_STORAGE) ?? "");
  const [codeRegex, setCodeRegex] = useState(() => localStorage.getItem(REGEX_STORAGE) ?? "");
  const [emails, setEmails] = useState<ReceivedEmail[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [error, setError] = useState("");
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // 用 ref 持有最新输入，避免轮询定时器闭包
  const inputsRef = useRef({ apiKey, to, codeRegex });
  inputsRef.current = { apiKey, to, codeRegex };

  const fetchLatest = async (silent = false) => {
    const { apiKey: key, to: toAddr, codeRegex: regex } = inputsRef.current;
    if (!key) {
      setError(t("receive.errors.missingKey"));
      return;
    }
    if (!silent) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (toAddr) params.set("to", toAddr);
      params.set("since", new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString());
      if (regex) params.set("code_regex", regex);
      params.set("limit", "10");

      const res = await fetch(`${BASE}/api/emails/latest?${params.toString()}`, {
        headers: { Authorization: `Bearer ${key}` },
      });

      if (res.status === 401 || res.status === 403) {
        setError(t("receive.errors.unauthorized"));
        setAutoPoll(false);
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? t("receive.errors.badRequest"));
        return;
      }
      if (!res.ok) {
        setError(t("receive.errors.requestFailed", { status: res.status }));
        return;
      }

      const data = (await res.json()) as { emails: ReceivedEmail[] };
      setEmails(data.emails);
      setLastFetched(new Date());

      // persist on first successful fetch
      localStorage.setItem(KEY_STORAGE, key);
      localStorage.setItem(TO_STORAGE, toAddr);
      localStorage.setItem(REGEX_STORAGE, regex);
    } catch {
      setError(t("receive.errors.network"));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // 自动轮询
  useEffect(() => {
    if (!autoPoll) return;
    const tick = () => {
      if (inputsRef.current.apiKey) fetchLatest(true);
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPoll]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchLatest();
  };

  const toggleLang = () => {
    const next = i18n.language === "zh" ? "en" : "zh";
    i18n.changeLanguage(next);
    localStorage.setItem("anymail_lang", next);
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t("receive.copied"));
    } catch {
      toast.error(t("receive.copyFailed"));
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="16" x="2" y="4" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <span className="font-semibold tracking-tight">{t("receive.title")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={toggleLang}>
              {i18n.language === "zh" ? "English" : "中文"}
            </Button>
            <Button variant="ghost" size="sm" render={<Link to="/login" />}>
              {t("receive.adminLogin")}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 p-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("receive.formTitle")}</CardTitle>
            <CardDescription>
              {t("receive.formDescription", { minutes: WINDOW_MINUTES })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("receive.fields.apiKey")}
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="ak_..."
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("receive.fields.to")}
                </label>
                <Input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={t("receive.fields.toPlaceholder")}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("receive.fields.codeRegex")}
                </label>
                <Input
                  value={codeRegex}
                  onChange={(e) => setCodeRegex(e.target.value)}
                  placeholder="\\b(\\d{6})\\b"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex items-center gap-2 pt-1">
                <Button type="submit" disabled={loading || !apiKey}>
                  {loading ? t("receive.fetching") : t("receive.fetch")}
                </Button>
                <Button
                  type="button"
                  variant={autoPoll ? "secondary" : "outline"}
                  onClick={() => setAutoPoll((v) => !v)}
                  disabled={!apiKey}
                >
                  {autoPoll ? t("receive.autoPollOn") : t("receive.autoPollOff")}
                </Button>
                {lastFetched && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("receive.lastFetched", {
                      time: lastFetched.toLocaleTimeString(),
                    })}
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {emails.length === 0 && !loading && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {lastFetched ? t("receive.noEmails") : t("receive.idle")}
            </p>
          )}
          {emails.map((m) => (
            <Card key={m.id}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {m.subject || t("receive.noSubject")}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {m.from_address} → {m.to_address}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">
                    {new Date(
                      m.received_at.includes("T")
                        ? m.received_at
                        : m.received_at.replace(" ", "T") + "Z",
                    ).toLocaleString()}
                  </div>
                </div>

                {m.code != null && (
                  <button
                    type="button"
                    onClick={() => copyCode(m.code as string)}
                    className="block w-full rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-left transition-colors hover:bg-primary/20"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("receive.code")}
                    </div>
                    <div className="font-mono text-lg font-semibold tracking-wide">
                      {m.code}
                    </div>
                  </button>
                )}

                {m.text_body && (
                  <pre className="max-h-40 overflow-y-auto rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap break-words">
                    {m.text_body}
                  </pre>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </main>

      <Toaster />
    </div>
  );
}
