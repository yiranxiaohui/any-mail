import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getApiKeys, createApiKey, deleteApiKey, type ApiKey } from "@/lib/api";

const ALL_SCOPES = ["emails:read", "emails:send", "emails:delete", "accounts:read", "accounts:write"] as const;

export default function ApiKeys() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // form
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["emails:read"]);
  const [provider, setProvider] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState("");

  // plaintext reveal
  const [plaintext, setPlaintext] = useState<{ key: string; name: string } | null>(null);

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const data = await getApiKeys();
      setKeys(data.keys);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const resetForm = () => {
    setName("");
    setScopes(["emails:read"]);
    setProvider("");
    setExpiresAt("");
  };

  const toggleScope = (s: string) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const handleCreate = async () => {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    try {
      const res = await createApiKey({
        name: name.trim(),
        scopes,
        provider: provider || null,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      toast.success(t("apiKeys.created", { name: res.key.name }));
      setDialogOpen(false);
      setPlaintext({ key: res.plaintext, name: res.key.name });
      resetForm();
      fetchKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("apiKeys.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ApiKey) => {
    if (!confirm(t("apiKeys.revokeConfirm", { name: key.name }))) return;
    await deleteApiKey(key.id);
    setKeys((prev) => prev.filter((k) => k.id !== key.id));
    toast.success(t("apiKeys.revoked", { name: key.name }));
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("apiKeys.copied"));
    } catch {
      toast.error("Copy failed");
    }
  };

  const providerLabel = (p: string | null) => {
    if (!p) return t("apiKeys.providerAll");
    if (p === "domain") return t("apiKeys.providerDomain");
    if (p === "gmail") return t("apiKeys.providerGmail");
    if (p === "outlook") return t("apiKeys.providerOutlook");
    return p;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] gap-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("apiKeys.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("apiKeys.description")}</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" x2="12" y1="5" y2="19" />
            <line x1="5" x2="19" y1="12" y2="12" />
          </svg>
          {t("apiKeys.create")}
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("apiKeys.create")}</DialogTitle>
            <DialogDescription>{t("apiKeys.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("apiKeys.name")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.namePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("apiKeys.scopes")}</label>
              <div className="flex flex-wrap gap-2">
                {ALL_SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScope(s)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      scopes.includes(s)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-input hover:bg-accent"
                    }`}
                  >
                    {t(`apiKeys.scopeLabels.${s}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("apiKeys.provider")}</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">{t("apiKeys.providerAll")}</option>
                <option value="domain">{t("apiKeys.providerDomain")}</option>
                <option value="gmail">{t("apiKeys.providerGmail")}</option>
                <option value="outlook">{t("apiKeys.providerOutlook")}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("apiKeys.expiresAt")}</label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.expiresHint")}</p>
            </div>
            <Button
              className="w-full"
              onClick={handleCreate}
              disabled={creating || !name.trim() || scopes.length === 0}
            >
              {creating ? t("settings.saving") : t("apiKeys.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Plaintext reveal dialog */}
      <Dialog open={!!plaintext} onOpenChange={(open) => { if (!open) setPlaintext(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("apiKeys.plaintextTitle")}</DialogTitle>
            <DialogDescription>{plaintext?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="rounded-md border border-amber-300/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
              {t("apiKeys.plaintextWarning")}
            </div>
            <div className="flex gap-2">
              <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-xs font-mono break-all">
                {plaintext?.key}
              </code>
              <Button variant="outline" onClick={() => plaintext && copyToClipboard(plaintext.key)}>
                {t("apiKeys.copy")}
              </Button>
            </div>
            <Button className="w-full" onClick={() => setPlaintext(null)}>
              {t("apiKeys.plaintextDone")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card className="flex flex-col min-h-0 flex-1">
        <CardHeader className="shrink-0">
          <CardTitle className="text-base">{t("apiKeys.title")}</CardTitle>
          <CardDescription>
            {keys.length} {keys.length === 1 ? "key" : "keys"}
          </CardDescription>
        </CardHeader>
        <Separator />
        {loading ? (
          <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("inbox.loading")}
          </CardContent>
        ) : keys.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
            <p className="text-sm font-medium">{t("apiKeys.empty")}</p>
            <p className="text-xs mt-1">{t("apiKeys.emptyHint")}</p>
          </CardContent>
        ) : (
          <div className="divide-y overflow-y-auto flex-1 min-h-0">
            {keys.map((key) => {
              const scopesList = key.scopes.split(",").filter(Boolean);
              const isExpired = key.expires_at && new Date(key.expires_at) < new Date();
              return (
                <div key={key.id} className="flex items-start justify-between px-6 py-4 gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{key.name}</span>
                      <code className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {key.key_prefix}…
                      </code>
                      <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {providerLabel(key.provider)}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {scopesList.map((s) => (
                        <span key={s} className="text-xs rounded-md bg-accent px-1.5 py-0.5 text-accent-foreground">
                          {t(`apiKeys.scopeLabels.${s}`, { defaultValue: s })}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("apiKeys.createdAt", { date: new Date(key.created_at).toLocaleString() })}
                      {" · "}
                      {key.last_used_at
                        ? t("apiKeys.lastUsed", { date: new Date(key.last_used_at).toLocaleString() })
                        : t("apiKeys.neverUsed")}
                      {" · "}
                      {!key.expires_at
                        ? t("apiKeys.never")
                        : isExpired
                          ? t("apiKeys.expired")
                          : t("apiKeys.expires", { date: new Date(key.expires_at).toLocaleString() })}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                    onClick={() => handleRevoke(key)}
                  >
                    {t("apiKeys.revoke")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
