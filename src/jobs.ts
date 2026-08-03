import * as client from "./instagram/client";
import { config } from "./config";
import { getAccount, setAccount, cleanupPending } from "./store";
import { logger } from "./logger";

const REFRESH_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Refresh the long-lived token when it's within 10 days of expiring. */
export async function refreshTokenIfNeeded(): Promise<void> {
  const account = await getAccount();
  if (!account || !account.expiresAt) return;
  if (account.expiresAt - Date.now() > REFRESH_THRESHOLD_MS) return;
  try {
    const refreshed = await client.refreshLongLivedToken(account.accessToken);
    account.accessToken = refreshed.access_token;
    account.expiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : account.expiresAt;
    await setAccount(account);
    logger.info("Refreshed long-lived access token");
  } catch (err) {
    client.logApiError("Token refresh failed", err);
  }
}

/** Re-confirm the account's webhook subscription (it can lapse on Meta's side). */
export async function ensureSubscribed(): Promise<void> {
  const account = await getAccount();
  if (!account) return;
  try {
    await client.subscribeApps(account.accessToken, config.webhook.fields);
    logger.debug("Webhook subscription confirmed");
  } catch (err) {
    client.logApiError("Auto re-subscribe failed", err);
  }
}

/** Periodic maintenance run by local timers and the Vercel cron route. */
export async function runMaintenance(): Promise<void> {
  await refreshTokenIfNeeded();
  await ensureSubscribed();
  await cleanupPending(PENDING_MAX_AGE_MS);
}
