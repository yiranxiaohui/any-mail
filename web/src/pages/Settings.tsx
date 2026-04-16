import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSettings, updateSettings, syncDomainsFromCloudflare } from "@/lib/api";
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

  useEffect(() => {
    getSettings()
      .then((res) => {
        const ex: Record<string, { masked: string; updated_at: string }> = {};
        for (const [k, v] of Object.entries(res.settings)) {
          ex[k] = { masked: v.masked, updated_at: v.updated_at };
        }
        setExisting(ex);
        // 加载已启用的域名
        const domainStr = res.settings.EMAIL_DOMAINS?.value || "";
        const domains = domainStr.split(",").map((d: string) => d.trim()).filter(Boolean);
        setEnabledDomains(domains);
        setAllDomains(domains);
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

  const toggleDomain = (domain: string) => {
    setEnabledDomains((prev) =>
      prev.includes(domain) ? prev.filter((d) => d !== domain) : [...prev, domain]
    );
  };

  const removeDomain = (domain: string) => {
    setAllDomains((prev) => prev.filter((d) => d !== domain));
    setEnabledDomains((prev) => prev.filter((d) => d !== domain));
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

      {/* Domain Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
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
