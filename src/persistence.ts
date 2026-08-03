import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/**
 * Storage backend for the single store blob.
 * - Vercel KV (Upstash) when KV_REST_API_URL + KV_REST_API_TOKEN are set.
 * - Otherwise a JSON file: ./data locally, or /tmp on Vercel (ephemeral).
 */
const KEY = "igbot:store";
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useKv = !!(KV_URL && KV_TOKEN);

let redis: import("@upstash/redis").Redis | null = null;
async function kv() {
  if (!redis) {
    const { Redis } = await import("@upstash/redis");
    redis = new Redis({ url: KV_URL, token: KV_TOKEN });
  }
  return redis;
}

function fileDir(): string {
  const explicit = process.env.DATA_DIR;
  if (explicit) return path.resolve(process.cwd(), explicit);
  if (process.env.VERCEL) return path.join("/tmp", "igbot-data");
  return path.resolve(process.cwd(), "data");
}
function filePath(): string {
  return path.join(fileDir(), "store.json");
}

export function backendName(): "kv" | "file" {
  return useKv ? "kv" : "file";
}

let warned = false;
/** Warn once if running on Vercel without KV (data won't persist across cold starts). */
export function warnIfEphemeral(): void {
  if (warned) return;
  warned = true;
  if (process.env.VERCEL && !useKv) {
    logger.warn(
      "On Vercel without Vercel KV: data is stored in /tmp and will NOT persist across " +
        "deployments or cold starts. Add a Vercel KV (Upstash) integration for production.",
    );
  }
}

export async function loadBlob(): Promise<unknown | null> {
  if (useKv) {
    try {
      return (await (await kv()).get(KEY)) ?? null;
    } catch (err) {
      logger.error("KV read failed", (err as Error).message);
      return null;
    }
  }
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Could not read store, starting fresh", (err as Error).message);
    }
    return null;
  }
}

export async function saveBlob(data: unknown): Promise<void> {
  if (useKv) {
    await (await kv()).set(KEY, data);
    return;
  }
  const dir = fileDir();
  await fs.mkdir(dir, { recursive: true });
  const file = filePath();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}
