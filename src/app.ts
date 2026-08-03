import crypto from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { logger } from "./logger";
import { webhookRouter } from "./instagram/webhook";
import { oauthRouter, createOAuthState } from "./instagram/oauth";
import * as client from "./instagram/client";
import { getAccount, setAccount, getAutomation, setAutomation, getStats, normalizeRule } from "./store";
import { queueLength } from "./sender";
import { runMaintenance } from "./jobs";
import { AutomationConfig } from "./types";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Build the Express app. Used by both the local server and the Vercel function. */
export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Capture the raw body so the webhook route can validate Meta's HMAC signature.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  // Endpoints that must work even when the server is misconfigured.
  app.get("/favicon.ico", (_req, res) => res.status(204).end());
  app.get("/health", (_req, res) =>
    res.json({ ok: config.missingEnv.length === 0, missingEnv: config.missingEnv }),
  );

  // If required env vars are missing, return a clear 503 instead of crashing.
  app.use((_req, res, next) => {
    if (config.missingEnv.length > 0) {
      res.status(503).json({
        error: "Server is missing required environment variables",
        missingEnv: config.missingEnv,
        hint: "Add these in Vercel → Project → Settings → Environment Variables, then redeploy.",
      });
      return;
    }
    next();
  });

  // Public routes (called by Meta / Instagram).
  app.use("/", webhookRouter);
  app.use("/", oauthRouter);

  // Vercel Cron target (guarded by CRON_SECRET when set): token refresh + cleanup.
  app.get("/api/cron", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && (req.header("authorization") || "") !== `Bearer ${secret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await runMaintenance();
    res.json({ ok: true });
  });

  // Every /api route below requires the admin bearer token.
  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, config.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }

  const api = express.Router();
  api.use(requireAdmin);

  api.get("/status", async (_req, res) => {
    const account = await getAccount();
    const automation = await getAutomation();
    const stats = await getStats();
    const webhookUrl = config.publicBaseUrl ? `${config.publicBaseUrl}/webhook` : "(set PUBLIC_BASE_URL)";
    const callbackUrl = config.publicBaseUrl ? `${config.publicBaseUrl}/auth/callback` : config.instagram.redirectUri;
    res.json({
      connected: !!account,
      account: account
        ? { igId: account.igId, username: account.username, expiresAt: account.expiresAt, connectedAt: account.connectedAt }
        : null,
      automation,
      stats: { ...stats, queueLength: queueLength() },
      webhookUrl,
      callbackUrl,
      verifyToken: config.webhook.verifyToken,
      subscribedFields: config.webhook.fields,
    });
  });

  api.get("/connect", (_req, res) => {
    const state = createOAuthState();
    res.json({ url: client.buildAuthorizeUrl(state) });
  });

  api.post("/disconnect", async (_req, res) => {
    await setAccount(null);
    res.json({ ok: true });
  });

  api.post("/subscribe", async (_req, res) => {
    const account = await getAccount();
    if (!account) {
      res.status(400).json({ error: "No account connected" });
      return;
    }
    try {
      const result = await client.subscribeApps(account.accessToken, config.webhook.fields);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  api.get("/media", async (_req, res) => {
    const account = await getAccount();
    if (!account) {
      res.status(400).json({ error: "No account connected" });
      return;
    }
    try {
      const media = await client.getMedia(account.accessToken, 30);
      res.json({ media });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  api.post("/config", async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const patch: Partial<AutomationConfig> = {};

    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (Array.isArray(b.rules)) patch.rules = b.rules.slice(0, 100).map(normalizeRule);

    // Follow-gate
    if (typeof b.requireFollow === "boolean") patch.requireFollow = b.requireFollow;
    if (typeof b.inviteText === "string") patch.inviteText = b.inviteText.slice(0, 900);
    if (typeof b.followNudgeText === "string") patch.followNudgeText = b.followNudgeText.slice(0, 500);

    // Anti-spam / rate limiting
    if (typeof b.onlyOncePerUser === "boolean") patch.onlyOncePerUser = b.onlyOncePerUser;
    if (typeof b.rateLimitPerMinute === "number" && Number.isFinite(b.rateLimitPerMinute)) {
      patch.rateLimitPerMinute = clampInt(b.rateLimitPerMinute, 1, 120);
    }
    if (typeof b.dailyCap === "number" && Number.isFinite(b.dailyCap)) {
      patch.dailyCap = clampInt(b.dailyCap, 0, 10000);
    }
    if (typeof b.minDelaySeconds === "number" && Number.isFinite(b.minDelaySeconds)) {
      patch.minDelaySeconds = clampInt(b.minDelaySeconds, 0, 60);
    }
    if (typeof b.maxDelaySeconds === "number" && Number.isFinite(b.maxDelaySeconds)) {
      patch.maxDelaySeconds = clampInt(b.maxDelaySeconds, 0, 120);
    }

    const automation = await setAutomation(patch);
    res.json({ automation });
  });

  app.use("/api", api);

  // Dashboard (static). Served after routes so it never shadows them.
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Surface the real error instead of an opaque 500.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled request error", err.message);
    res.status(500).json({ error: err.message || "Internal error" });
  });

  return app;
}
