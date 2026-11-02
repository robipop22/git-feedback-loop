import {
  deliverFeedbackIssue,
  FeedbackDeliveryError,
  type FeedbackPendingReason,
} from "./delivery.js";
import type { FeedbackIssue } from "./issue.js";

export const retryDelay = (previousAttempts: number) =>
  Math.min(3_600_000, 30_000 * 2 ** Math.min(Math.max(0, previousAttempts), 7));
export type FeedbackPendingState = {
  creationAttempted: boolean;
  nextAttemptAt: Date;
  reason: FeedbackPendingReason;
  attentionRequired: boolean;
};

/** Claim a fenced database lease first. Persist intent in beforeCreate, or in the legacy claim. */
export const deliverClaimedFeedback = async (options: {
  issue: FeedbackIssue;
  repository: string;
  token: string;
  previousCreationAttempted: boolean;
  previousAttempts: number;
  previousAttentionRequired?: boolean;
  beforeCreate?: () => Promise<void>;
  delivered: (issueUrl: string) => Promise<void>;
  pending: (state: FeedbackPendingState) => Promise<void>;
  deliver?: () => Promise<string | null>;
}) => {
  let issueUrl: string | null = null;
  let creationAttempted = true;
  let reason: FeedbackPendingReason = "reconciling";
  try {
    issueUrl = await (
      options.deliver ??
      (() =>
        deliverFeedbackIssue(options.issue, options.repository, options.token, {
          allowCreate: !options.previousCreationAttempted,
          beforeCreate: options.beforeCreate,
        }))
    )();
  } catch (error) {
    creationAttempted =
      options.previousCreationAttempted ||
      !(error instanceof FeedbackDeliveryError) ||
      error.creationMayHaveSucceeded;
    reason = error instanceof FeedbackDeliveryError ? error.reason : "transient";
  }
  if (issueUrl) await options.delivered(issueUrl);
  else
    await options.pending({
      creationAttempted,
      reason,
      attentionRequired:
        Boolean(options.previousAttentionRequired) ||
        (options.previousAttempts >= 4 &&
          (reason !== "transient" || options.previousCreationAttempted)),
      nextAttemptAt: new Date(Date.now() + retryDelay(options.previousAttempts)),
    });
};
