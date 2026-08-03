import "dotenv/config";
import { logger } from "./logger";

const missingEnv: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    if (!missingEnv.includes(name)) missingEnv.push(name);
    logger.error(`Missing required environment variable: ${name}`);
    return "";
  }
  return value.trim();
}

function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  /** Public HTTPS base URL of this server, e.g. https://xyz.ngrok-free.app (no trailing slash). */
  publicBaseUrl: optional("PUBLIC_BASE_URL", "").replace(/\/+$/, ""),
  graphVersion: optional("GRAPH_API_VERSION", "v21.0"),
  graphBase: "https://graph.instagram.com",
  instagram: {
    appId: required("INSTAGRAM_APP_ID"),
    appSecret: required("INSTAGRAM_APP_SECRET"),
    redirectUri: required("INSTAGRAM_REDIRECT_URI"),
    scopes: optional(
      "INSTAGRAM_SCOPES",
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
    ),
  },
  webhook: {
    verifyToken: required("WEBHOOK_VERIFY_TOKEN"),
    fields: optional("WEBHOOK_FIELDS", "comments,messages"),
    /** LOCAL DEV ONLY. When true, skips X-Hub-Signature-256 validation. */
    skipSignatureCheck: optional("WEBHOOK_SKIP_SIGNATURE", "false").toLowerCase() === "true",
  },
  adminToken: required("ADMIN_TOKEN"),
  dataDir: optional("DATA_DIR", "data"),
  /** Required env vars that were not set (empty = fully configured). */
  missingEnv,
};

export type AppConfig = typeof config;
