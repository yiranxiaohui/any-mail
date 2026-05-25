import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getUserDomains, addUserDomain, deleteUserDomain, apiMe, type UserDomain, type MeResponse } from "@/lib/api";

export default function Domains() {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<UserDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);

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
          <CardTitle className="text-base">{t("domains.listTitle")}</CardTitle>
          <CardDescription>
            {t("domains.listCount", { count: domains.length })}
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
