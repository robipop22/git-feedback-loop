import { useEffect, useId, useRef, useState } from "react";
import {
  captureFeedbackScreenshot,
  readFeedbackScreenshot,
  type FeedbackClient,
} from "../browser/index.js";
import { useFeedbackSubmission } from "./use-feedback-submission.js";
import { useFeedbackVoice } from "./use-feedback-voice.js";

import { defaultFeedbackLabels as defaultLabels } from "./feedback-labels.js";

/** Provide one stable storageKey per signed-in account. Change the React key when the account changes. */
export const FeedbackWidget = ({
  client,
  storageKey,
  voice = false,
  language = "en",
  transcriptionLanguage = language,
  summarize = false,
  screenshots = true,
  recordingBlocked = false,
  workletUrl,
  allowBargeIn = false,
  labels: suppliedLabels = {},
  className,
}: {
  client: FeedbackClient;
  storageKey: string;
  voice?: boolean;
  language?: string;
  transcriptionLanguage?: string;
  summarize?: boolean;
  screenshots?: boolean;
  recordingBlocked?: boolean;
  workletUrl?: string;
  /** Barge-in requires headphones to prevent the microphone from capturing spoken replies. */
  allowBargeIn?: boolean;
  labels?: Partial<typeof defaultLabels>;
  className?: string;
}) => {
  const labels = { ...defaultLabels, ...suppliedLabels };
  const field = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const submission = useFeedbackSubmission({ client, storageKey, polling: open });
  const { receipt, submitted } = submission;
  const source = useRef("");
  const identity = useRef(storageKey);
  identity.current = storageKey;
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const audio = useFeedbackVoice(
    async (spoken, append) => {
      if (identity.current !== storageKey) return;
      const combined = append ? [source.current, spoken].filter(Boolean).join("\n") : spoken;
      if (combined.length > 8000) throw new Error("Feedback exceeds 8,000 characters.");
      source.current = combined;
      setText(source.current);
      try {
        const summary = summarize ? await client.summarize(source.current) : source.current;
        if (identity.current === storageKey) setText(summary);
        return summary;
      } catch {
        if (identity.current === storageKey) setError(true);
        return source.current;
      }
    },
    language,
    (blob, _language, signal) => client.transcribe(blob, transcriptionLanguage, { signal }),
    { workletUrl, allowBargeIn, identityKey: storageKey },
  );
  const locked = busy || submission.busy || audio.busy || audio.recording;
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    setText("");
    setScreenshot(undefined);
    setError(false);
    setBusy(false);
    source.current = "";
  }, [storageKey]);
  const submit = async () => {
    if (!text.trim()) return;
    setError(false);
    await submission.submit({ text, ...(screenshot ? { screenshot } : {}) });
  };
  const attach = async (action: () => Promise<string>) => {
    const active = storageKey;
    setBusy(true);
    setError(false);
    try {
      const image = await action();
      if (identity.current === active) setScreenshot(image);
    } catch {
      if (identity.current === active) setError(true);
    } finally {
      if (identity.current === active) setBusy(false);
    }
  };
  return (
    <aside
      className={className}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 40,
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {open ? (
        <section
          aria-label={labels.title}
          style={{
            width: 360,
            maxWidth: "100%",
            maxHeight: "75dvh",
            overflow: "auto",
            padding: 16,
            border: "1px solid #ccc",
            borderRadius: 12,
            background: "Canvas",
            color: "CanvasText",
            display: "grid",
            gap: 12,
          }}
        >
          <header>
            <strong>{labels.title}</strong>{" "}
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {labels.close}
            </button>
          </header>
          {receipt ? (
            <>
              <p role="status">
                {receipt.status === "delivered"
                  ? labels.delivered
                  : receipt.attentionRequired
                    ? labels.attention
                    : labels.pending}
              </p>
              {receipt.status === "pending" && !receipt.configured ? (
                <p>{labels.unavailable}</p>
              ) : null}
              <p>
                {labels.reference}: {receipt.id}
              </p>
              {receipt.status === "pending" && receipt.attentionRequired ? (
                <button type="button" onClick={() => void submission.refresh()}>
                  {labels.checkStatus}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  submission.reset();
                  setError(false);
                  setText("");
                  setScreenshot(undefined);
                  source.current = "";
                }}
              >
                {labels.another}
              </button>
            </>
          ) : (
            <>
              <label htmlFor={field}>{labels.text}</label>
              <textarea
                id={field}
                ref={input}
                maxLength={8000}
                value={text}
                disabled={locked || submitted}
                onChange={(event) => {
                  setText(event.target.value);
                  source.current = event.target.value;
                }}
              />
              {voice ? (
                <div>
                  <button
                    type="button"
                    disabled={!audio.recording && (locked || submitted || recordingBlocked)}
                    onClick={() => (audio.recording ? audio.stop() : void audio.start())}
                  >
                    {audio.recording ? labels.stop : labels.record}
                  </button>
                  <button
                    type="button"
                    disabled={locked || submitted || recordingBlocked || Boolean(audio.audio)}
                    onClick={() => {
                      source.current = text;
                      void audio.startConversation();
                    }}
                  >
                    {labels.conversation}
                  </button>
                  {audio.audio ? (
                    <>
                      <button type="button" disabled={locked} onClick={() => void audio.retry()}>
                        {labels.retry}
                      </button>
                      <button type="button" disabled={locked} onClick={audio.discard}>
                        {labels.discard}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {audio.speechUnavailable ? <p role="status">{labels.speech}</p> : null}
              {screenshots ? (
                <>
                  {typeof navigator !== "undefined" &&
                  typeof navigator.mediaDevices?.getDisplayMedia === "function" ? (
                    <button
                      type="button"
                      disabled={locked || submitted}
                      onClick={() => void attach(captureFeedbackScreenshot)}
                    >
                      {labels.screenshot}
                    </button>
                  ) : null}
                  <label>
                    {labels.attach}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={locked || submitted}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void attach(() => readFeedbackScreenshot(file));
                      }}
                    />
                  </label>
                  {screenshot ? (
                    <>
                      <img
                        src={screenshot}
                        alt={labels.attach}
                        style={{ maxHeight: 160, maxWidth: "100%" }}
                      />
                      <button
                        type="button"
                        disabled={locked || submitted}
                        onClick={() => setScreenshot(undefined)}
                      >
                        {labels.remove}
                      </button>
                    </>
                  ) : null}
                </>
              ) : null}
              <p>{labels.privacy}</p>
              <button
                type="button"
                disabled={locked || !text.trim() || Boolean(audio.audio)}
                onClick={() => void submit()}
              >
                {labels.send}
              </button>
            </>
          )}
          {error || audio.error || submission.error ? (
            <p role="alert">{submission.editableError ? labels.fixAndResend : labels.error}</p>
          ) : null}
        </section>
      ) : null}
      <button
        type="button"
        ref={trigger}
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen(!open)}
      >
        {labels.title}
      </button>
    </aside>
  );
};
