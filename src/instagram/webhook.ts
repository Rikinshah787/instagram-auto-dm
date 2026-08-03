import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { handleCommentChange, handleMessagingEvent } from "../automation/engine";
import { flushSends } from "../sender";

export const webhookRouter = Router();

/** Constant-time string compare that won't throw on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Validate Meta's X-Hub-Signature-256 header against the raw request body. */
function verifySignature(raw: Buffer, header: string, secret: string): boolean {
  if (!header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(header, expected);
}

// GET /webhook — Meta's verification handshake.
webhookRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && typeof token === "string" && safeEqual(token, config.webhook.verifyToken)) {
    logger.info("Webhook verified by Meta");
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }
  logger.warn("Webhook verification failed (bad mode or verify token)");
  return res.sendStatus(403);
});

// POST /webhook — event notifications.
webhookRouter.post("/webhook", async (req, res) => {
  if (!config.webhook.skipSignatureCheck) {
    const signature = req.header("x-hub-signature-256") || "";
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifySignature(raw, signature, config.instagram.appSecret)) {
      logger.warn("Rejected webhook with invalid or missing signature");
      return res.sendStatus(401);
    }
  }

  const body = req.body;

  // On serverless, all work must finish before responding or it may be dropped.
  if (process.env.VERCEL) {
    try {
      await processEvent(body);
      await flushSends();
    } catch (err) {
      logger.error("Error processing webhook event", (err as Error).message);
    }
    return res.sendStatus(200);
  }

  // Persistent server: acknowledge immediately, then process in the background.
  res.sendStatus(200);
  setImmediate(() => {
    processEvent(body).catch((err) => logger.error("Error processing webhook event", (err as Error).message));
  });
});

async function processEvent(body: any): Promise<void> {
  if (!body || body.object !== "instagram" || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) {
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        if (change?.field === "comments" && change.value) {
          await handleCommentChange(change.value);
        }
      }
    }
    // Direct messages — the follow-gate uses these (a reply to our invite).
    if (Array.isArray(entry.messaging)) {
      for (const event of entry.messaging) {
        await handleMessagingEvent(event);
      }
    }
  }
}
