import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { loadBlob, saveBlob, warnIfEphemeral } from "./persistence";
import { Account, AutomationConfig, PendingFollow, Rule, StoreShape } from "./types";

const MAX_PROCESSED = 5000;
const MAX_DELIVERED = 200000;

const INVITE_TEXT =
  "Hey! Thanks for commenting 🙌 Reply to this message and I'll send your link.\n" +
  "(Make sure you're following me so it can go through!)";
const NUDGE_TEXT =
  "Almost there! Please follow me first, then reply here again and I'll send your link 🙏";

function makeDefaultRule(): Rule {
  return {
    id: randomUUID(),
    enabled: true,
    name: "All posts (default)",
    mediaId: "",
    matchMode: "keywords",
    keywords: ["link", "info", "guide", "send", "want", "yes"],
    link: "",
    dmText:
      "Here's the link you asked for 👇\n\n" +
      "(You're getting this because you commented on my post.)",
    publicReplyEnabled: true,
    publicReplyText: "Just sent it to your DMs 📩",
  };
}

function defaults(): AutomationConfig {
  return {
    enabled: true,
    rules: [makeDefaultRule()],
    requireFollow: true,
    inviteText: INVITE_TEXT,
    followNudgeText: NUDGE_TEXT,
    onlyOncePerUser: true,
    rateLimitPerMinute: 20,
    dailyCap: 500,
    minDelaySeconds: 1,
    maxDelaySeconds: 4,
  };
}

/** Coerce an untrusted rule (from storage or the API) into a valid Rule. */
export function normalizeRule(r: any): Rule {
  return {
    id: typeof r?.id === "string" && r.id ? r.id : randomUUID(),
    enabled: r?.enabled !== false,
    name: typeof r?.name === "string" ? r.name.slice(0, 80) : "",
    mediaId: typeof r?.mediaId === "string" ? r.mediaId.trim().slice(0, 64) : "",
    matchMode: r?.matchMode === "any" ? "any" : "keywords",
    keywords: Array.isArray(r?.keywords)
      ? r.keywords.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 50)
      : [],
    link: typeof r?.link === "string" ? r.link.trim().slice(0, 500) : "",
    dmText: typeof r?.dmText === "string" ? r.dmText.slice(0, 900) : "",
    publicReplyEnabled: r?.publicReplyEnabled !== false,
    publicReplyText: typeof r?.publicReplyText === "string" ? r.publicReplyText.slice(0, 250) : "",
  };
}

/** Merge stored/partial automation with defaults, migrating the old flat schema to rules[]. */
function migrateAutomation(parsed: any): AutomationConfig {
  const base = defaults();
  if (!parsed || typeof parsed !== "object") return base;

  const merged: AutomationConfig = {
    enabled: parsed.enabled ?? base.enabled,
    rules: base.rules,
    requireFollow: parsed.requireFollow ?? base.requireFollow,
    inviteText: typeof parsed.inviteText === "string" ? parsed.inviteText : base.inviteText,
    followNudgeText: typeof parsed.followNudgeText === "string" ? parsed.followNudgeText : base.followNudgeText,
    onlyOncePerUser: parsed.onlyOncePerUser ?? base.onlyOncePerUser,
    rateLimitPerMinute: parsed.rateLimitPerMinute ?? base.rateLimitPerMinute,
    dailyCap: parsed.dailyCap ?? base.dailyCap,
    minDelaySeconds: parsed.minDelaySeconds ?? base.minDelaySeconds,
    maxDelaySeconds: parsed.maxDelaySeconds ?? base.maxDelaySeconds,
  };

  if (Array.isArray(parsed.rules) && parsed.rules.length) {
    merged.rules = parsed.rules.map(normalizeRule);
  } else if ("keywords" in parsed || "dmText" in parsed || "link" in parsed) {
    // Legacy flat config -> a single "all posts" rule.
    merged.rules = [
      normalizeRule({
        name: "All posts (default)",
        mediaId:
          Array.isArray(parsed.mediaFilter) && parsed.mediaFilter.length === 1 ? parsed.mediaFilter[0] : "",
        matchMode: parsed.matchMode,
        keywords: parsed.keywords,
        link: parsed.link,
        dmText: parsed.dmText,
        publicReplyEnabled: parsed.publicReplyEnabled,
        publicReplyText: parsed.publicReplyText,
      }),
    ];
  }
  if (!merged.rules.length) merged.rules = [makeDefaultRule()];
  return merged;
}

