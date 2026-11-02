export type FeedbackRating = "up" | "down";
export type FeedbackReceipt = { id: string; status: "pending" | "delivered"; configured: boolean };
export type FeedbackSubmission = { id: string; text: string; screenshot?: string };
export type FeedbackIssue = { marker: string; title: string; body: string; createdAt: string };
export type FeedbackIssueInput = {
  id: string;
  text: string;
  createdAt: string;
  rating?: FeedbackRating;
  title?: string;
  /** Only include fields that may leave the application. */
  context?: Record<string, string | number | boolean | null>;
  links?: Array<{ label: string; url: string }>;
};

export const protocolMarker = "<!-- feedback-loop:v1 -->";
export const feedbackMarker = (id: string, namespace = "feedback-loop") => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace) || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
    throw new Error("Invalid feedback reference.");
  }
  return `<!-- ${namespace}:${id} -->`;
};

export const buildFeedbackIssue = (
  input: FeedbackIssueInput,
  options: { namespace?: string; notice?: string } = {},
): FeedbackIssue => {
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("Invalid feedback timestamp.");
  const marker = feedbackMarker(input.id, options.namespace);
  const links = (input.links ?? []).map(({ label, url }) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid feedback link.");
    return `[${label.replace(/[\[\]\r\n]/g, "")}](${parsed.href.replace(/[()]/g, (value) => encodeURIComponent(value))})`;
  });
  return {
    marker,
    createdAt: input.createdAt,
    title: (input.title ?? `[Feedback] ${input.id}`).replace(/[\r\n]/g, " ").slice(0, 256),
    body: [marker, protocolMarker,
      ...(input.rating ? [`## Rating\nThumbs ${input.rating}`] : []),
      `## Feedback\n${(input.text || "No additional notes.").split("\n").map((line) => `    ${line}`).join("\n")}`,
      "## Trace reference", "```json",
      JSON.stringify({ ...input.context, feedbackId: input.id, submittedAt: input.createdAt }, null, 2).replace(/`/g, "\\u0060"),
      "```", ...links, ...(options.notice ? [options.notice] : []),
    ].join("\n\n"),
  };
};
