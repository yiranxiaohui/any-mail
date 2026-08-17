import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { sendEmail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { loadDraft, saveDraft, clearDraft } from "@/lib/composeDraft";
import {
  AttachmentReadError,
  MAX_ATTACHMENT_BASE64_BYTES,
  MAX_ATTACHMENT_COUNT,
  fileToBase64,
  formatFileSize,
  getTotalBase64EncodedSize,
} from "@/lib/emailAttachments";

export default function Compose() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const hasParams =
    searchParams.has("from") || searchParams.has("to") || searchParams.has("subject");
  const [initialDraft] = useState(() => (hasParams ? null : loadDraft()));

  const [from, setFrom] = useState(searchParams.get("from") || initialDraft?.from || "");
  const [to, setTo] = useState(searchParams.get("to") || initialDraft?.to || "");
  const [subject, setSubject] = useState(
    searchParams.get("subject") || initialDraft?.subject || ""
  );
  const [body, setBody] = useState(initialDraft?.body || "");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initialDraft?.savedAt || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const skipFirstSave = useRef(true);
  useEffect(() => {
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const saved = saveDraft({ from, to, subject, body });
      setSavedAt(saved ? saved.savedAt : null);
    }, 800);
    return () => clearTimeout(timer);
  }, [from, to, subject, body]);

  const handleSaveDraft = () => {
    const saved = saveDraft({ from, to, subject, body });
    if (saved) {
      setSavedAt(saved.savedAt);
      toast.success(t("compose.draftSaved"));
    }
  };

  const handleSelectAttachments = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!selectedFiles.length) return;

    const nextAttachments = [...attachments, ...selectedFiles];
    if (nextAttachments.length > MAX_ATTACHMENT_COUNT) {
      toast.error(t("compose.tooManyAttachments", { count: MAX_ATTACHMENT_COUNT }));
      return;
    }

    const encodedSize = getTotalBase64EncodedSize(nextAttachments);
    if (encodedSize > MAX_ATTACHMENT_BASE64_BYTES) {
      toast.error(t("compose.attachmentsTooLarge", { size: formatFileSize(encodedSize) }));
      return;
    }

    setAttachments(nextAttachments);
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleSend = async () => {
    if (!from || !to || !subject) {
      toast.error(t("compose.required"));
      return;
    }
    setSending(true);
    try {
      const encodedAttachments = await Promise.all(
        attachments.map(async (file) => ({
          filename: file.name,
          content: await fileToBase64(file),
        }))
      );
      await sendEmail({
        from,
        to,
        subject,
        text: body,
        attachments: encodedAttachments.length ? encodedAttachments : undefined,
      });
      clearDraft();
      toast.success(t("compose.sent"));
      navigate("/console?box=sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      toast.error(err instanceof AttachmentReadError
        ? t("compose.attachmentReadFailed")
        : message || t("compose.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t("email.back")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("compose.title")}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("compose.from")}</label>
            <Input
              type="email"
              placeholder={t("compose.fromPlaceholder")}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("compose.to")}</label>
            <Input
              type="email"
              placeholder={t("compose.toPlaceholder")}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("compose.subject")}</label>
            <Input
              placeholder={t("compose.subjectPlaceholder")}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("compose.body")}</label>
            <textarea
              className="flex min-h-[200px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={t("compose.bodyPlaceholder")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium">{t("compose.attachments")}</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                {t("compose.addAttachment")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleSelectAttachments}
                disabled={sending}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("compose.attachmentsHint", { count: MAX_ATTACHMENT_COUNT })}
            </p>
            {attachments.length > 0 && (
              <div className="space-y-2 rounded-lg border border-input p-2">
                {attachments.map((file, index) => (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                    className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2"
                  >
                    <svg className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>{file.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeAttachment(index)}
                      disabled={sending}
                      aria-label={t("compose.removeAttachment", { name: file.name })}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </Button>
                  </div>
                ))}
                <p className="px-1 text-right text-xs text-muted-foreground">
                  {t("compose.attachmentSummary", {
                    count: attachments.length,
                    size: formatFileSize(attachments.reduce((total, file) => total + file.size, 0)),
                  })}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-3">
            {savedAt && (
              <span className="text-xs text-muted-foreground">
                {t("compose.autoSaved", {
                  time: new Date(savedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            )}
            <Button variant="outline" onClick={handleSaveDraft} disabled={sending}>
              {t("compose.saveDraft")}
            </Button>
            <Button onClick={handleSend} disabled={sending}>
              {sending ? (
                <>
                  <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  {t("compose.sending")}
                </>
              ) : (
                <>
                  <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m22 2-7 20-4-9-9-4z" />
                    <path d="m22 2-11 11" />
                  </svg>
                  {t("compose.send")}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
