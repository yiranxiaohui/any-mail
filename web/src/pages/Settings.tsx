import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getSettings,
  updateSettings,
  syncDomainsFromCloudflare,
  getDomainMxGuide,
  checkDomainMx,
  importDomain,
  autoEnableDomain,
  type MxCheckResult,
  type MxGuide,
  type AutoEnableStep,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

interface FieldConfig {
  key: string;
  labelKey: string;
  placeholderKey: string;
  sensitive: boolean;
}

const GMAIL_FIELDS: FieldConfig[] = [
  { key: "GMAIL_CLIENT_ID", labelKey: "settings.fields.gmailClientId", placeholderKey: "settings.fields.gmailClientIdPlaceholder", sensitive: false },
  { key: "GMAIL_CLIENT_SECRET", labelKey: "settings.fields.gmailClientSecret", placeholderKey: "settings.fields.gmailClientSecretPlaceholder", sensitive: true },
];


const GENERAL_FIELDS: FieldConfig[] = [
  { key: "ADMIN_PASSWORD", labelKey: "settings.fields.adminPassword", placeholderKey: "settings.fields.adminPasswordPlaceholder", sensitive: true },
  { key: "RESEND_API_KEY", labelKey: "settings.fields.resendApiKey", placeholderKey: "settings.fields.resendApiKeyPlaceholder", sensitive: true },
  { key: "SHARED_INBOX_DOMAIN", labelKey: "settings.fields.sharedInboxDomain", placeholderKey: "settings.fields.sharedInboxDomainPlaceholder", sensitive: false },
];

const CLOUDFLARE_FIELDS: FieldConfig[] = [
  { key: "CLOUDFLARE_API_TOKEN", labelKey: "settings.fields.cfApiToken", placeholderKey: "settings.fields.cfApiTokenPlaceholder", sensitive: true },
  { key: "CLOUDFLARE_ACCOUNT_ID", labelKey: "settings.fields.cfAccountId", placeholderKey: "settings.fields.cfAccountIdPlaceholder", sensitive: false },
  { key: "CLOUDFLARE_EMAIL_WORKER", labelKey: "settings.fields.cfEmailWorker", placeholderKey: "settings.fields.cfEmailWorkerPlaceholder", sensitive: false },
];

