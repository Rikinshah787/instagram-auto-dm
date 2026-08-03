import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { setAccount } from "../store";
import { Account } from "../types";
import * as client from "./client";

/**
 * Short-lived OAuth "state" values for CSRF protection. Kept in memory: a state
 * is created when the dashboard requests a connect URL and consumed once at the
 * callback. Values expire after 10 minutes.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthState(): string {
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

export function consumeOAuthState(state: string): boolean {
  const expiry = pendingStates.get(state);
  if (expiry === undefined) return false;
  pendingStates.delete(state);
  return expiry > Date.now();
}

// Occasionally drop expired states so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingStates) {
    if (expiry <= now) pendingStates.delete(state);
  }
}, STATE_TTL_MS).unref();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}.card{background:#1e293b;padding:2rem;border-radius:12px;max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}a{color:#818cf8}</style></head><body><div class="card">${body}</div></body></html>`;
}

export const oauthRouter = Router();

// Instagram redirects the user back here with ?code=...&state=...
oauthRouter.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (error) {
    logger.warn("OAuth returned an error", { error, error_description });
    return res
      .status(400)
      .send(page("Login failed", `<h2>Login failed</h2><p>${error_description || error}</p><p><a href="/">Back</a></p>`));
  }
  if (!code) {
    return res.status(400).send(page("Missing code", `<h2>Missing code</h2><p><a href="/">Back</a></p>`));
  }
  if (!state || !consumeOAuthState(state)) {
    logger.warn("OAuth state validation failed (possible CSRF or expired link)");
    return res
      .status(400)
      .send(page("Invalid state", `<h2>Invalid or expired link</h2><p>Please start the connection again.</p><p><a href="/">Back</a></p>`));
  }

  try {
    // Instagram sometimes appends "#_" to the code in the redirect.
    const cleanCode = code.replace(/#_$/, "");
    const short = await client.exchangeCodeForToken(cleanCode);
    const long = await client.getLongLivedToken(short.access_token);

    let username = "";
    let igId = String(short.user_id);
    try {
      const profile = await client.getProfile(long.access_token);
      username = profile.username || "";
      igId = String(profile.user_id || short.user_id);
    } catch (err) {
      client.logApiError("Could not fetch profile after connect", err);
    }

    const account: Account = {
      igId,
      username,
      accessToken: long.access_token,
      tokenType: long.token_type || "bearer",
      expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null,
      connectedAt: Date.now(),
    };
    await setAccount(account);
    logger.info(`Connected Instagram account @${username || igId}`);

    // Enable webhook events for this account so comments start flowing in.
    try {
      await client.subscribeApps(long.access_token, config.webhook.fields);
      logger.info(`Subscribed account to webhook fields: ${config.webhook.fields}`);
    } catch (err) {
      client.logApiError("Auto-subscribe failed (retry from dashboard)", err);
    }

    return res.redirect("/?connected=1");
  } catch (err) {
    client.logApiError("OAuth callback failed", err);
    return res
      .status(500)
      .send(page("Connection failed", `<h2>Connection failed</h2><p>Check the server logs for details.</p><p><a href="/">Back</a></p>`));
  }
});
