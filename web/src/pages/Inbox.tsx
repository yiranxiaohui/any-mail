import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getEmails, getAccounts, triggerSync, type Email, type Account } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ProviderBadge from "@/components/ProviderBadge";
import { toast } from "sonner";

export default function Inbox() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [filterAccount, setFilterAccount] = useState("all");
  const [searchTo, setSearchTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchEmails = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterAccount !== "all") params.account_id = filterAccount;
      if (searchTo) params.to = searchTo;
      const data = await getEmails(params);
      setEmails(data.emails);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getAccounts().then((d) => setAccounts(d.accounts));
  }, []);

  useEffect(() => {
    fetchEmails();
  }, [filterAccount]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await triggerSync();
      const total = res.results.reduce((s, r) => s + r.synced, 0);
      toast.success(`Synced ${total} new email(s)`);
      await fetchEmails();
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchEmails();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            {emails.length} email(s)
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
          {syncing ? "Syncing..." : "Sync"}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select value={filterAccount} onValueChange={(v) => setFilterAccount(v ?? "all")}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="All Accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Accounts</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <form onSubmit={handleSearch} className="flex flex-1 gap-2">
          <Input
            placeholder="Search by recipient..."
            value={searchTo}
            onChange={(e) => setSearchTo(e.target.value)}
            className="max-w-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </div>

      {/* Email List */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Loading...
        </div>
      ) : emails.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
            <p className="text-sm font-medium">No emails yet</p>
            <p className="text-xs mt-1">Emails will appear here once received</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y">
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
                      {email.subject || "(no subject)"}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                    {formatDate(email.received_at)}
                  </span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span className="truncate">From: {email.from_address}</span>
                  <span className="truncate">To: {email.to_address}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {(email.text_body || "").slice(0, 140)}
                </p>
              </Link>
            ))}
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
