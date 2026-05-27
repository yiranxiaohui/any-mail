import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { useAuth } from "@/lib/auth";

function HtmlBodyFrame({ html }: { html: string }) {
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;color:#111;background:#fff;word-wrap:break-word;overflow-wrap:break-word}body{padding:12px}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      className="h-[420px] w-full rounded-md border bg-white"
      title="email-html"
    />
  );
}

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
  const { user, logout, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");
  const [to, setTo] = useState(() => localStorage.getItem(TO_STORAGE) ?? "");
  const [codeRegex, setCodeRegex] = useState(() => localStorage.getItem(REGEX_STORAGE) ?? "");
  const [emails, setEmails] = useState<ReceivedEmail[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoPoll, setAutoPoll] = useState(false);
  const [error, setError] = useState("");
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
            {isAuthenticated ? (
              <>
                <Button variant="ghost" size="sm" render={<Link to="/console" />}>
                  {t("receive.console")}
                </Button>
                <div className="hidden sm:flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="7" r="4" />
                    <path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" />
                  </svg>
                  <span className="max-w-[160px] truncate font-medium">{user?.email ?? user?.id ?? ""}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    logout();
                    navigate("/");
                  }}
                >
                  {t("receive.logout")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" render={<Link to="/register" />}>
                  {t("receive.register")}
                </Button>
                <Button variant="ghost" size="sm" render={<Link to="/login" />}>
                  {t("receive.login")}
                </Button>
              </>
            )}
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
          {emails.map((m) => {
            const expanded = expandedId === m.id;
            const hasHtml = !!m.html_body;
            const hasText = !!m.text_body;
            return (
              <Card key={m.id}>
                <CardContent className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                    className="-mx-1 flex w-full items-start justify-between gap-3 rounded-md px-1 py-0.5 text-left hover:bg-muted/50"
                    aria-expanded={expanded}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {m.subject || t("receive.noSubject")}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.from_address} → {m.to_address}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span>
                        {new Date(
                          m.received_at.includes("T")
                            ? m.received_at
                            : m.received_at.replace(" ", "T") + "Z",
                        ).toLocaleString()}
                      </span>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </button>

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

                  {expanded && (
                    hasHtml ? (
                      <Tabs defaultValue="html" className="flex flex-col gap-2">
                        <TabsList>
                          <TabsTrigger value="html">{t("email.html")}</TabsTrigger>
                          <TabsTrigger value="text">{t("email.text")}</TabsTrigger>
                        </TabsList>
                        <TabsContent value="html">
                          <HtmlBodyFrame html={m.html_body} />
                        </TabsContent>
                        <TabsContent value="text">
                          <pre className="max-h-[420px] overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap break-words">
                            {m.text_body || t("email.empty")}
                          </pre>
                        </TabsContent>
                      </Tabs>
                    ) : (
                      <pre className="max-h-[420px] overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap break-words">
                        {m.text_body || t("email.empty")}
                      </pre>
                    )
                  )}

                  {!expanded && hasText && (
                    <pre className="max-h-24 overflow-hidden rounded-md bg-muted px-3 py-2 text-xs whitespace-pre-wrap break-words [mask-image:linear-gradient(to_bottom,black,transparent)]">
                      {m.text_body}
                    </pre>
                  )}
                  {!expanded && !hasText && hasHtml && (
                    <p className="text-xs text-muted-foreground italic">
                      {t("receive.htmlOnly")}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>

      <Toaster />
    </div>
  );
}
