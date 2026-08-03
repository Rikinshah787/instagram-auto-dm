export interface Account {
  /** Instagram professional account id (the token owner). */
  igId: string;
  username: string;
  /** Long-lived Instagram user access token. Never expose to the client. */
  accessToken: string;
  tokenType: string;
  /** Epoch ms when the token expires, or null if unknown. */
  expiresAt: number | null;
  connectedAt: number;
}

export type MatchMode = "any" | "keywords";

/** One per-post automation: which post to watch, what triggers it, and what to send. */
export interface Rule {
  id: string;
  enabled: boolean;
  /** Optional label shown in the dashboard. */
  name: string;
  /** Media (post/reel) id this rule targets. Empty = any post (fallback). */
  mediaId: string;
  matchMode: MatchMode;
  /** Case-insensitive substrings that trigger the DM when matchMode is "keywords". */
  keywords: string[];
  /** The link to send. */
  link: string;
  /** The DM body that carries the link. */
  dmText: string;
  publicReplyEnabled: boolean;
  publicReplyText: string;
}

export interface AutomationConfig {
  /** Master on/off switch. */
  enabled: boolean;
  /** Per-post automations. Post-specific rules win over "all posts" fallbacks. */
  rules: Rule[];

  // ── Follow-gate (two-step, compliant) ──
  /** Require the commenter to follow before the link is sent. */
  requireFollow: boolean;
  /** Private reply sent on the comment, inviting them to DM (used when requireFollow). */
  inviteText: string;
  /** DM sent when they reply but don't follow yet. */
  followNudgeText: string;

  // ── Anti-spam / rate limiting ──
  /** Only ever send the link to a given user once. */
  onlyOncePerUser: boolean;
  /** Max outbound sends per rolling minute. */
  rateLimitPerMinute: number;
  /** Max link DMs per calendar day (UTC). 0 = unlimited. */
  dailyCap: number;
  /** Randomized delay before each send, lower bound (seconds). */
  minDelaySeconds: number;
  /** Randomized delay before each send, upper bound (seconds). */
  maxDelaySeconds: number;
}

/** A commenter awaiting follow verification (they've been invited to DM). */
export interface PendingFollow {
  commentId: string;
  createdAt: number;
  nudged: boolean;
  /** The resolved link message to send once the follow is verified. */
  deliveryText: string;
}

export interface StoreShape {
  account: Account | null;
  automation: AutomationConfig;
  /** Comment ids we already answered (dedupe for webhook retries). */
  processedComments: string[];
  /** IGSIDs that have already received the link (only-once-per-user). */
  deliveredUsers: string[];
  /** IGSID -> pending follow-gate state. */
  pending: Record<string, PendingFollow>;
  /** UTC day key (YYYY-MM-DD) for the daily counter. */
  dayKey: string;
  /** Number of link DMs sent during dayKey. */
  dayCount: number;
}

/** Shape of the `value` object inside a `comments` webhook change. */
export interface CommentWebhookValue {
  id: string;
  text?: string;
  from?: { id: string; username?: string };
  media?: { id: string; media_product_type?: string };
  parent_id?: string;
}

/** Shape of an item inside a `messaging` webhook entry (a DM). */
export interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean };
}
