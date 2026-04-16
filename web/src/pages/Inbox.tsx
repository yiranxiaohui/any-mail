import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getEmails, getAccounts, triggerSync, type Email, type Account } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import ProviderBadge from "@/components/ProviderBadge";
import { toast } from "sonner";

export default function Inbox() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [emails, setEmails] = useState<Email[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [filterAccount, setFilterAccount] = useState(searchParams.get("account_id") || "all");
  const [filterProvider, setFilterProvider] = useState("");
  const [searchTo, setSearchTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  const fetchEmails = async (p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: ps, offset: (p - 1) * ps };
      if (filterAccount !== "all") params.account_id = filterAccount;
      if (filterProvider) params.provider = filterProvider;
      if (searchTo) params.to = searchTo;
      const data = await getEmails(params as Record<string, string>);
      setEmails(data.emails);
      setTotal(data.meta.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getAccounts({ limit: 100 }).then((d) => setAccounts(d.accounts));
  }, []);

  useEffect(() => {
    fetchEmails(page, pageSize);
  }, [filterAccount, filterProvider, page, pageSize]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await triggerSync();
      const syncTotal = res.results.reduce((s, r) => s + r.synced, 0);
      toast.success(t("inbox.syncResult", { count: syncTotal }));
      await fetchEmails(page, pageSize);
    } catch {
      toast.error(t("inbox.syncFailed"));
    } finally {
      setSyncing(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchEmails(1, pageSize);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] gap-6">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("inbox.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("inbox.emailCount", { count: total })}
          </p>
        </div>
        <Button onClick={handleSync} disabled={syncing} size="sm">
          {syncing ? (
            <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
          )}
          {syncing ? t("inbox.syncing") : t("inbox.sync")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 shrink-0">
        <select
          value={filterProvider}
          onChange={(e) => { setFilterProvider(e.target.value); setPage(1); }}
          className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="">{t("accounts.allTypes")}</option>
          <option value="domain">{t("accounts.typeDomain")}</option>
          <option value="gmail">Gmail</option>
          <option value="outlook">Outlook</option>
          <option value="resend">Resend</option>
        </select>
        <Select value={filterAccount} onValueChange={(v) => { setFilterAccount(v ?? "all"); setPage(1); }}>
          <SelectTrigger className="w-[260px]">
            <span className="truncate">
              {filterAccount === "all"
                ? t("inbox.allAccounts")
                : accounts.find((a) => a.id === filterAccount)?.email ?? filterAccount}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("inbox.allAccounts")}</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <form onSubmit={handleSearch} className="flex flex-1 gap-2">
          <Input
            placeholder={t("inbox.searchPlaceholder")}
            value={searchTo}
            onChange={(e) => setSearchTo(e.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            {t("inbox.search")}
          </Button>
        </form>
      </div>

      {/* Email List */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          {t("inbox.loading")}
        </div>
      ) : emails.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
            <p className="text-sm font-medium">{t("inbox.noEmails")}</p>
            <p className="text-xs mt-1">{t("inbox.noEmailsHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="flex flex-col min-h-0 flex-1">
          <div className="divide-y overflow-y-auto flex-1 min-h-0">
            {emails.map((email) => (
              <Link
                to={`/emails/${email.id}`}
                key={email.id}
                className="flex flex-col gap-1.5 px-5 py-4 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ProviderBadge provider={email.provider} />
                    <span className="text-sm font-semibold truncate">
                      {email.subject || t("inbox.noSubject")}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                    {formatDate(email.received_at)}
                  </span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span className="truncate">{t("email.from")}: {email.from_address}</span>
                  <span className="truncate">{t("email.to")}: {email.to_address}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {(email.text_body || "").slice(0, 140)}
                </p>
              </Link>
            ))}
          </div>
          <Separator />
          <div className="flex items-center justify-between px-5 py-3 shrink-0">
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
      )}
    </div>
  );
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
