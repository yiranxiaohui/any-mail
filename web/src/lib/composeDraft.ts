const DRAFT_KEY = "anymail_compose_draft";

export interface ComposeDraft {
  from: string;
  to: string;
  subject: string;
  body: string;
  savedAt: string;
}

export function loadDraft(): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (typeof d !== "object" || d === null) return null;
    return {
      from: typeof d.from === "string" ? d.from : "",
      to: typeof d.to === "string" ? d.to : "",
      subject: typeof d.subject === "string" ? d.subject : "",
      body: typeof d.body === "string" ? d.body : "",
      savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(d: Omit<ComposeDraft, "savedAt">): ComposeDraft | null {
  const empty =
    !d.from.trim() && !d.to.trim() && !d.subject.trim() && !d.body.trim();
  try {
    if (empty) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    const full: ComposeDraft = { ...d, savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(full));
    return full;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}
