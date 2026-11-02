import type { FeedbackIssue } from "./issue.js";

type GitHubIssue = { number: number; body: string | null; pull_request?: unknown };

export class FeedbackDeliveryError extends Error {
  constructor(readonly creationMayHaveSucceeded: boolean) {
    super("GitHub feedback delivery is incomplete.");
  }
}

export const deliverFeedbackIssue = async (
  input: FeedbackIssue,
  repository: string,
  token: string,
  { request = fetch, allowCreate = true }: { request?: typeof fetch; allowCreate?: boolean } = {},
) => {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository.");
  let creationMayHaveSucceeded = false;
  const deadline = AbortSignal.timeout(20_000);
  const endpoint = `https://api.github.com/repos/${repository}/issues`;
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "feedback-loop",
        "Content-Type": "application/json",
      },
    });
    // Never include GitHub response bodies or credentials in application errors.
    if (!response.ok) {
      // A rejected POST cannot have created an issue. Server failures are ambiguous.
      if (init.method === "POST" && response.status >= 400 && response.status < 500) creationMayHaveSucceeded = false;
      throw new Error("GitHub rejected the feedback request.");
    }
    return response.json();
  };
  const issueUrl = (issue: GitHubIssue) => {
    if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("Invalid GitHub issue response.");
    return `https://github.com/${repository}/issues/${issue.number}`;
  };

  // List issues directly. GitHub search indexing can lag after a successful POST.
  const since = new Date(new Date(input.createdAt).getTime() - 60_000).toISOString();
  try {
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ state: "all", since, sort: "created", direction: "desc", per_page: "100", page: String(page) });
      const issues = await call(`${endpoint}?${query}`) as GitHubIssue[];
      if (!Array.isArray(issues)) throw new Error("Invalid GitHub issue list.");
      const existing = issues.find((issue) => !issue.pull_request && issue.body?.startsWith(input.marker));
      if (existing) return issueUrl(existing);
      if (issues.length < 100) {
        if (!allowCreate) return null;
        creationMayHaveSucceeded = true;
        return issueUrl(await call(endpoint, { method: "POST", body: JSON.stringify({ title: input.title, body: input.body }) }));
      }
    }
    // Keep pending if the bounded scan cannot establish that no issue exists.
    throw new Error("GitHub feedback reconciliation exceeded the page limit.");
  } catch {
    throw new FeedbackDeliveryError(creationMayHaveSucceeded);
  }
};
