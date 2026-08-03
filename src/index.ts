import { config } from "./config";
import { logger } from "./logger";
import { createApp } from "./app";
import { refreshTokenIfNeeded } from "./jobs";
import { cleanupPending } from "./store";

// Local / always-on server entry (Render, Railway, a VPS, etc.).
// The Vercel serverless entry lives in api/index.ts.
const app = createApp();

app.listen(config.port, () => {
  logger.info(`Server listening on http://localhost:${config.port}`);
  if (!config.publicBaseUrl) {
    logger.warn("PUBLIC_BASE_URL is not set — the dashboard can't show your public webhook/callback URLs.");
  }
});

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PENDING_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

setInterval(() => void refreshTokenIfNeeded(), REFRESH_INTERVAL_MS).unref();
void refreshTokenIfNeeded();
setInterval(() => void cleanupPending(PENDING_MAX_AGE_MS), PENDING_CLEANUP_INTERVAL_MS).unref();
