export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_ATTACHMENT_BASE64_BYTES = 40 * 1024 * 1024;

export class AttachmentReadError extends Error {
  constructor() {
    super("Failed to read attachment");
    this.name = "AttachmentReadError";
  }
}

export function getBase64EncodedSize(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

export function getTotalBase64EncodedSize(files: File[]): number {
  return files.reduce((total, file) => total + getBase64EncodedSize(file.size), 0);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AttachmentReadError());
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new AttachmentReadError());
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex === -1) {
        reject(new AttachmentReadError());
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
