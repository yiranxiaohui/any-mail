import { describe, expect, test } from "bun:test";
import {
  MAX_ATTACHMENT_BASE64_BYTES,
  MAX_ATTACHMENT_COUNT,
  validateAttachments,
} from "../src/email-attachments";

describe("validateAttachments", () => {
  test("accepts an omitted attachment list", () => {
    expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
  });

  test("accepts valid Base64 attachments and trims filenames", () => {
    expect(validateAttachments([
      { filename: " report.txt ", content: "aGVsbG8=" },
      { filename: "empty.txt", content: "" },
    ])).toEqual({
      ok: true,
      attachments: [
        { filename: "report.txt", content: "aGVsbG8=" },
        { filename: "empty.txt", content: "" },
      ],
    });
  });

  test("rejects malformed attachment input", () => {
    expect(validateAttachments({})).toMatchObject({ ok: false, status: 400 });
    expect(validateAttachments([null])).toMatchObject({ ok: false, status: 400 });
    expect(validateAttachments([{ filename: "", content: "" }])).toMatchObject({ ok: false, status: 400 });
    expect(validateAttachments([{ filename: "bad\nname.txt", content: "" }])).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects invalid Base64 and data URL prefixes", () => {
    expect(validateAttachments([{ filename: "a.txt", content: "not base64" }])).toMatchObject({ ok: false, status: 400 });
    expect(validateAttachments([{ filename: "a.txt", content: "data:text/plain;base64,YQ==" }])).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects too many files", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) => ({
      filename: `${index}.txt`,
      content: "",
    }));
    expect(validateAttachments(attachments)).toMatchObject({ ok: false, status: 400 });
  });

  test("rejects attachments over the encoded size limit", () => {
    const content = "A".repeat(MAX_ATTACHMENT_BASE64_BYTES + 4);
    expect(validateAttachments([{ filename: "large.bin", content }])).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});
