import { logger } from "./logger";
import { getAutomation, consumeDailyQuota } from "./store";

export interface SendTask {
  /** Human-readable label for logs. */
  label: string;
  /** The actual API call. */
  run: () => Promise<void>;
  /** Whether this send counts against the daily cap (link/invite DMs do; public replies don't). */
  countsTowardCap: boolean;
}

const queue: SendTask[] = [];
const recentSends: number[] = []; // timestamps within the last 60s
let running = false;
const IS_SERVERLESS = !!process.env.VERCEL;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomDelayMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(0, minSeconds);
  const max = Math.max(min, maxSeconds);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

async function respectRateLimit(perMinute: number): Promise<void> {
  const limit = Math.max(1, perMinute);
  // Drop timestamps older than 60s.
  const now = Date.now();
  while (recentSends.length && now - recentSends[0] > 60_000) recentSends.shift();
  if (recentSends.length >= limit) {
    const waitMs = 60_000 - (now - recentSends[0]) + 50;
    logger.debug(`Rate limit (${limit}/min) reached — waiting ${waitMs}ms`);
    await sleep(waitMs);
    return respectRateLimit(perMinute);
  }
}

async function worker(): Promise<void> {
  running = true;
  try {
    while (queue.length > 0) {
      const task = queue.shift() as SendTask;
      const automation = await getAutomation();

      if (task.countsTowardCap) {
        const allowed = await consumeDailyQuota(Math.max(0, automation.dailyCap));
        if (!allowed) {
          logger.warn(`Daily cap (${automation.dailyCap}) reached — skipping send: ${task.label}`);
          continue;
        }
      }

      // On serverless we can't smooth across invocations (and long delays risk the
      // function timing out), so rely on the daily cap + dedupe instead of pacing.
      if (!IS_SERVERLESS) {
        await respectRateLimit(automation.rateLimitPerMinute);
        const delay = randomDelayMs(automation.minDelaySeconds, automation.maxDelaySeconds);
        if (delay > 0) await sleep(delay);
      }

      try {
        await task.run();
        recentSends.push(Date.now());
      } catch (err) {
        logger.error(`Send task failed: ${task.label}`, (err as Error).message);
      }
    }
  } finally {
    running = false;
  }
}

/** Queue an outbound send. All Instagram sends go through here so limits apply globally. */
export function enqueueSend(task: SendTask): void {
  queue.push(task);
  if (!running) void worker();
}

export function queueLength(): number {
  return queue.length;
}

/** Wait until the queue has fully drained (used on serverless before responding). */
export async function flushSends(): Promise<void> {
  if (!running) void worker();
  while (running || queue.length > 0) {
    await sleep(50);
  }
}
