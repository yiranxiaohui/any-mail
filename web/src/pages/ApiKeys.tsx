import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getApiKeys, createApiKey, updateApiKey, deleteApiKey, rotateApiKey, type ApiKey } from "@/lib/api";
import { Activity, Check, Clock3, Copy, KeyRound, Pencil, Plus, RotateCw, ShieldCheck, Trash2 } from "lucide-react";

const ALL_SCOPES = ["emails:read", "emails:send", "emails:delete", "accounts:read", "accounts:write", "domains:read", "keys:create"] as const;

// i18next uses ':' as namespace separator, so scope keys are stored with '_' in JSON.
const scopeLabelKey = (scope: string) => `apiKeys.scopeLabels.${scope === "*" ? "all" : scope.replace(":", "_")}`;

type DialogMode = { kind: "create" } | { kind: "edit"; id: string };

export default function ApiKeys() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<DialogMode | null>(null);
  const [saving, setSaving] = useState(false);

  // form
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["emails:read"]);
  const [provider, setProvider] = useState<string>("");
  const [address, setAddress] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  // plaintext reveal (create & rotate)
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
    setAddress("");
    setExpiresAt("");
  };

  const openCreate = () => {
    resetForm();
    setMode({ kind: "create" });
  };

  const openEdit = (key: ApiKey) => {
    setName(key.name);
    setScopes(key.scopes.split(",").filter(Boolean));
    setProvider(key.provider ?? "");
    setAddress(key.address ?? "");
    setExpiresAt(key.expires_at ? key.expires_at.slice(0, 16) : "");
    setMode({ kind: "edit", id: key.id });
  };

  const closeDialog = () => {
    setMode(null);
    resetForm();
  };

  const toggleScope = (s: string) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const handleSave = async () => {
    if (!mode || !name.trim() || scopes.length === 0) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        scopes,
        provider: provider || null,
        address: address.trim() || null,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      };
      if (mode.kind === "create") {
        const res = await createApiKey(payload);
        toast.success(t("apiKeys.created", { name: res.key.name }));
        setMode(null);
        setPlaintext({ key: res.plaintext, name: res.key.name });
        resetForm();
      } else {
        await updateApiKey(mode.id, payload);
        toast.success(t("apiKeys.updated", { name: payload.name }));
        closeDialog();
      }
      fetchKeys();
    } catch (err) {
      const fallback = mode.kind === "create" ? t("apiKeys.createFailed") : t("apiKeys.updateFailed");
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (key: ApiKey) => {
    if (!confirm(t("apiKeys.revokeConfirm", { name: key.name }))) return;
    await deleteApiKey(key.id);
    setKeys((prev) => prev.filter((k) => k.id !== key.id));
    toast.success(t("apiKeys.revoked", { name: key.name }));
  };

  const handleRotate = async (key: ApiKey) => {
    if (!confirm(t("apiKeys.rotateConfirm", { name: key.name }))) return;
    try {
      const res = await rotateApiKey(key.id);
      setPlaintext({ key: res.plaintext, name: key.name });
      toast.success(t("apiKeys.rotated", { name: key.name }));
      fetchKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("apiKeys.rotateFailed"));
    }
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

  const isEdit = mode?.kind === "edit";
  const now = Date.now();
  const activeCount = keys.filter((key) => !key.expires_at || new Date(key.expires_at).getTime() > now).length;
  const usedCount = keys.filter((key) => !!key.last_used_at).length;
  const expiringCount = keys.filter((key) => {
    if (!key.expires_at) return false;
    const expiresAtMs = new Date(key.expires_at).getTime();
    return expiresAtMs > now && expiresAtMs < now + 30 * 24 * 60 * 60 * 1000;
  }).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <KeyRound className="size-5" strokeWidth={2.1} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">{t("apiKeys.title")}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t("apiKeys.description")}</p>
          </div>
        </div>
        <Button onClick={openCreate} className="self-start shadow-sm">
          <Plus className="size-4" />
          {t("apiKeys.create")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard icon={<ShieldCheck className="size-4" />} label={t("apiKeys.statsActive")} value={activeCount} tone="green" />
        <SummaryCard icon={<Activity className="size-4" />} label={t("apiKeys.statsUsed")} value={usedCount} tone="blue" />
        <SummaryCard icon={<Clock3 className="size-4" />} label={t("apiKeys.statsExpiring")} value={expiringCount} tone="amber" />
      </div>

      <Dialog open={!!mode} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? t("apiKeys.editTitle") : t("apiKeys.create")}</DialogTitle>
            <DialogDescription>
              {isEdit ? t("apiKeys.editDescription") : t("apiKeys.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("apiKeys.name")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.namePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("apiKeys.scopes")}</label>
              <div className="flex flex-wrap gap-2">
                {ALL_SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScope(s)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      scopes.includes(s)
                        ? "border-primary bg-primary text-primary-foreground shadow-sm"
                        : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {scopes.includes(s) && <Check className="size-3.5" />}
                    {t(scopeLabelKey(s))}
                  </button>
                ))}
              </div>
              {scopes.includes("keys:create") && (
                <p className="text-xs text-muted-foreground">{t("apiKeys.keysCreateHint")}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("apiKeys.provider")}</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/50"
              >
                <option value="">{t("apiKeys.providerAll")}</option>
                <option value="domain">{t("apiKeys.providerDomain")}</option>
                <option value="gmail">{t("apiKeys.providerGmail")}</option>
                <option value="outlook">{t("apiKeys.providerOutlook")}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("apiKeys.address")}</label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t("apiKeys.addressPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.addressHint")}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("apiKeys.expiresAt")}</label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.expiresHint")}</p>
            </div>
            <Button
              className="w-full"
              onClick={handleSave}
              disabled={saving || !name.trim() || scopes.length === 0}
            >
              {saving ? t("settings.saving") : isEdit ? t("settings.save") : t("apiKeys.create")}
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
            <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
              {t("apiKeys.plaintextWarning")}
            </div>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 rounded-lg border bg-muted px-3 py-2.5 text-xs font-mono leading-5 break-all">
                {plaintext?.key}
              </code>
              <Button variant="outline" onClick={() => plaintext && copyToClipboard(plaintext.key)} aria-label={t("apiKeys.copy")} title={t("apiKeys.copy")}>
                <Copy className="size-4" />
                {t("apiKeys.copy")}
              </Button>
            </div>
            <Button className="w-full" onClick={() => setPlaintext(null)}>
              {t("apiKeys.plaintextDone")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card className="min-h-0 flex-1">
        <CardHeader className="shrink-0 gap-3 px-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t("apiKeys.title")}</CardTitle>
              <CardDescription className="mt-1">{t("apiKeys.keysCount", { count: keys.length })}</CardDescription>
            </div>
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <KeyRound className="size-4" />
            </div>
          </div>
        </CardHeader>
        <Separator />
        {loading ? (
          <CardContent className="flex items-center justify-center py-16 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("inbox.loading")}
          </CardContent>
        ) : keys.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-muted">
              <KeyRound className="size-6 opacity-50" />
            </div>
            <p className="text-sm font-medium text-foreground">{t("apiKeys.empty")}</p>
            <p className="mt-1 max-w-xs text-xs leading-5">{t("apiKeys.emptyHint")}</p>
          </CardContent>
        ) : (
          <div className="app-scrollbar divide-y md:min-h-0 md:flex-1 md:overflow-y-auto">
            {keys.map((key) => {
              const scopesList = key.scopes.split(",").filter(Boolean);
              const isExpired = Boolean(key.expires_at && new Date(key.expires_at).getTime() <= now);
              return (
                <div key={key.id} className="group flex flex-col gap-4 px-4 py-5 transition-colors hover:bg-muted/35 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <KeyRound className="size-4" />
                    </div>
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{key.name}</span>
                        <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {key.key_prefix}…
                        </code>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${isExpired ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
                          <span className={`size-1.5 rounded-full ${isExpired ? "bg-destructive" : "bg-emerald-500"}`} />
                          {isExpired ? t("apiKeys.expired") : t("apiKeys.active")}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="rounded-md bg-muted px-2 py-1">{providerLabel(key.provider)}</span>
                        {key.address && <span className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono">→ {key.address}</span>}
                        {key.created_by_key_id && (
                          <span className="rounded-md bg-muted px-2 py-1">
                            {key.created_by_prefix ? t("apiKeys.createdByKey", { prefix: key.created_by_prefix }) : t("apiKeys.createdByDeletedKey")}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {scopesList.map((s) => (
                          <span key={s} className="rounded-md border border-primary/15 bg-primary/5 px-2 py-1 text-[11px] font-medium text-accent-foreground">
                            {t(scopeLabelKey(s), { defaultValue: s })}
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-x-2 text-xs leading-5 text-muted-foreground">
                        <span>{t("apiKeys.createdAt", { date: new Date(key.created_at).toLocaleString() })}</span>
                        <span aria-hidden="true">·</span>
                        <span>{key.last_used_at ? t("apiKeys.lastUsed", { date: new Date(key.last_used_at).toLocaleString() }) : t("apiKeys.neverUsed")}</span>
                        <span aria-hidden="true">·</span>
                        <span>{!key.expires_at ? t("apiKeys.never") : isExpired ? t("apiKeys.expired") : t("apiKeys.expires", { date: new Date(key.expires_at).toLocaleString() })}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(key)} aria-label={t("apiKeys.edit")} title={t("apiKeys.edit")}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleRotate(key)} aria-label={t("apiKeys.rotate")} title={t("apiKeys.rotate")}>
                      <RotateCw className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => handleRevoke(key)} aria-label={t("apiKeys.revoke")} title={t("apiKeys.revoke")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "green" | "blue" | "amber";
}) {
  const toneClasses = {
    green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    blue: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    amber: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5 shadow-sm">
      <div className={`flex size-9 items-center justify-center rounded-lg ${toneClasses[tone]}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold tracking-tight">{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