/** In-memory state uses Sets/Map for O(1) lookups at scale; persisted as plain JSON. */
interface State {
  account: Account | null;
  automation: AutomationConfig;
  processedComments: Set<string>;
  deliveredUsers: Set<string>;
  pending: Map<string, PendingFollow>;
  dayKey: string;
  dayCount: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

let cache: State | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function actualPersist(): Promise<void> {
  if (!cache) return;
  const data: StoreShape = {
    account: cache.account,
    automation: cache.automation,
    processedComments: [...cache.processedComments],
    deliveredUsers: [...cache.deliveredUsers],
    pending: Object.fromEntries(cache.pending),
    dayKey: cache.dayKey,
    dayCount: cache.dayCount,
  };
  await saveBlob(data);
}

/** Serialize writes so concurrent webhooks can't interleave/corrupt the file. */
function persist(): Promise<void> {
  writeChain = writeChain.then(actualPersist).catch((err) => {
    logger.error("Failed to persist store", (err as Error).message);
  });
  return writeChain;
}

async function load(): Promise<State> {
  if (cache) return cache;
  warnIfEphemeral();
  const parsed = (await loadBlob()) as Partial<StoreShape> | null;
  if (parsed) {
    cache = {
      account: parsed.account ?? null,
      automation: migrateAutomation(parsed.automation),
      processedComments: new Set(parsed.processedComments ?? []),
      deliveredUsers: new Set(parsed.deliveredUsers ?? []),
      pending: new Map(Object.entries(parsed.pending ?? {})),
      dayKey: parsed.dayKey ?? todayKey(),
      dayCount: parsed.dayCount ?? 0,
    };
  } else {
    cache = {
      account: null,
      automation: defaults(),
      processedComments: new Set(),
      deliveredUsers: new Set(),
      pending: new Map(),
      dayKey: todayKey(),
      dayCount: 0,
    };
    await persist();
  }
  return cache;
}

export async function getAccount(): Promise<Account | null> {
  return (await load()).account;
}

export async function setAccount(account: Account | null): Promise<void> {
  const store = await load();
  store.account = account;
  await persist();
}

export async function getAutomation(): Promise<AutomationConfig> {
  return (await load()).automation;
}

export async function setAutomation(patch: Partial<AutomationConfig>): Promise<AutomationConfig> {
  const store = await load();
  store.automation = { ...store.automation, ...patch };
  await persist();
  return store.automation;
}

// ── Comment dedupe (webhook retries) ──────────────────────────────────────
export async function isProcessed(commentId: string): Promise<boolean> {
  return (await load()).processedComments.has(commentId);
}

export async function markProcessed(commentId: string): Promise<void> {
  const store = await load();
  if (store.processedComments.has(commentId)) return;
  store.processedComments.add(commentId);
  if (store.processedComments.size > MAX_PROCESSED) {
    const excess = store.processedComments.size - MAX_PROCESSED;
    const it = store.processedComments.values();
    for (let i = 0; i < excess; i++) store.processedComments.delete(it.next().value as string);
  }
  await persist();
}

// ── Once-per-user delivery tracking ───────────────────────────────────────
export async function hasDelivered(igsid: string): Promise<boolean> {
  return (await load()).deliveredUsers.has(igsid);
}

export async function markDelivered(igsid: string): Promise<void> {
  const store = await load();
  if (store.deliveredUsers.has(igsid)) return;
  store.deliveredUsers.add(igsid);
  if (store.deliveredUsers.size > MAX_DELIVERED) {
    const it = store.deliveredUsers.values();
    store.deliveredUsers.delete(it.next().value as string);
  }
  await persist();
}

export async function unmarkDelivered(igsid: string): Promise<void> {
  const store = await load();
  if (store.deliveredUsers.delete(igsid)) await persist();
}

// ── Pending follow-gate state ─────────────────────────────────────────────
export async function getPending(igsid: string): Promise<PendingFollow | undefined> {
  return (await load()).pending.get(igsid);
}

export async function setPending(igsid: string, value: PendingFollow): Promise<void> {
  const store = await load();
  store.pending.set(igsid, value);
  await persist();
}

export async function deletePending(igsid: string): Promise<void> {
  const store = await load();
  if (store.pending.delete(igsid)) await persist();
}

/** Drop pending entries older than maxAgeMs (comment private-reply window is 7 days). */
export async function cleanupPending(maxAgeMs: number): Promise<void> {
  const store = await load();
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [igsid, info] of store.pending) {
    if (info.createdAt < cutoff) {
      store.pending.delete(igsid);
      changed = true;
    }
  }
  if (changed) await persist();
}

// ── Daily cap ─────────────────────────────────────────────────────────────
/**
 * Atomically reserve one slot against today's cap. Rolls the day over at UTC
 * midnight. Returns false if the cap (when > 0) is already reached.
 */
export async function consumeDailyQuota(cap: number): Promise<boolean> {
  const store = await load();
  const key = todayKey();
  if (store.dayKey !== key) {
    store.dayKey = key;
    store.dayCount = 0;
  }
  if (cap > 0 && store.dayCount >= cap) {
    await persist();
    return false;
  }
  store.dayCount += 1;
  await persist();
  return true;
}

export async function getStats(): Promise<{
  deliveredCount: number;
  pendingCount: number;
  dayKey: string;
  dayCount: number;
}> {
  const store = await load();
  return {
    deliveredCount: store.deliveredUsers.size,
    pendingCount: store.pending.size,
    dayKey: store.dayKey,
    dayCount: store.dayCount,
  };
}
