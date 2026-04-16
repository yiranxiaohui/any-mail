import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getEmail, deleteEmail, type Email } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ProviderBadge from "@/components/ProviderBadge";
import { toast } from "sonner";

export default function EmailDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [email, setEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getEmail(id)
      .then(setEmail)
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!id || !confirm(t("email.deleteConfirm"))) return;
    await deleteEmail(id);
    toast.success(t("email.deleted"));
    navigate("/");
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

  if (!email) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p className="text-sm font-medium">{t("email.notFound")}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/")}>
          {t("email.backToInbox")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t("email.back")}
        </Button>
        <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/compose?to=${encodeURIComponent(email.from_address)}&from=${encodeURIComponent(email.to_address)}&subject=${encodeURIComponent(`Re: ${email.subject}`)}`)}
        >
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
          {t("email.reply")}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
          {t("email.delete")}
        </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl font-bold leading-tight">
              {email.subject || t("inbox.noSubject")}
            </h1>
            <ProviderBadge provider={email.provider} />
          </div>
        </CardHeader>

        <Separator />

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-6 py-4 text-sm">
          <span className="text-muted-foreground font-medium">{t("email.from")}</span>
          <span>{email.from_address}</span>
          <span className="text-muted-foreground font-medium">{t("email.to")}</span>
          <span>{email.to_address}</span>
          <span className="text-muted-foreground font-medium">{t("email.date")}</span>
          <span>{new Date(email.received_at).toLocaleString()}</span>
        </div>

        <Separator />

        <CardContent className="pt-4">
          {email.html_body ? (
            <Tabs defaultValue="html">
              <TabsList>
                <TabsTrigger value="html">{t("email.html")}</TabsTrigger>
                <TabsTrigger value="text">{t("email.text")}</TabsTrigger>
              </TabsList>
              <TabsContent value="html" className="mt-4">
                <iframe
                  srcDoc={email.html_body}
                  className="w-full min-h-[400px] rounded-md border"
                  sandbox=""
                  title="Email HTML content"
                />
              </TabsContent>
              <TabsContent value="text" className="mt-4">
                <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans">
                  {email.text_body || t("email.empty")}
                </pre>
              </TabsContent>
            </Tabs>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans">
              {email.text_body || t("email.empty")}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
