import { deliverFeedbackIssue, FeedbackDeliveryError } from "./delivery.js";
import type { FeedbackIssue } from "./issue.js";

export const retryDelay = (previousAttempts: number) => Math.min(3_600_000, 30_000 * 2 ** Math.min(Math.max(0, previousAttempts), 7));

/** Call only after an atomic database claim persists creation intent and a lease. */
export const deliverClaimedFeedback = async (options: {
  issue: FeedbackIssue;
  repository: string;
  token: string;
  previousCreationAttempted: boolean;
  previousAttempts: number;
  delivered: (issueUrl: string) => Promise<void>;
  pending: (state: { creationAttempted: boolean; nextAttemptAt: Date }) => Promise<void>;
  deliver?: () => Promise<string | null>;
}) => {
  let issueUrl: string | null = null;
  let creationAttempted = true;
  try {
    issueUrl = await (options.deliver ?? (() => deliverFeedbackIssue(options.issue, options.repository, options.token,
      { allowCreate: !options.previousCreationAttempted })))();
  } catch (error) {
    creationAttempted = options.previousCreationAttempted || !(error instanceof FeedbackDeliveryError) || error.creationMayHaveSucceeded;
  }
  if (issueUrl) await options.delivered(issueUrl);
  else await options.pending({ creationAttempted, nextAttemptAt: new Date(Date.now() + retryDelay(options.previousAttempts)) });
};
