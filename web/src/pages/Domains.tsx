import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  getUserDomains, addUserDomain, deleteUserDomain, apiMe,
  getDomainMxGuide, checkDomainMx, importDomain, syncDomainsFromCloudflare,
  type UserDomain, type MeResponse, type MxCheckResult, type MxGuide, type AutoEnableStep,
} from "@/lib/api";

export default function Domains() {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<UserDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [importDomainInput, setImportDomainInput] = useState("");
  const [mxGuide, setMxGuide] = useState<MxGuide | null>(null);
  const [mxResult, setMxResult] = useState<MxCheckResult | null>(null);
  const [checkingMx, setCheckingMx] = useState(false);
  const [importingDomain, setImportingDomain] = useState(false);
  const [autoSteps, setAutoSteps] = useState<AutoEnableStep[] | null>(null);
  const [pendingNs, setPendingNs] = useState<{
    domain: string;
    nameservers: string[];
    zone_status?: string;
    zone_created?: boolean;
  } | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [syncingDomains, setSyncingDomains] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [domainsData, meData] = await Promise.all([getUserDomains(), apiMe()]);
      setDomains(domainsData.domains);
      setMe(meData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    getDomainMxGuide().then(setMxGuide).catch(() => {});
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newDomain.trim().toLowerCase();
    if (!name) return;
    setAdding(true);
    try {
      await addUserDomain(name);
      toast.success(t("domains.added", { name }));
      setNewDomain("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("domains.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(t("domains.deleteConfirm", { name }))) return;
    try {
      await deleteUserDomain(name);
      toast.success(t("domains.deleted", { name }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("domains.deleteFailed"));
    }
  };

  const copy = async (text: string, msg?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(msg ?? t("domains.copied"));
    } catch {
      toast.error(t("domains.copyFailed"));
    }
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
    const d = (pendingNs?.domain || importDomainInput).trim().toLowerCase();
    if (!d) return;
    setImportingDomain(true);
    setAutoSteps(null);
    try {
      const res = await importDomain(d, { force, auto_enable: true, create_zone: true });
      if (res.steps) setAutoSteps(res.steps);
      if (res.mx) setMxResult(res.mx);
      if (!res.ok) {
        if (res.error === "pending_ns" || res.pending_ns) {
          setPendingNs({
            domain: res.domain,
            nameservers: res.nameservers ?? [],
            zone_status: res.zone_status,
            zone_created: res.zone_created,
          });
          setImportDomainInput(res.domain);
          toast.message(
            res.zone_created
              ? t("settings.zoneCreatedPendingNs", { domain: res.domain })
              : t("settings.pendingNs", { domain: res.domain })
          );
          return;
        }
        setPendingNs(null);
        toast.error(
          t(`settings.autoEnableErrors.${res.error}`, {
            defaultValue: res.error || t("settings.domainImportFailed"),
          })
        );
        return;
      }
      setPendingNs(null);
      setImportDomainInput("");
      if (res.auto_enabled) {
        toast.success(t("settings.autoEnableOk", { domain: res.domain, worker: res.worker ?? "any-mail" }));
      } else if (res.forced) {
        toast.success(t("settings.domainImportedForced", { domain: res.domain }));
      } else {
        toast.success(t("settings.domainImported", { domain: res.domain }));
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.domainImportFailed");
      if (msg === "mx_not_ready") toast.error(t("settings.mxNotReady"));
      else toast.error(t(`settings.autoEnableErrors.${msg}`, { defaultValue: msg }));
    } finally {
      setImportingDomain(false);
    }
  };

  const handleSyncDomains = async () => {
    setSyncingDomains(true);
    try {
      const res = await syncDomainsFromCloudflare();
      toast.success(t("settings.domainsSynced", { count: res.domains.length }));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.domainsSyncFailed"));
    } finally {
      setSyncingDomains(false);
    }
  };

  const sharedDomain = me?.shared_inbox_domain ?? null;
  const token = me?.user.relay_token ?? null;
  const relayAddr = sharedDomain && token ? `relay-${token}@${sharedDomain}` : null;
  const suffixExample = sharedDomain && token ? `anything-${token}@${sharedDomain}` : null;

  return (
    <div className="space-y-4">
      {/* Shared inbox (works without DNS setup on user's side) */}
      <Card>
        <CardHeader>
          <CardTitle>{t("domains.sharedTitle")}</CardTitle>
          <CardDescription>{t("domains.sharedDescription")}</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          {!sharedDomain ? (
            <p className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-3 text-xs text-muted-foreground">
              {t("domains.sharedNotConfigured")}
            </p>
          ) : (
            <>
              {/* Suffix pattern */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("domains.suffixLabel")}</label>
                <div className="flex gap-2">
                  <Input readOnly value={`*-${token}@${sharedDomain}`} className="font-mono" />
                  <Button type="button" variant="outline" onClick={() => copy(suffixExample!, t("domains.copiedExample"))}>
                    {t("domains.copyExample")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("domains.suffixHint", { example: suffixExample })}</p>
              </div>

              {/* Relay forward */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("domains.relayLabel")}</label>
                <div className="flex gap-2">
                  <Input readOnly value={relayAddr!} className="font-mono" />
                  <Button type="button" variant="outline" onClick={() => copy(relayAddr!)}>
                    {t("domains.copy")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("domains.relayHint")}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
                            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(row.exchange)}>
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
                setPendingNs(null);
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
                disabled={importingDomain || !importDomainInput.trim()}
                onClick={() => handleImportDomain(false)}
              >
                {importingDomain
                  ? t("settings.domainImporting")
                  : pendingNs
                    ? t("settings.domainRetryEnable")
                    : t("settings.domainImportBtn")}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("settings.autoEnableHint")}</p>

          {pendingNs && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm space-y-2">
              <p className="font-medium">
                {pendingNs.zone_created
                  ? t("settings.zoneCreatedTitle", { domain: pendingNs.domain })
                  : t("settings.pendingNsTitle", { domain: pendingNs.domain })}
              </p>
              <p className="text-xs text-muted-foreground">{t("settings.pendingNsHint")}</p>
              {pendingNs.zone_status && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.zoneStatus", { status: pendingNs.zone_status })}
                </p>
              )}
              {pendingNs.nameservers.length > 0 ? (
                <ul className="space-y-1 font-mono text-xs">
                  {pendingNs.nameservers.map((ns) => (
                    <li key={ns} className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
                      <span>{ns}</span>
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(ns)}>
                        {t("settings.copy")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.nameserversEmpty")}</p>
              )}
              <p className="text-xs text-muted-foreground">{t("settings.pendingNsRetry")}</p>
            </div>
          )}

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

      {/* Custom domains (user's own zones) */}
      <Card>
        <CardHeader>
          <CardTitle>{t("domains.title")}</CardTitle>
          <CardDescription>{t("domains.description")}</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          <form onSubmit={handleAdd} className="flex gap-2">
            <Input
              placeholder={t("domains.placeholder")}
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={adding || !newDomain.trim()}>
              {adding ? t("domains.adding") : t("domains.add")}
            </Button>
          </form>

          <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <div className="mb-1 font-semibold text-foreground">{t("domains.setupTitle")}</div>
            <ol className="list-decimal space-y-1 pl-4">
              <li>{t("domains.setupStep1")}</li>
              <li>{t("domains.setupStep2")}</li>
              <li>{t("domains.setupStep3")}</li>
            </ol>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t("domains.listTitle")}</CardTitle>
              <CardDescription>
                {t("domains.listCount", { count: domains.length })}
              </CardDescription>
            </div>
            {me?.user.role === "admin" && (
              <Button variant="outline" size="sm" disabled={syncingDomains} onClick={handleSyncDomains}>
                {syncingDomains ? t("settings.domainsSyncing") : t("settings.domainsSyncBtn")}
              </Button>
            )}
          </div>
        </CardHeader>
        <Separator />
        {loading ? (
          <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("inbox.loading")}
          </CardContent>
        ) : domains.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <p className="text-sm font-medium">{t("domains.empty")}</p>
            <p className="mt-1 text-xs">{t("domains.emptyHint")}</p>
          </CardContent>
        ) : (
          <div className="divide-y">
            {domains.map((d) => (
              <div key={d.domain_name} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="font-mono text-sm">{d.domain_name}</div>
                  <div className="text-xs text-muted-foreground">{t("domains.addedAt", { date: new Date(d.created_at).toLocaleDateString() })}</div>
                </div>
                <Button variant="destructive" size="sm" onClick={() => handleDelete(d.domain_name)}>
                  {t("domains.delete")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