export default function Settings() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<Record<string, { masked: string; updated_at: string }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingDomains, setSyncingDomains] = useState(false);
  const [enabledDomains, setEnabledDomains] = useState<string[]>([]);
  const [allDomains, setAllDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [importDomainInput, setImportDomainInput] = useState("");
  const [mxGuide, setMxGuide] = useState<MxGuide | null>(null);
  const [mxResult, setMxResult] = useState<MxCheckResult | null>(null);
  const [checkingMx, setCheckingMx] = useState(false);
  const [importingDomain, setImportingDomain] = useState(false);
  const [autoEnabling, setAutoEnabling] = useState(false);
  const [autoSteps, setAutoSteps] = useState<AutoEnableStep[] | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    Promise.all([getSettings(), getDomainMxGuide().catch(() => null)])
      .then(([res, guide]) => {
        const ex: Record<string, { masked: string; updated_at: string }> = {};
        for (const [k, v] of Object.entries(res.settings)) {
          ex[k] = { masked: v.masked, updated_at: v.updated_at };
        }
        setExisting(ex);
        const domainStr = res.settings.EMAIL_DOMAINS?.value || "";
        const domains = domainStr.split(",").map((d: string) => d.trim()).filter(Boolean);
        setEnabledDomains(domains);
        setAllDomains(domains);
        if (guide) setMxGuide(guide);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSyncDomains = async () => {
    setSyncingDomains(true);
    try {
      const res = await syncDomainsFromCloudflare();
      // 合并：保留已有的，加入新发现的
      const merged = [...new Set([...allDomains, ...res.domains])];
      setAllDomains(merged);
      setEnabledDomains(merged);
      toast.success(t("settings.domainsSynced", { count: res.domains.length }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.domainsSyncFailed"));
    } finally {
      setSyncingDomains(false);
    }
  };

  const handleAddDomain = () => {
    const d = newDomain.trim().toLowerCase();
    if (!d || allDomains.includes(d)) return;
    setAllDomains((prev) => [...prev, d]);
    setEnabledDomains((prev) => [...prev, d]);
    setNewDomain("");
  };

  const handleCheckMx = async () => {
    const d = importDomainInput.trim().toLowerCase();
    if (!d) return;
    setCheckingMx(true);
    setMxResult(null);
    try {
      const res = await checkDomainMx(d);
      setMxResult(res);
      if (res.ok) toast.success(t("settings.mxCheckOk"));
      else toast.error(t(`settings.mxStatus.${res.message}`, { defaultValue: t("settings.mxCheckFail") }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.mxCheckFail"));
    } finally {
      setCheckingMx(false);
    }
  };

  const handleImportDomain = async (force = false) => {
    const d = importDomainInput.trim().toLowerCase();
    if (!d) return;
    setImportingDomain(true);
    try {
      const res = await importDomain(d, force);
      setMxResult(res.mx);
      const merged = [...new Set([...allDomains, ...res.domains])];
      setAllDomains(merged);
      setEnabledDomains(merged);
      setImportDomainInput("");
      toast.success(
        res.forced ? t("settings.domainImportedForced", { domain: res.domain }) : t("settings.domainImported", { domain: res.domain })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.domainImportFailed");
      if (msg === "mx_not_ready") toast.error(t("settings.mxNotReady"));
      else toast.error(msg);
    } finally {
      setImportingDomain(false);
    }
  };

  const handleAutoEnable = async () => {
    const d = importDomainInput.trim().toLowerCase();
    if (!d) return;
    setAutoEnabling(true);
    setAutoSteps(null);
    try {
      const res = await autoEnableDomain(d);
      setAutoSteps(res.steps ?? []);
      if (res.mx) setMxResult(res.mx);
      if (res.domains?.length) {
        const merged = [...new Set([...allDomains, ...res.domains])];
        setAllDomains(merged);
        setEnabledDomains(merged);
      }
      if (res.ok) {
        toast.success(t("settings.autoEnableOk", { domain: res.domain, worker: res.worker ?? "any-mail" }));
      } else {
        toast.error(t(`settings.autoEnableErrors.${res.error}`, { defaultValue: res.error || t("settings.autoEnableFailed") }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.autoEnableFailed");
      toast.error(t(`settings.autoEnableErrors.${msg}`, { defaultValue: msg }));
    } finally {
      setAutoEnabling(false);
    }
  };

  const toggleDomain = (domain: string) => {
    setEnabledDomains((prev) =>
      prev.includes(domain) ? prev.filter((d) => d !== domain) : [...prev, domain]
    );
  };

  const removeDomain = (domain: string) => {
    setAllDomains((prev) => prev.filter((d) => d !== domain));
    setEnabledDomains((prev) => prev.filter((d) => d !== domain));
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("settings.copied"));
    } catch {
      toast.error(t("settings.copyFailed"));
    }
  };

  const handleSave = async () => {
    const changed: Record<string, string> = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.length > 0)
    );
    // 始终保存域名配置
    changed.EMAIL_DOMAINS = enabledDomains.join(",");

    setSaving(true);
    try {
      await updateSettings(changed);
      toast.success(t("settings.saved"));
      const res = await getSettings();
      const ex: Record<string, { masked: string; updated_at: string }> = {};
      for (const [k, v] of Object.entries(res.settings)) {
        ex[k] = { masked: v.masked, updated_at: v.updated_at };
      }
      setExisting(ex);
      setValues({});
    } catch {
      toast.error(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        {t("inbox.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>

      <SettingsSection
        title={t("settings.general")}
        description={t("settings.generalDescription")}
        icon={
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        }
        fields={GENERAL_FIELDS}
        values={values}
        existing={existing}
        onChange={handleChange}
      />

      {/* Domain Import + MX Guide */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <div>
                <CardTitle className="text-base">{t("settings.domainImportTitle")}</CardTitle>
                <CardDescription>{t("settings.domainImportDescription")}</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowGuide((v) => !v)}>
              {showGuide ? t("settings.hideGuide") : t("settings.showGuide")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4 space-y-4">
          {showGuide && mxGuide && (
            <div className="rounded-lg border bg-muted/40 p-4 space-y-3 text-sm">
              <p className="text-muted-foreground">{t("settings.mxGuideIntro")}</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>{t("settings.mxStep1")}</li>
                <li>{t("settings.mxStep2")}</li>
                <li>{t("settings.mxStep3")}</li>
                <li>{t("settings.mxStep4")}</li>
                <li>{t("settings.mxStep5")}</li>
              </ol>
              <div>
                <p className="font-medium mb-2">{t("settings.requiredMx")}</p>
                <div className="overflow-x-auto rounded-md border bg-background">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Priority</th>
                        <th className="px-3 py-2">Value</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {mxGuide.required_mx.map((row) => (
                        <tr key={row.exchange} className="border-b last:border-0">
                          <td className="px-3 py-2 font-mono">{row.type}</td>
                          <td className="px-3 py-2 font-mono">{row.name}</td>
                          <td className="px-3 py-2 font-mono">{row.priority}</td>
                          <td className="px-3 py-2 font-mono">{row.exchange}</td>
                          <td className="px-3 py-2">
                            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copyText(row.exchange)}>
                              {t("settings.copy")}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.mxGuideNote")}</p>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder={t("settings.domainImportPlaceholder")}
              value={importDomainInput}
              onChange={(e) => {
                setImportDomainInput(e.target.value);
                setMxResult(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && handleCheckMx()}
              className="flex-1"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={checkingMx || !importDomainInput.trim()} onClick={handleCheckMx}>
                {checkingMx ? t("settings.mxChecking") : t("settings.mxCheck")}
              </Button>
              <Button
                size="sm"
                disabled={autoEnabling || !importDomainInput.trim()}
                onClick={handleAutoEnable}
              >
                {autoEnabling ? t("settings.autoEnabling") : t("settings.autoEnableBtn")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={importingDomain || !importDomainInput.trim()}
                onClick={() => handleImportDomain(false)}
              >
                {importingDomain ? t("settings.domainImporting") : t("settings.domainImportBtn")}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("settings.autoEnableHint")}</p>

          {autoSteps && autoSteps.length > 0 && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
              <p className="font-medium">{t("settings.autoEnableSteps")}</p>
              <ul className="space-y-0.5 text-xs font-mono">
                {autoSteps.map((s) => (
                  <li key={s.step} className={s.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
                    {s.ok ? "✓" : "✗"} {s.step}{s.detail ? ` — ${s.detail}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mxResult && (
            <div
              className={`rounded-lg border p-3 text-sm space-y-2 ${
                mxResult.ok ? "border-green-500/40 bg-green-500/5" : "border-amber-500/40 bg-amber-500/5"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  {mxResult.domain}{" "}
                  <span className={mxResult.ok ? "text-green-600" : "text-amber-600"}>
                    {mxResult.ok ? t("settings.mxStatusOk") : t("settings.mxStatusFail")}
                  </span>
                </p>
                {!mxResult.ok && (
                  <Button variant="outline" size="sm" disabled={importingDomain} onClick={() => handleImportDomain(true)}>
                    {t("settings.domainImportForce")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(`settings.mxStatus.${mxResult.message}`, { defaultValue: mxResult.message })}
              </p>
              {mxResult.records.length > 0 ? (
                <ul className="font-mono text-xs space-y-0.5">
                  {mxResult.records.map((r) => (
                    <li key={`${r.priority}-${r.exchange}`}>
                      {r.priority} {r.exchange}
                      {mxResult.matched.includes(r.exchange) ? " ✓" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.mxNoRecords")}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Domain Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h16" />
                <path d="M4 12h16" />
                <path d="M4 17h10" />
              </svg>
              <div>
                <CardTitle className="text-base">{t("settings.fields.emailDomains")}</CardTitle>
                <CardDescription>{t("settings.domainsDescription")}</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" disabled={syncingDomains} onClick={handleSyncDomains}>
              {syncingDomains ? t("settings.domainsSyncing") : t("settings.domainsSyncBtn")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4 space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder={t("settings.domainsAddPlaceholder")}
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddDomain()}
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={handleAddDomain} disabled={!newDomain.trim()}>
              {t("settings.domainsAdd")}
            </Button>
          </div>
          {allDomains.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {allDomains.map((domain) => (
                <div
                  key={domain}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm cursor-pointer transition-colors ${
                    enabledDomains.includes(domain)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-input"
                  }`}
                  onClick={() => toggleDomain(domain)}
                >
                  {domain}
                  <button
                    className="ml-1 opacity-60 hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); removeDomain(domain); }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("settings.domainsEmpty")}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("settings.domainsHint", { count: enabledDomains.length })}
          </p>
        </CardContent>
      </Card>

      <SettingsSection
        title={t("settings.cloudflare")}
        description={t("settings.cloudflareDescription")}
        icon={
          <svg className="h-5 w-5 text-orange-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 15.5c.9-1.5 1.1-3.3.4-5-.5-1.3-1.5-2.4-2.8-2.9-.3-1.7-1.4-3.2-2.9-4-1.8-1-4-1-5.8-.1-1.6.8-2.7 2.3-3 4.1C1 8.2 0 9.8 0 11.6c0 2.8 2.2 5 5 5h11c.2 0 .3 0 .5-.1z" />
            <path d="M19.5 11.2c-.3 0-.6 0-.9.1-.4-1.5-1.4-2.7-2.8-3.3.1.4.2.8.2 1.2 0 1.4-.6 2.7-1.6 3.6 1.2.5 2.1 1.5 2.5 2.7H20c1.1 0 2-.9 2-2s-.9-2.3-2.5-2.3z" opacity=".7" />
          </svg>
        }
        fields={CLOUDFLARE_FIELDS}
        values={values}
        existing={existing}
        onChange={handleChange}
      />

      <SettingsSection
        title={t("settings.gmail")}
        description={t("settings.gmailDescription")}
        icon={
          <svg className="h-5 w-5 text-red-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          </svg>
        }
        fields={GMAIL_FIELDS}
        values={values}
        existing={existing}
        onChange={handleChange}
      />

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              {t("settings.saving")}
            </>
          ) : (
            t("settings.save")
          )}
        </Button>
      </div>
    </div>
  );
}

function SettingsSection({
  title,
  description,
  icon,
  fields,
  values,
  existing,
  onChange,
  extraAction,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  fields: FieldConfig[];
  values: Record<string, string>;
  existing: Record<string, { masked: string; updated_at: string }>;
  onChange: (key: string, value: string) => void;
  extraAction?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {icon}
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          {extraAction}
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="pt-4 space-y-4">
        {fields.map((field) => {
          const ex = existing[field.key];
          return (
            <div key={field.key} className="space-y-1.5">
              <label className="text-sm font-medium">{t(field.labelKey)}</label>
              <Input
                type={field.sensitive ? "password" : "text"}
                placeholder={ex ? `Current: ${ex.masked}` : t(field.placeholderKey)}
                value={values[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
              />
              {ex && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.lastUpdated", { date: new Date(ex.updated_at).toLocaleString() })}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
