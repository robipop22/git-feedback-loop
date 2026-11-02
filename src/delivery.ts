import type { FeedbackIssue } from "./issue.js";

type GitHubIssue = {
  number: number;
  body: string | null;
  created_at?: string;
  pull_request?: unknown;
};
export type FeedbackPendingReason = "reconciling" | "rejected" | "transient" | "scan_limit";
export class FeedbackDeliveryError extends Error {
  constructor(
    readonly creationMayHaveSucceeded: boolean,
    readonly reason: FeedbackPendingReason = "transient",
    readonly status?: number,
  ) {
    super("GitHub feedback delivery is incomplete.");
  }
}
export type FeedbackDeliveryOptions = {
  request?: typeof fetch;
  allowCreate?: boolean;
  beforeCreate?: () => Promise<void>;
  deadlineMs?: number;
  requestTimeoutMs?: number;
};

export const deliverFeedbackIssue = async (
  input: FeedbackIssue,
  repository: string,
  token: string,
  {
    request = fetch,
    allowCreate = true,
    beforeCreate,
    deadlineMs = 20_000,
    requestTimeoutMs = 8_000,
  }: FeedbackDeliveryOptions = {},
) => {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
    throw new FeedbackDeliveryError(false, "rejected");
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.marker !== "string" ||
    typeof input.body !== "string" ||
    typeof input.title !== "string" ||
    !input.title ||
    input.title.length > 256 ||
    typeof input.createdAt !== "string" ||
    !/^<!-- [a-zA-Z0-9_-]{1,80}:[a-zA-Z0-9_-]{1,200} -->$/.test(input.marker) ||
    !input.body.startsWith(input.marker)
  )
    throw new FeedbackDeliveryError(false, "rejected");
  if (
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !Number.isSafeInteger(deadlineMs) ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    deadlineMs < 1 ||
    deadlineMs > 20_000 ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 8_000 ||
    requestTimeoutMs > deadlineMs
  ) {
    throw new FeedbackDeliveryError(false, "rejected");
  }
  const started = performance.now();
  let creationMayHaveSucceeded = false;
  let reason: FeedbackPendingReason = "transient";
  let status: number | undefined;
  const deadline = AbortSignal.timeout(deadlineMs);
  const endpoint = `https://api.github.com/repos/${repository}/issues`;
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "feedback-loop",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      status = response.status;
      reason = status >= 400 && status < 500 ? "rejected" : "transient";
      if (init.method === "POST" && reason === "rejected") creationMayHaveSucceeded = false;
      // Credentials and upstream response bodies must not enter errors or logs.
      throw new Error("GitHub rejected the feedback request.");
    }
    return response.json();
  };
  const issueUrl = (issue: GitHubIssue) => {
    if (!Number.isSafeInteger(issue.number) || issue.number < 1)
      throw new Error("Invalid GitHub issue response.");
    return `https://github.com/${repository}/issues/${issue.number}`;
  };
  const earliest = new Date(input.createdAt).getTime() - 10 * 60_000;
  const since = new Date(earliest).toISOString();
  try {
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({
        state: "all",
        since,
        sort: "created",
        direction: "desc",
        per_page: "100",
        page: String(page),
      });
      const issues = (await call(`${endpoint}?${query}`)) as GitHubIssue[];
      if (!Array.isArray(issues)) throw new Error("Invalid GitHub issue list.");
      const existing = issues.find(
        (issue) =>
          !issue.pull_request &&
          typeof issue.body === "string" &&
          issue.body.startsWith(input.marker),
      );
      if (existing) return issueUrl(existing);
      // GitHub sorts this list by creation time, although `since` filters update time.
      const passedWindow = issues.some(
        (issue) => issue.created_at && Date.parse(issue.created_at) < earliest,
      );
      if (issues.length < 100 || passedWindow) {
        if (!allowCreate) return null;
        const requireCreationBudget = () => {
          if (deadline.aborted || deadlineMs - (performance.now() - started) < requestTimeoutMs) {
            throw new FeedbackDeliveryError(false, "transient");
          }
        };
        requireCreationBudget();
        await beforeCreate?.();
        requireCreationBudget();
        creationMayHaveSucceeded = true;
        return issueUrl(
          await call(endpoint, {
            method: "POST",
            body: JSON.stringify({ title: input.title, body: input.body }),
          }),
        );
      }
    }
    reason = "scan_limit";
    throw new Error("GitHub feedback reconciliation exceeded the page limit.");
  } catch {
    throw new FeedbackDeliveryError(creationMayHaveSucceeded, reason, status);
  }
};
