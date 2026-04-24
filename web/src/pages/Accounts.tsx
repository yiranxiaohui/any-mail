import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAccounts, getAccount, getEmails, deleteAccount, updateAccount, createDomainAccount, importAccounts, syncAccount, reauthAccount, getDomains, getAccountTags, bulkTagAccounts, gmailAuthUrl, outlookAuthUrl, type Account, type Email } from "@/lib/api";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ProviderBadge from "@/components/ProviderBadge";
import { toast } from "sonner";

export default function Accounts() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Inbox dialog
  const [inboxAccount, setInboxAccount] = useState<Account | null>(null);
  const [inboxEmails, setInboxEmails] = useState<Email[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [domains, setDomains] = useState<{ name: string }[]>([]);
  const [expiry, setExpiry] = useState("permanent");
  const [creating, setCreating] = useState(false);

  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  // Search, Filter & Pagination
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterProvider, setFilterProvider] = useState("");
  // "" = all, "__untagged__" = 未分组, 其它 = 具体 tag
  const [filterTag, setFilterTag] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  // Tags
  const [tagStats, setTagStats] = useState<{ tag: string | null; count: number }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagValue, setBulkTagValue] = useState("");

  // Edit
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editClientId, setEditClientId] = useState("");
  const [editRefreshToken, setEditRefreshToken] = useState("");
  const [editExpiry, setEditExpiry] = useState("");
  const [editTag, setEditTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [reauthing, setReauthing] = useState(false);

  const fetchAccounts = async (s = debouncedSearch, prov = filterProvider, tag = filterTag, p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const data = await getAccounts({
        search: s || undefined,
        provider: prov || undefined,
        tag: tag || undefined,
        limit: ps,
        offset: (p - 1) * ps,
      });
      setAccounts(data.accounts);
      setTotal(data.meta.total);
    } finally {
      setLoading(false);
    }
  };

  const fetchTags = async () => {
    try {
      const data = await getAccountTags();
      setTagStats(data.tags);
    } catch {
      // silent
    }
  };

  // Handle reauth redirect
  useEffect(() => {
    const reauth = searchParams.get("reauth");
    if (reauth === "success") {
      const email = searchParams.get("email");
      toast.success(t("accounts.reauthSuccess", { email: email || "" }));
      setSearchParams({});
    } else if (reauth === "error") {
      const message = searchParams.get("message");
      toast.error(message || t("accounts.reauthFailed"));
      setSearchParams({});
    }
  }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    fetchAccounts(debouncedSearch, filterProvider, filterTag, page, pageSize);
    setSelectedIds(new Set());
  }, [debouncedSearch, filterProvider, filterTag, page, pageSize]);

  useEffect(() => {
    fetchTags();
  }, []);

  const getExpiresAt = (): string | null => {
    if (expiry === "permanent") return null;
    const now = new Date();
    now.setHours(now.getHours() + parseInt(expiry));
    return now.toISOString();
  };

  const handleCreateDomain = async () => {
    if (!newEmail.trim()) return;
    // 如果有域名列表，组合 prefix@domain；否则要求完整邮箱
    let email = newEmail.trim();
    if (domains.length > 0 && selectedDomain) {
      email = `${email}@${selectedDomain}`;
    }
    if (!email.includes("@")) {
      toast.error(t("accounts.domain.invalidEmail"));
      return;
    }
    setCreating(true);
    try {
      const expiresAt = getExpiresAt();
      const res = await createDomainAccount(email, expiresAt);
      setAccounts((prev) => [{ ...res.account, expires_at: expiresAt, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, ...prev]);
      setNewEmail("");
      setExpiry("permanent");
      setDialogOpen(false);
      toast.success(t("accounts.domain.created", { email: res.account.email }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("accounts.domain.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      const res = await importAccounts(importText);
      toast.success(t("accounts.import.importResult", { success: res.success, total: res.total }));
      if (res.success > 0) {
        setImportText("");
        setDialogOpen(false);
        fetchAccounts();
      }
      const failed = res.results.filter((r) => r.status !== "ok");
      if (failed.length > 0) {
        toast.error(failed.map((r) => `${r.email} (${r.status})`).join(", "));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("accounts.import.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string, email: string) => {
    if (!confirm(t("accounts.removeConfirm", { email }))) return;
    await deleteAccount(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    toast.success(t("accounts.removed", { email }));
    fetchTags();
  };

  const openEdit = async (account: Account) => {
    setEditAccount(account);
    setEditEmail(account.email);
    setEditExpiry(account.expires_at ?? "");
    setEditTag(account.tag ?? "");
    setEditPassword("");
    setShowPassword(false);
    setEditClientId("");
    setEditRefreshToken("");
    setEditLoading(true);
    try {
      const detail = await getAccount(account.id);
      setEditPassword((detail as unknown as Record<string, string | null>).password ?? "");
      setEditClientId(detail.client_id ?? "");
      setEditRefreshToken(detail.refresh_token ?? "");
    } finally {
      setEditLoading(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editAccount) return;
    setSaving(true);
    try {
      await updateAccount(editAccount.id, {
        email: editEmail.trim().toLowerCase(),
        password: editPassword || null,
        expires_at: editExpiry || null,
        client_id: editClientId || null,
        refresh_token: editRefreshToken || null,
        tag: editTag.trim() || null,
      });
      toast.success(t("settings.saved"));
      setEditAccount(null);
      fetchAccounts();
      fetchTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleQuickTag = async (id: string, tag: string | null) => {
    try {
      await updateAccount(id, { tag });
      toast.success(tag ? t("accounts.tags.moved", { tag }) : t("accounts.tags.cleared"));
      fetchAccounts();
      fetchTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.saveFailed"));
    }
  };

  const handleBulkTag = async () => {
    if (selectedIds.size === 0) return;
    const tag = bulkTagValue.trim() || null;
    try {
      await bulkTagAccounts(Array.from(selectedIds), tag);
      toast.success(tag ? t("accounts.tags.bulkMoved", { tag, count: selectedIds.size }) : t("accounts.tags.bulkCleared", { count: selectedIds.size }));
      setSelectedIds(new Set());
      setBulkTagValue("");
      fetchAccounts();
      fetchTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.saveFailed"));
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tagList = tagStats.filter((t) => t.tag !== null) as { tag: string; count: number }[];
  const untaggedCount = tagStats.find((t) => t.tag === null)?.count ?? 0;
  const totalAll = tagStats.reduce((acc, t) => acc + t.count, 0);

  const importLineCount = importText.trim() ? importText.trim().split("\n").filter((l) => l.trim()).length : 0;

  const openInbox = async (account: Account) => {
    setInboxAccount(account);
    setInboxEmails([]);
    setInboxLoading(true);
    try {
      const data = await getEmails({ account_id: account.id, limit: 50 });
      setInboxEmails(data.emails);
    } finally {
      setInboxLoading(false);
    }
  };

  const handleSyncInbox = async () => {
    if (!inboxAccount) return;
    setSyncingId(inboxAccount.id);
    try {
      const res = await syncAccount(inboxAccount.id);
      if (res.ok) {
        toast.success(t("accounts.syncResult", { email: inboxAccount.email, count: res.synced }));
        // Refresh inbox
        const data = await getEmails({ account_id: inboxAccount.id, limit: 50 });
        setInboxEmails(data.emails);
      } else {
        toast.error(res.error || t("inbox.syncFailed"));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("inbox.syncFailed"));
    } finally {
      setSyncingId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] gap-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("accounts.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("accounts.description")}</p>
        </div>
        <Button onClick={() => { setDialogOpen(true); getDomains().then((d) => { setDomains(d.domains); if (d.domains.length > 0) setSelectedDomain(d.domains[0].name); }).catch(() => {}); }}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" x2="12" y1="5" y2="19" />
            <line x1="5" x2="19" y1="12" y2="12" />
          </svg>
          {t("accounts.addAccount")}
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("accounts.dialog.title")}</DialogTitle>
            <DialogDescription>{t("accounts.dialog.description")}</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="domain">
            <TabsList className="w-full">
              <TabsTrigger value="domain">{t("accounts.domain.tab")}</TabsTrigger>
              <TabsTrigger value="oauth">{t("accounts.oauth.tab")}</TabsTrigger>
              <TabsTrigger value="import">{t("accounts.import.tab")}</TabsTrigger>
            </TabsList>

            <TabsContent value="domain">
              <div className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">{t("accounts.domain.description")}</p>
                {domains.length > 0 ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("accounts.domain.localPart")}
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateDomain()}
                      className="flex-1"
                    />
                    <span className="flex items-center text-sm text-muted-foreground">@</span>
                    <select
                      value={selectedDomain}
                      onChange={(e) => setSelectedDomain(e.target.value)}
                      className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    >
                      {domains.map((d) => (
                        <option key={d.name} value={d.name}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <Input
                    type="email"
                    placeholder={t("accounts.domain.placeholder")}
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateDomain()}
                  />
                )}
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium shrink-0">{t("accounts.domain.expires")}</label>
                  <select
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="permanent">{t("accounts.domain.permanent")}</option>
                    <option value="1">{t("accounts.domain.1h")}</option>
                    <option value="6">{t("accounts.domain.6h")}</option>
                    <option value="24">{t("accounts.domain.1d")}</option>
                    <option value="72">{t("accounts.domain.3d")}</option>
                    <option value="168">{t("accounts.domain.7d")}</option>
                    <option value="720">{t("accounts.domain.30d")}</option>
                  </select>
                </div>
                <Button className="w-full" onClick={handleCreateDomain} disabled={creating || !newEmail.trim()}>
                  {creating ? t("accounts.domain.creating") : t("accounts.domain.create")}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="oauth">
              <div className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">{t("accounts.oauth.description")}</p>
                <a
                  href={gmailAuthUrl}
                  className="flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium bg-[#ea4335] text-white hover:bg-[#d33426] transition-colors"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                  {t("accounts.oauth.connectGmail")}
                </a>
                <a
                  href={outlookAuthUrl}
                  className="flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium bg-[#0078d4] text-white hover:bg-[#006abc] transition-colors"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 7.387v10.478c0 .23-.08.424-.238.576-.16.154-.352.232-.578.232h-8.15v-6.455l1.675 1.23a.261.261 0 0 0 .317-.002l6.974-5.067V7.387z" />
                    <path d="M15.034 11.262v-5.34c0-.233.08-.43.24-.587.16-.16.354-.238.58-.238h1.235l6.556 4.752-8.61 6.252V11.26z" />
                    <path d="M7 18c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6zm0-9.5c-1.9 0-3.5 1.6-3.5 3.5S5.1 15.5 7 15.5s3.5-1.6 3.5-3.5S8.9 8.5 7 8.5z" />
                  </svg>
                  {t("accounts.oauth.connectOutlook")}
                </a>
              </div>
            </TabsContent>

            <TabsContent value="import">
              <div className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">{t("accounts.import.description")}</p>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono">
                  {t("accounts.import.format")}
                </code>
                <textarea
                  className="flex min-h-[120px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder={t("accounts.import.placeholder")}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <Button className="w-full" onClick={handleImport} disabled={importing || !importText.trim()}>
                  {importing ? t("accounts.import.importing") : importLineCount > 0 ? t("accounts.import.importCount", { count: importLineCount }) : t("accounts.import.import")}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Inbox Dialog */}
      <Dialog open={!!inboxAccount} onOpenChange={(open) => { if (!open) setInboxAccount(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <div className="flex items-center justify-between pr-8">
              <div>
                <DialogTitle>{inboxAccount?.email}</DialogTitle>
                <DialogDescription>{t("accounts.viewInbox")}</DialogDescription>
              </div>
              {inboxAccount?.provider !== "domain" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={syncingId === inboxAccount?.id}
                  onClick={handleSyncInbox}
                >
                  {syncingId === inboxAccount?.id ? t("inbox.syncing") : t("inbox.sync")}
                </Button>
              )}
            </div>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {inboxLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                {t("inbox.loading")}
              </div>
            ) : inboxEmails.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-sm font-medium">{t("inbox.noEmails")}</p>
                <p className="text-xs mt-1">{t("inbox.noEmailsHint")}</p>
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {inboxEmails.map((email) => (
                  <Link
                    to={`/emails/${email.id}`}
                    key={email.id}
                    className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/50 transition-colors"
                    onClick={() => setInboxAccount(null)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium truncate">
                        {email.subject || t("inbox.noSubject")}
                      </span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap ml-3">
                        {new Date(email.received_at).toLocaleString()}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground truncate">
                      {t("email.from")}: {email.from_address}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Account Dialog */}
      <Dialog open={!!editAccount} onOpenChange={(open) => { if (!open) setEditAccount(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounts.editTitle")}</DialogTitle>
            <DialogDescription>{editAccount?.email}</DialogDescription>
          </DialogHeader>
          {editLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              {t("inbox.loading")}
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("accounts.editFields.email")}</label>
                <Input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                />
              </div>
              {editAccount?.provider === "outlook" && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("accounts.editFields.password")}</label>
                    <div className="flex gap-2">
                      <Input
                        type={showPassword ? "text" : "password"}
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                        placeholder={t("accounts.editFields.password")}
                        className="flex-1"
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => setShowPassword(!showPassword)}>
                        {showPassword ? t("accounts.hide") : t("accounts.show")}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("accounts.editFields.clientId")}</label>
                    <Input
                      value={editClientId}
                      onChange={(e) => setEditClientId(e.target.value)}
                      placeholder="Client ID (SSID)"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t("accounts.editFields.refreshToken")}</label>
                    <Input
                      value={editRefreshToken}
                      onChange={(e) => setEditRefreshToken(e.target.value)}
                      placeholder="Refresh Token"
                    />
                  </div>
                  {editAccount && editClientId && editPassword && (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={reauthing}
                      onClick={async () => {
                        setReauthing(true);
                        try {
                          // 先保存当前编辑（确保密码/client_id 已存储）
                          await updateAccount(editAccount.id, {
                            email: editEmail.trim().toLowerCase(),
                            password: editPassword || null,
                            client_id: editClientId || null,
                            refresh_token: editRefreshToken || null,
                          });
                          const res = await reauthAccount(editAccount.id);
                          if (res.ok) {
                            toast.success(t("accounts.reauthSuccess", { email: res.email || "" }));
                            // 刷新令牌
                            const detail = await getAccount(editAccount.id);
                            setEditRefreshToken(detail.refresh_token ?? "");
                          } else {
                            toast.error(res.error || t("accounts.reauthFailed"));
                          }
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : t("accounts.reauthFailed"));
                        } finally {
                          setReauthing(false);
                        }
                      }}
                    >
                      <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                      </svg>
                      {reauthing ? t("accounts.reauthing") : t("accounts.reauthPassword")}
                    </Button>
                  )}
                </>
              )}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("accounts.editFields.tag")}</label>
                <Input
                  value={editTag}
                  onChange={(e) => setEditTag(e.target.value)}
                  placeholder={t("accounts.tags.placeholder")}
                  list="account-tag-suggestions-edit"
                />
                <datalist id="account-tag-suggestions-edit">
                  {tagList.map((tg) => (
                    <option key={tg.tag} value={tg.tag} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">{t("accounts.tags.hint")}</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("accounts.editFields.expiresAt")}</label>
                <Input
                  type="datetime-local"
                  value={editExpiry ? editExpiry.slice(0, 16) : ""}
                  onChange={(e) => setEditExpiry(e.target.value ? new Date(e.target.value).toISOString() : "")}
                />
                <p className="text-xs text-muted-foreground">{t("accounts.editExpiresHint")}</p>
              </div>
              <Button className="w-full" onClick={handleSaveEdit} disabled={saving}>
                {saving ? t("settings.saving") : t("settings.save")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Card className="flex flex-col min-h-0 flex-1">
        <CardHeader className="shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t("accounts.connectedAccounts")}</CardTitle>
              <CardDescription>{t("accounts.accountCount", { count: total })}</CardDescription>
            </div>
            <div className="flex gap-2">
              <select
                value={filterProvider}
                onChange={(e) => { setFilterProvider(e.target.value); setPage(1); }}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">{t("accounts.allTypes")}</option>
                <option value="domain">{t("accounts.typeDomain")}</option>
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook</option>
              </select>
              <Input
                placeholder={t("accounts.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto pt-3">
            <TagChip active={filterTag === ""} onClick={() => { setFilterTag(""); setPage(1); }} label={t("accounts.tags.all")} count={totalAll} />
            {tagList.map((tg) => (
              <TagChip
                key={tg.tag}
                active={filterTag === tg.tag}
                onClick={() => { setFilterTag(tg.tag); setPage(1); }}
                label={tg.tag}
                count={tg.count}
              />
            ))}
            <TagChip
              active={filterTag === "__untagged__"}
              onClick={() => { setFilterTag("__untagged__"); setPage(1); }}
              label={t("accounts.tags.untagged")}
              count={untaggedCount}
            />
          </div>
        </CardHeader>
        <Separator />
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-6 py-2">
            <span className="text-sm text-muted-foreground">
              {t("accounts.tags.selected", { count: selectedIds.size })}
            </span>
            <Input
              value={bulkTagValue}
              onChange={(e) => setBulkTagValue(e.target.value)}
              placeholder={t("accounts.tags.bulkPlaceholder")}
              className="h-8 w-48"
              onKeyDown={(e) => e.key === "Enter" && handleBulkTag()}
              list="account-tag-suggestions"
            />
            <Button size="sm" onClick={handleBulkTag}>
              {t("accounts.tags.apply")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setBulkTagValue(""); handleBulkTag(); }}>
              {t("accounts.tags.clear")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              {t("accounts.tags.deselect")}
            </Button>
            <datalist id="account-tag-suggestions">
              {tagList.map((tg) => (
                <option key={tg.tag} value={tg.tag} />
              ))}
            </datalist>
          </div>
        )}
        {loading ? (
          <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("inbox.loading")}
          </CardContent>
        ) : accounts.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" x2="19" y1="8" y2="14" />
              <line x1="22" x2="16" y1="11" y2="11" />
            </svg>
            <p className="text-sm font-medium">{t("accounts.noAccounts")}</p>
            <p className="text-xs mt-1">{t("accounts.noAccountsHint")}</p>
          </CardContent>
        ) : (
          <div className="divide-y overflow-y-auto flex-1 min-h-0">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary"
                    checked={selectedIds.has(account.id)}
                    onChange={() => toggleSelected(account.id)}
                  />
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                    <ProviderIcon provider={account.provider} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{account.email}</span>
                      <ProviderBadge provider={account.provider} />
                      {account.tag && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {account.tag}
                          <button
                            type="button"
                            className="opacity-60 hover:opacity-100"
                            title={t("accounts.tags.remove")}
                            onClick={() => handleQuickTag(account.id, null)}
                          >
                            ×
                          </button>
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t("accounts.connected", { date: new Date(account.created_at).toLocaleDateString() })}
                      {account.expires_at && (
                        new Date(account.expires_at) < new Date()
                          ? ` · ${t("accounts.expired")}`
                          : ` · ${t("accounts.expires", { date: new Date(account.expires_at).toLocaleString() })}`
                      )}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__new__") {
                        const input = prompt(t("accounts.tags.promptNew"));
                        if (input && input.trim()) handleQuickTag(account.id, input.trim());
                      } else if (v === "__clear__") {
                        handleQuickTag(account.id, null);
                      } else if (v) {
                        handleQuickTag(account.id, v);
                      }
                      e.currentTarget.value = "";
                    }}
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <option value="">{t("accounts.tags.moveTo")}</option>
                    {tagList.filter((tg) => tg.tag !== account.tag).map((tg) => (
                      <option key={tg.tag} value={tg.tag}>{tg.tag}</option>
                    ))}
                    <option value="__new__">{t("accounts.tags.newTag")}</option>
                    {account.tag && <option value="__clear__">{t("accounts.tags.removeTag")}</option>}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openInbox(account)}
                  >
                    {t("accounts.viewInbox")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(account)}
                  >
                    {t("accounts.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(account.id, account.email)}
                  >
                    {t("accounts.remove")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Separator />
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("accounts.perPage")}</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="text-xs text-muted-foreground">
              {t("accounts.pageInfo", { from: (currentPage - 1) * pageSize + 1, to: Math.min(currentPage * pageSize, total), total })}
            </span>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
              {t("accounts.prev")}
            </Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
              {t("accounts.next")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function TagChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      {label}
      <span className={active ? "text-primary-foreground/80" : "text-muted-foreground/60"}>{count}</span>
    </button>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "gmail") {
    return (
      <svg className="h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      </svg>
    );
  }
  if (provider === "outlook") {
    return (
      <svg className="h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 18c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6zm0-9.5c-1.9 0-3.5 1.6-3.5 3.5S5.1 15.5 7 15.5s3.5-1.6 3.5-3.5S8.9 8.5 7 8.5z" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}
