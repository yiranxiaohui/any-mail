import { useEffect, useState } from "react";
import { getAccounts, deleteAccount, gmailAuthUrl, outlookAuthUrl, type Account } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import ProviderBadge from "@/components/ProviderBadge";
import { toast } from "sonner";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const data = await getAccounts();
      setAccounts(data.accounts);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  const handleDelete = async (id: string, email: string) => {
    if (!confirm(`Delete account ${email} and all its emails?`)) return;
    await deleteAccount(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    toast.success(`Removed ${email}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Manage your connected email accounts
        </p>
      </div>

      {/* Add Account */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect a new account</CardTitle>
          <CardDescription>
            Link your Gmail or Outlook account to start receiving emails
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <a
              href={gmailAuthUrl}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-[#ea4335] text-white hover:bg-[#d33426] transition-colors"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Connect Gmail
            </a>
            <a
              href={outlookAuthUrl}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-[#0078d4] text-white hover:bg-[#006abc] transition-colors"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 7.387v10.478c0 .23-.08.424-.238.576-.16.154-.352.232-.578.232h-8.15v-6.455l1.675 1.23a.261.261 0 0 0 .317-.002l6.974-5.067V7.387z" />
                <path d="M15.034 11.262v-5.34c0-.233.08-.43.24-.587.16-.16.354-.238.58-.238h1.235l6.556 4.752-8.61 6.252V11.26z" />
                <path d="M7 18c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6zm0-9.5c-1.9 0-3.5 1.6-3.5 3.5S5.1 15.5 7 15.5s3.5-1.6 3.5-3.5S8.9 8.5 7 8.5z" />
              </svg>
              Connect Outlook
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Account List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected accounts</CardTitle>
          <CardDescription>
            {accounts.length} account(s) connected
          </CardDescription>
        </CardHeader>
        <Separator />
        {loading ? (
          <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Loading...
          </CardContent>
        ) : accounts.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" x2="19" y1="8" y2="14" />
              <line x1="22" x2="16" y1="11" y2="11" />
            </svg>
            <p className="text-sm font-medium">No accounts connected</p>
            <p className="text-xs mt-1">Connect Gmail or Outlook above to get started</p>
          </CardContent>
        ) : (
          <div className="divide-y">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                    <ProviderIcon provider={account.provider} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{account.email}</span>
                      <ProviderBadge provider={account.provider} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Connected {new Date(account.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => handleDelete(account.id, account.email)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
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
