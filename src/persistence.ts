import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/**
 * Storage backend for the single store blob.
 * - Vercel KV (Upstash) when KV_REST_API_URL + KV_REST_API_TOKEN are set.
 * - Otherwise a JSON file: ./data locally, or /tmp on Vercel (ephemeral).
 */
const KEY = "igbot:store";

// Supabase (Postgres) — preferred persistent backend.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const TABLE = "app_store";
const ROW_ID = "main";
const EVENTS_TABLE = "dm_events";

let supabase: import("@supabase/supabase-js").SupabaseClient | null = null;
async function sb() {
  if (!supabase) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  }
  return supabase;
}

// Upstash Redis (KV) — alternative persistent backend.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useKv = !useSupabase && !!(KV_URL && KV_TOKEN);

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

export function backendName(): "supabase" | "kv" | "file" {
  return useSupabase ? "supabase" : useKv ? "kv" : "file";
}

let warned = false;
/** Warn once if running on Vercel without KV (data won't persist across cold starts). */
export function warnIfEphemeral(): void {
  if (warned) return;
  warned = true;
  if (process.env.VERCEL && !useSupabase && !useKv) {
    logger.warn(
      "On Vercel with no database: data is stored in /tmp and will NOT persist across " +
        "deployments or cold starts (your Instagram connection will keep dropping). " +
        "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or an Upstash Redis integration).",
    );
  }
}

/** Lightweight check that the active storage backend is reachable. */
export async function storageHealth(): Promise<{ backend: string; ok: boolean; error?: string }> {
  const backend = backendName();
  try {
    if (useSupabase) {
      const { error } = await (await sb()).from(TABLE).select("id").limit(1);
      if (error) return { backend, ok: false, error: error.message };
      return { backend, ok: true };
    }
    if (useKv) {
      await (await kv()).get(KEY);
      return { backend, ok: true };
    }
    return { backend, ok: true };
  } catch (err) {
    return { backend, ok: false, error: (err as Error).message };
  }
}

export async function loadBlob(): Promise<unknown | null> {
  if (useSupabase) {
    try {
      const { data, error } = await (await sb()).from(TABLE).select("data").eq("id", ROW_ID).maybeSingle();
      if (error) {
        logger.error("Supabase read failed", error.message);
        return null;
      }
      return (data as { data?: unknown } | null)?.data ?? null;
    } catch (err) {
      logger.error("Supabase read failed", (err as Error).message);
      return null;
    }
  }
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
  if (useSupabase) {
    const { error } = await (await sb()).from(TABLE).upsert({ id: ROW_ID, data }, { onConflict: "id" });
    if (error) throw new Error(`Supabase write failed: ${error.message}`);
    return;
  }
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

export interface DmEventInput {
  type: string;
  status: "success" | "failed" | "skipped";
  igAccountId?: string;
  recipientId?: string;
  recipientUsername?: string;
  commentId?: string;
  mediaId?: string;
  ruleId?: string;
  ruleName?: string;
  link?: string;
  message?: string;
  error?: string;
}

/** Append an automation event to the dm_events table (best-effort; Supabase only). */
export async function logEvent(e: DmEventInput): Promise<void> {
  if (!useSupabase) return;
  try {
    const { error } = await (await sb()).from(EVENTS_TABLE).insert({
      type: e.type,
      status: e.status,
      ig_account_id: e.igAccountId ?? null,
      recipient_id: e.recipientId ?? null,
      recipient_username: e.recipientUsername ?? null,
      comment_id: e.commentId ?? null,
      media_id: e.mediaId ?? null,
      rule_id: e.ruleId ?? null,
      rule_name: e.ruleName ?? null,
      link: e.link ?? null,
      message: e.message ?? null,
      error: e.error ?? null,
    });
    if (error) logger.warn("Failed to log event", error.message);
  } catch (err) {
    logger.warn("Failed to log event", (err as Error).message);
  }
}

/** Read recent automation events, newest first (Supabase only). */
export async function getEvents(limit = 100): Promise<unknown[]> {
  if (!useSupabase) return [];
  const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
  try {
    const { data, error } = await (await sb())
      .from(EVENTS_TABLE)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(capped);
    if (error) {
      logger.warn("Failed to read events", error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    logger.warn("Failed to read events", (err as Error).message);
    return [];
  }
}

/** Aggregate counts from dm_events for the dashboard overview (Supabase only). */
export async function getEventStats(): Promise<{
  linksDelivered: number;
  sentToday: number;
  failedToday: number;
  total: number;
}> {
  const zero = { linksDelivered: 0, sentToday: 0, failedToday: 0, total: 0 };
  if (!useSupabase) return zero;
  try {
    const client = await sb();
    const today = new Date().toISOString().slice(0, 10);
    const [delivered, sentToday, failedToday, total] = await Promise.all([
      client.from(EVENTS_TABLE).select("*", { count: "exact", head: true }).eq("type", "link_delivered").eq("status", "success"),
      client.from(EVENTS_TABLE).select("*", { count: "exact", head: true }).eq("status", "success").gte("created_at", today),
      client.from(EVENTS_TABLE).select("*", { count: "exact", head: true }).eq("status", "failed").gte("created_at", today),
      client.from(EVENTS_TABLE).select("*", { count: "exact", head: true }),
    ]);
    return {
      linksDelivered: delivered.count ?? 0,
      sentToday: sentToday.count ?? 0,
      failedToday: failedToday.count ?? 0,
      total: total.count ?? 0,
    };
  } catch (err) {
    logger.warn("Event stats failed", (err as Error).message);
    return zero;
  }
}
