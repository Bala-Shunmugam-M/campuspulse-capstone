import { createHash, randomBytes } from "node:crypto";

export class RejectedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectedUploadError";
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * An allowlist of signatures, not a blocklist of dangerous ones. A blocklist has
 * to enumerate every hostile format and is wrong the moment a new one appears;
 * this refuses anything it does not positively recognise, which is the posture
 * evidence handling wants.
 */
const SIGNATURES: { mime: string; ext: string[]; magic: number[] }[] = [
  { mime: "image/png", ext: [".png"], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", ext: [".jpg", ".jpeg"], magic: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", ext: [".gif"], magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", ext: [".pdf"], magic: [0x25, 0x50, 0x44, 0x46] },
];

const TEXT_EXT = [".txt", ".md", ".csv", ".log"];

export type InspectedUpload = {
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** Random. Never derived from the filename, which is attacker-controlled. */
  storageKey: string;
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function looksLikeText(bytes: Buffer): boolean {
  // No NULs, and valid UTF-8. Re-encoding a lossy decode changes length, which
  // is how an invalid sequence is detected without a dependency.
  if (bytes.includes(0)) return false;
  const decoded = bytes.toString("utf8");
  return Buffer.byteLength(decoded, "utf8") === bytes.length;
}

/**
 * Decide what a file actually is from its bytes, and refuse it if the bytes and
 * the name disagree or if it is not a permitted kind. The client's declared
 * content type is never consulted: it is the one field an attacker fully
 * controls and the one most often trusted.
 */
export function inspectUpload(bytes: Buffer, originalFilename: string): InspectedUpload {
  if (bytes.length === 0) throw new RejectedUploadError("That file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new RejectedUploadError(
      `Files must be ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`,
    );
  }

  const ext = extensionOf(originalFilename);

  const matched = SIGNATURES.find((s) =>
    s.magic.every((byte, i) => bytes[i] === byte),
  );

  let mimeType: string;
  if (matched) {
    // The name must agree with the content. A .exe carrying PNG bytes is still
    // refused, because the name is what a careless viewer will act on.
    if (!matched.ext.includes(ext)) {
      throw new RejectedUploadError(
        `That file's contents are ${matched.mime} but its name ends in "${ext || "nothing"}".`,
      );
    }
    mimeType = matched.mime;
  } else if (TEXT_EXT.includes(ext) && looksLikeText(bytes)) {
    mimeType = "text/plain";
  } else {
    throw new RejectedUploadError(
      "Only PNG, JPEG, GIF, PDF and plain text files can be attached.",
    );
  }

  return {
    mimeType,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageKey: `${randomBytes(16).toString("hex")}`,
  };
}
