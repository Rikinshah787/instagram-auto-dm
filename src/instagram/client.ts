import { config } from "../config";
import { logger } from "../logger";

const GRAPH = config.graphBase; // https://graph.instagram.com
const V = config.graphVersion; // e.g. v21.0

export class InstagramApiError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "InstagramApiError";
    this.status = status;
    this.details = details;
  }
}

type FetchInit = Parameters<typeof fetch>[1];

async function apiFetch(url: string, init?: FetchInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = json?.error ?? json;
    const bits = [err?.message || `HTTP ${res.status}`];
    if (err?.code != null) bits.push(`code ${err.code}${err.error_subcode ? "/" + err.error_subcode : ""}`);
    if (err?.type) bits.push(String(err.type));
    throw new InstagramApiError(bits.join(" — "), res.status, err);
  }
  return json;
}

/** Build the Instagram authorization URL the user is redirected to. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    enable_fb_login: "0",
    force_authentication: "1",
    client_id: config.instagram.appId,
    redirect_uri: config.instagram.redirectUri,
    response_type: "code",
    scope: config.instagram.scopes,
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

/** Exchange an authorization code for a short-lived access token. */
export async function exchangeCodeForToken(
  code: string,
): Promise<{ access_token: string; user_id: string; permissions?: string }> {
  const body = new URLSearchParams({
    client_id: config.instagram.appId,
    client_secret: config.instagram.appSecret,
    grant_type: "authorization_code",
    redirect_uri: config.instagram.redirectUri,
    code,
  });
  return apiFetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/** Exchange a short-lived token for a long-lived (~60 day) token. */
export async function getLongLivedToken(
  shortToken: string,
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: config.instagram.appSecret,
    access_token: shortToken,
  });
  return apiFetch(`${GRAPH}/access_token?${params.toString()}`, { method: "GET" });
}

/** Refresh a long-lived token, extending it another ~60 days. */
export async function refreshLongLivedToken(
  token: string,
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  const params = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
  return apiFetch(`${GRAPH}/refresh_access_token?${params.toString()}`, { method: "GET" });
}

/** Fetch the connected account's id + username. */
export async function getProfile(token: string): Promise<{ user_id: string; username: string }> {
  const params = new URLSearchParams({ fields: "user_id,username", access_token: token });
  return apiFetch(`${GRAPH}/me?${params.toString()}`, { method: "GET" });
}

/**
 * Look up a commenter's messaging profile, including whether they follow the
 * business (`is_user_follow_business`). Only works AFTER the user has sent a
 * message (Instagram requires user consent), which is why the follow-gate is
 * a two-step flow. Returns an empty object rather than throwing on 4xx so the
 * caller can decide how to treat an unverifiable user.
 */
export async function getUserProfile(
  token: string,
  igsid: string,
): Promise<{
  id?: string;
  name?: string;
  username?: string;
  follower_count?: number;
  is_user_follow_business?: boolean;
  is_business_follow_user?: boolean;
}> {
  const params = new URLSearchParams({
    fields: "name,username,follower_count,is_user_follow_business,is_business_follow_user",
    access_token: token,
  });
  return apiFetch(`${GRAPH}/${V}/${igsid}?${params.toString()}`, { method: "GET" });
}

/** List the account's recent posts/reels so a rule can target a specific one. */
export async function getMedia(
  token: string,
  limit = 25,
): Promise<
  Array<{
    id: string;
    caption?: string;
    media_type?: string;
    media_product_type?: string;
    permalink?: string;
    thumbnail_url?: string;
    media_url?: string;
    timestamp?: string;
  }>
> {
  const params = new URLSearchParams({
    fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp",
    limit: String(limit),
    access_token: token,
  });
  const res = await apiFetch(`${GRAPH}/${V}/me/media?${params.toString()}`, { method: "GET" });
  return Array.isArray(res?.data) ? res.data : [];
}
/** Read recent comments on one of the account's media objects (diagnostic). */
export async function getMediaComments(
  token: string,
  mediaId: string,
  limit = 20,
): Promise<Array<{ id: string; text?: string; username?: string; timestamp?: string }>> {
  const params = new URLSearchParams({
    fields: "id,text,username,timestamp",
    limit: String(limit),
    access_token: token,
  });
  const res = await apiFetch(`${GRAPH}/${V}/${mediaId}/comments?${params.toString()}`, { method: "GET" });
  return Array.isArray(res?.data) ? res.data : [];
}
/** Subscribe the connected account to webhook fields (e.g. "comments"). */
export async function subscribeApps(token: string, fields: string): Promise<{ success: boolean }> {
  const params = new URLSearchParams({ subscribed_fields: fields, access_token: token });
  return apiFetch(`${GRAPH}/${V}/me/subscribed_apps?${params.toString()}`, { method: "POST" });
}

/**
 * Send a private reply (DM) to a commenter. This is the official, compliant
 * "comment -> DM" mechanism: one reply per comment, within 7 days.
 */
export async function sendPrivateReply(
  token: string,
  commentId: string,
  text: string,
): Promise<{ recipient_id: string; message_id: string }> {
  return apiFetch(`${GRAPH}/${V}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
}

/** Send a standard text DM to an Instagram-scoped user id (must be within the messaging window). */
export async function sendTextDM(
  token: string,
  igsid: string,
  text: string,
): Promise<{ recipient_id: string; message_id: string }> {
  return apiFetch(`${GRAPH}/${V}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
}

/** Post a public reply under a comment (e.g. "Check your DMs 📩"). */
export async function replyToComment(
  token: string,
  commentId: string,
  message: string,
): Promise<{ id: string }> {
  const params = new URLSearchParams({ message, access_token: token });
  return apiFetch(`${GRAPH}/${V}/${commentId}/replies?${params.toString()}`, { method: "POST" });
}

export function logApiError(context: string, err: unknown): void {
  if (err instanceof InstagramApiError) {
    logger.error(`${context}: ${err.message}`, { status: err.status, details: err.details });
  } else {
    logger.error(`${context}: ${(err as Error).message}`);
  }
}
