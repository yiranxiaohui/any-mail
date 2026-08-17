export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_ATTACHMENT_BASE64_BYTES = 40 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

export interface EmailAttachment {
  filename: string;
  content: string;
}

export type AttachmentValidationResult =
  | { ok: true; attachments: EmailAttachment[] }
  | { ok: false; error: string; status: 400 | 413 };

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

export function validateAttachments(input: unknown): AttachmentValidationResult {
  if (input === undefined) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "attachments must be an array", status: 400 };
  }
  if (input.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      error: `attachments cannot contain more than ${MAX_ATTACHMENT_COUNT} files`,
      status: 400,
    };
  }

  const attachments: EmailAttachment[] = [];
  let totalBase64Bytes = 0;

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (typeof value !== "object" || value === null) {
      return { ok: false, error: `attachments[${index}] must be an object`, status: 400 };
    }

    const { filename, content } = value as Record<string, unknown>;
    if (typeof filename !== "string" || !filename.trim()) {
      return { ok: false, error: `attachments[${index}].filename is required`, status: 400 };
    }
    const normalizedFilename = filename.trim();
    if (normalizedFilename.length > MAX_ATTACHMENT_FILENAME_LENGTH) {
      return {
        ok: false,
        error: `attachments[${index}].filename cannot exceed ${MAX_ATTACHMENT_FILENAME_LENGTH} characters`,
        status: 400,
      };
    }
    if (/[\u0000-\u001f\u007f]/.test(normalizedFilename)) {
      return {
        ok: false,
        error: `attachments[${index}].filename contains invalid control characters`,
        status: 400,
      };
    }
    if (typeof content !== "string") {
      return { ok: false, error: `attachments[${index}].content must be a Base64 string`, status: 400 };
    }

    totalBase64Bytes += content.length;
    if (totalBase64Bytes > MAX_ATTACHMENT_BASE64_BYTES) {
      return {
        ok: false,
        error: "attachments exceed the 40 MB Base64-encoded size limit",
        status: 413,
      };
    }
    if (!isBase64(content)) {
      return {
        ok: false,
        error: `attachments[${index}].content must contain valid Base64 without a data URL prefix`,
        status: 400,
      };
    }

    attachments.push({ filename: normalizedFilename, content });
  }

  return { ok: true, attachments };
}
