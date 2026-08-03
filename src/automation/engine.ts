import { logger } from "../logger";
import {
  getAccount,
  getAutomation,
  isProcessed,
  markProcessed,
  hasDelivered,
  markDelivered,
  unmarkDelivered,
  getPending,
  setPending,
  deletePending,
} from "../store";
import { enqueueSend } from "../sender";
import { logEvent } from "../persistence";
import { Account, AutomationConfig, CommentWebhookValue, MessagingEvent, Rule } from "../types";
import * as client from "../instagram/client";

function ruleMatches(rule: Rule, mediaId: string | undefined, text: string): boolean {
  if (!rule.enabled) return false;
  if (rule.mediaId && rule.mediaId !== mediaId) return false;
  if (rule.matchMode === "any") return true;
  if (!text) return false;
  const haystack = text.toLowerCase();
  return rule.keywords.some((k) => {
    const needle = k.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** Pick the rule for a comment: a post-specific rule wins over an "all posts" fallback. */
function findMatchingRule(
  automation: AutomationConfig,
  mediaId: string | undefined,
  text: string,
): Rule | undefined {
  const specific = automation.rules.filter((r) => r.mediaId);
  const fallback = automation.rules.filter((r) => !r.mediaId);
  return (
    specific.find((r) => ruleMatches(r, mediaId, text)) ??
    fallback.find((r) => ruleMatches(r, mediaId, text))
  );
}

/** The final message that carries the link, resolved from the matched rule. */
function buildDeliveryText(rule: Rule): string {
  const base = rule.dmText.trim();
  const link = rule.link.trim();
  if (link && (!base || !base.includes(link))) {
    return base ? `${base}\n\n${link}` : link;
  }
  return base || "Here's your link! 🙌";
}

function inviteMessage(automation: AutomationConfig): string {
  return (
    automation.inviteText.trim() ||
    "Reply here and I'll send you the link! Make sure you're following me 🙌"
  );
}

function nudgeMessage(automation: AutomationConfig): string {
  return (
    automation.followNudgeText.trim() ||
    "Please follow me first, then reply here again and I'll send your link 🙏"
  );
}

function enqueuePublicReply(
  account: Account,
  rule: Rule,
  commentId: string,
  ctx: { mediaId?: string; recipientId?: string; username?: string },
): void {
  if (!rule.publicReplyEnabled || !rule.publicReplyText.trim()) return;
  const text = rule.publicReplyText.trim();
  enqueueSend({
    label: `public reply on ${commentId}`,
    countsTowardCap: false,
    run: async () => {
      try {
        await client.replyToComment(account.accessToken, commentId, text);
        logger.debug(`Posted public reply on comment ${commentId}`);
        await logEvent({
          type: "public_reply",
          status: "success",
          igAccountId: account.igId,
          recipientId: ctx.recipientId,
          recipientUsername: ctx.username,
          commentId,
          mediaId: ctx.mediaId,
          ruleId: rule.id,
          ruleName: rule.name,
          message: text,
        });
      } catch (err) {
        await logEvent({
          type: "public_reply",
          status: "failed",
          igAccountId: account.igId,
          recipientId: ctx.recipientId,
          commentId,
          mediaId: ctx.mediaId,
          ruleId: rule.id,
          ruleName: rule.name,
          message: text,
          error: (err as Error).message,
        });
        throw err;
      }
    },
  });
}

/**
 * Handle a `comments` webhook change. When `requireFollow` is on this only sends
 * an INVITE (the link is delivered later, in handleMessagingEvent, after the
 * follow is verified). When off, it sends the link straight away via a private
 * reply. Every send is routed through the rate-limited queue.
 */
export async function handleCommentChange(value: CommentWebhookValue): Promise<void> {
  const account = await getAccount();
  if (!account) {
    logger.warn("Received a comment but no Instagram account is connected yet");
    return;
  }

  const automation = await getAutomation();
  if (!automation.enabled) {
    logger.debug("Automation is disabled; ignoring comment");
    return;
  }

  const commentId = value.id;
  if (!commentId) return;

  const text = (value.text || "").trim();
  const fromId = value.from?.id;
  const fromUser = value.from?.username?.toLowerCase();
  const fromUsername = value.from?.username;
  const mediaId = value.media?.id;

  // Never reply to our own comments (prevents loops and self-DMs).
  const isSelf =
    (!!fromId && fromId === account.igId) ||
    (!!fromUser && !!account.username && fromUser === account.username.toLowerCase());
  if (isSelf) {
    logger.debug("Skipping a comment made by the connected account itself");
    return;
  }

  // Find the per-post rule that should handle this comment (specific post wins).
  const rule = findMatchingRule(automation, mediaId, text);
  if (!rule) {
    logger.debug(`No matching rule for comment ${commentId} (media ${mediaId ?? "?"}); skipping`);
    return;
  }

  // Dedupe against webhook retries / duplicate deliveries.
  if (await isProcessed(commentId)) {
    logger.debug(`Comment ${commentId} already handled; skipping`);
    return;
  }
  await markProcessed(commentId);

  // Only-once-per-user: don't message someone who already got the link.
  if (automation.onlyOncePerUser && fromId && (await hasDelivered(fromId))) {
    logger.debug(`User ${fromId} already received the link; skipping`);
    return;
  }

  if (automation.requireFollow) {
    if (!fromId) {
      logger.warn("Comment has no commenter id; cannot run the follow-gate");
      return;
    }
    if (await getPending(fromId)) {
      logger.debug(`User ${fromId} was already invited; skipping duplicate invite`);
      return;
    }
    await setPending(fromId, {
      commentId,
      createdAt: Date.now(),
      nudged: false,
      deliveryText: buildDeliveryText(rule),
      mediaId,
      ruleId: rule.id,
      ruleName: rule.name,
      link: rule.link,
      username: fromUsername,
    });
    const inviteText = inviteMessage(automation);
    enqueueSend({
      label: `follow-gate invite for comment ${commentId}`,
      countsTowardCap: true,
      run: async () => {
        try {
          await client.sendPrivateReply(account.accessToken, commentId, inviteText);
          logger.info(`Sent follow-gate invite for comment ${commentId}`);
          await logEvent({
            type: "invite",
            status: "success",
            igAccountId: account.igId,
            recipientId: fromId,
            recipientUsername: fromUsername,
            commentId,
            mediaId,
            ruleId: rule.id,
            ruleName: rule.name,
            link: rule.link,
            message: inviteText,
          });
        } catch (err) {
          await logEvent({
            type: "invite",
            status: "failed",
            igAccountId: account.igId,
            recipientId: fromId,
            recipientUsername: fromUsername,
            commentId,
            mediaId,
            ruleId: rule.id,
            ruleName: rule.name,
            error: (err as Error).message,
          });
          throw err;
        }
      },
    });
    enqueuePublicReply(account, rule, commentId, { mediaId, recipientId: fromId, username: fromUsername });
    return;
  }

  // Direct delivery (no follow-gate): reserve the user so retries can't double-send.
  if (automation.onlyOncePerUser && fromId) await markDelivered(fromId);
  const deliveryText = buildDeliveryText(rule);
  enqueueSend({
    label: `link private reply for comment ${commentId}`,
    countsTowardCap: true,
    run: async () => {
      try {
        const result = await client.sendPrivateReply(account.accessToken, commentId, deliveryText);
        logger.info(`Sent link private reply for comment ${commentId}`, { messageId: result.message_id });
        await logEvent({
          type: "link_delivered",
          status: "success",
          igAccountId: account.igId,
          recipientId: fromId,
          recipientUsername: fromUsername,
          commentId,
          mediaId,
          ruleId: rule.id,
          ruleName: rule.name,
          link: rule.link,
          message: deliveryText,
        });
      } catch (err) {
        if (automation.onlyOncePerUser && fromId) await unmarkDelivered(fromId);
        await logEvent({
          type: "link_delivered",
          status: "failed",
          igAccountId: account.igId,
          recipientId: fromId,
          recipientUsername: fromUsername,
          commentId,
          mediaId,
          ruleId: rule.id,
          ruleName: rule.name,
          link: rule.link,
          error: (err as Error).message,
        });
        throw err;
      }
    },
  });
  enqueuePublicReply(account, rule, commentId, { mediaId, recipientId: fromId, username: fromUsername });
}

/**
 * Handle a DM (`messaging` webhook). Only relevant to the follow-gate: when a
 * user we previously invited replies, we verify they follow us (consent now
 * exists because they messaged), then deliver the link or nudge them to follow.
 */
export async function handleMessagingEvent(event: MessagingEvent): Promise<void> {
  const message = event.message;
  if (!message || message.is_echo) return; // ignore our own echoes / non-message events
  const senderId = event.sender?.id;
  if (!senderId) return;

  const account = await getAccount();
  if (!account || senderId === account.igId) return;

  const automation = await getAutomation();
  if (!automation.enabled || !automation.requireFollow) return;

  const pending = await getPending(senderId);
  if (!pending) {
    logger.debug(`DM from ${senderId} is not part of a follow-gate; ignoring`);
    return;
  }

  if (automation.onlyOncePerUser && (await hasDelivered(senderId))) {
    await deletePending(senderId);
    return;
  }

  // Decide based on follow status. Consent exists now that they've messaged us.
  let decision: "deliver" | "nudge" = "nudge";
  try {
    const profile = await client.getUserProfile(account.accessToken, senderId);
    if (profile.is_user_follow_business === true) {
      decision = "deliver";
    } else if (profile.is_user_follow_business === false) {
      decision = "nudge";
    } else {
      logger.warn(
        `Follow status unavailable for ${senderId}; delivering without gate (check API version/permissions)`,
      );
      decision = "deliver";
    }
  } catch (err) {
    client.logApiError(`Follow lookup failed for ${senderId}`, err);
    decision = "nudge";
  }

  if (decision === "deliver") {
    await markDelivered(senderId);
    await deletePending(senderId);
    const linkText = pending.deliveryText || "Here's your link! 🙌";
    enqueueSend({
      label: `link DM to follower ${senderId}`,
      countsTowardCap: true,
      run: async () => {
        try {
          await client.sendTextDM(account.accessToken, senderId, linkText);
          logger.info(`Delivered link to follower ${senderId}`);
          await logEvent({
            type: "link_delivered",
            status: "success",
            igAccountId: account.igId,
            recipientId: senderId,
            recipientUsername: pending.username,
            commentId: pending.commentId,
            mediaId: pending.mediaId,
            ruleId: pending.ruleId,
            ruleName: pending.ruleName,
            link: pending.link,
            message: linkText,
          });
        } catch (err) {
          await logEvent({
            type: "link_delivered",
            status: "failed",
            igAccountId: account.igId,
            recipientId: senderId,
            recipientUsername: pending.username,
            commentId: pending.commentId,
            mediaId: pending.mediaId,
            ruleId: pending.ruleId,
            ruleName: pending.ruleName,
            link: pending.link,
            error: (err as Error).message,
          });
          throw err;
        }
      },
    });
    return;
  }

  // Not following (or unverifiable): nudge once, then stay quiet.
  if (pending.nudged) {
    logger.debug(`User ${senderId} still not following after a nudge; ignoring`);
    return;
  }
  await setPending(senderId, { ...pending, nudged: true });
  const nudgeText = nudgeMessage(automation);
  enqueueSend({
    label: `follow nudge to ${senderId}`,
    countsTowardCap: false,
    run: async () => {
      try {
        await client.sendTextDM(account.accessToken, senderId, nudgeText);
        logger.info(`Sent follow nudge to ${senderId}`);
        await logEvent({
          type: "nudge",
          status: "success",
          igAccountId: account.igId,
          recipientId: senderId,
          recipientUsername: pending.username,
          commentId: pending.commentId,
          mediaId: pending.mediaId,
          ruleId: pending.ruleId,
          ruleName: pending.ruleName,
          message: nudgeText,
        });
      } catch (err) {
        await logEvent({
          type: "nudge",
          status: "failed",
          igAccountId: account.igId,
          recipientId: senderId,
          recipientUsername: pending.username,
          commentId: pending.commentId,
          error: (err as Error).message,
        });
        throw err;
      }
    },
  });
}
