import type { FeedbackReceipt, FeedbackSubmission } from "../issue.js";

export class FeedbackClientError extends Error {
  constructor(readonly status: number) { super(`Feedback request failed (${status}).`); }
}

export const createFeedbackClient = ({ endpoint = "/api/feedback", request = fetch }: {
  endpoint?: string; request?: typeof fetch;
} = {}) => {
  const base = endpoint.replace(/\/$/, "");
  const call = async <T>(path: string, init: RequestInit = {}, milliseconds = 20_000): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    try {
      const response = await request(`${base}${path}`, { credentials: "include", ...init, signal: controller.signal });
      if (!response.ok) throw new FeedbackClientError(response.status);
      return await response.json() as T;
    } finally { clearTimeout(timer); }
  };
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    submit: (input: FeedbackSubmission) => call<FeedbackReceipt>("", json(input)),
    status: (id: string) => call<FeedbackReceipt>(`/${encodeURIComponent(id)}`),
    summarize: async (text: string) => (await call<{ summary: string }>("/summarize", json({ text }), 35_000)).summary,
    transcribe: async (audio: Blob, language: string) => {
      const body = new FormData(); body.append("audio", audio, "feedback-audio"); body.append("language", language);
      return (await call<{ text: string }>("/transcribe", { method: "POST", body }, 100_000)).text;
    },
  };
};
export type FeedbackClient = ReturnType<typeof createFeedbackClient>;
