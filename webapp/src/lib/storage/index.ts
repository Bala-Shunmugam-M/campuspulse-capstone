import { join } from "node:path";
import type { StorageDriver } from "@/lib/storage/driver";
import { LocalStorageDriver } from "@/lib/storage/local";

let driver: StorageDriver | null = null;

/**
 * Chosen from the environment, never from the request. Phase 2 ships the local
 * driver; the Supabase Storage driver slots in here behind the same interface.
 */
export function storage(): StorageDriver {
  if (!driver) {
    const root = process.env.EVIDENCE_DIR ?? join(process.cwd(), ".evidence");
    driver = new LocalStorageDriver(root);
  }
  return driver;
}

/**
 * Serverless hosts (Vercel) keep no local disk between requests, so the local
 * driver would accept a file and lose it. EVIDENCE_UPLOADS=off refuses uploads
 * there instead; existing evidence rows still list.
 */
export function evidenceUploadsEnabled(): boolean {
  return process.env.EVIDENCE_UPLOADS !== "off";
}

export type { StorageDriver };
