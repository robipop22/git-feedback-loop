import { useEffect, useId, useRef, useState } from "react";
import { captureFeedbackScreenshot, readFeedbackScreenshot, type FeedbackClient } from "../browser/index.js";
import type { FeedbackReceipt } from "../issue.js";
import { useFeedbackVoice } from "./use-feedback-voice.js";

const defaultLabels = {
  title: "Feedback", close: "Close", text: "Describe the problem or suggestion", send: "Send feedback",
  pending: "Feedback saved. Delivery is pending.", delivered: "Feedback delivered.", reference: "Reference",
  error: "The request failed. Retry with the same reference.", privacy: "Exclude private information from your feedback and screenshots.",
  another: "Send more feedback", record: "Record", conversation: "Start conversation", stop: "Stop recording",
  retry: "Retry audio", discard: "Discard audio", screenshot: "Capture screen", attach: "Attach screenshot",
  remove: "Remove screenshot", unavailable: "Delivery is not configured.", speech: "A local speech voice is unavailable.",
};

/** Provide one stable storageKey per signed-in account. Change the React key when the account changes. */
export const FeedbackWidget = ({ client, storageKey, voice = false, language = "en", transcriptionLanguage = language,
  summarize = false, screenshots = true, recordingBlocked = false, labels: suppliedLabels = {}, className,
}: {
  client: FeedbackClient;
  storageKey: string;
  voice?: boolean;
  language?: string;
  transcriptionLanguage?: string;
  summarize?: boolean;
  screenshots?: boolean;
  recordingBlocked?: boolean;
  labels?: Partial<typeof defaultLabels>;
  className?: string;
}) => {
  const labels = { ...defaultLabels, ...suppliedLabels };
  const field = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState<string>();
  const [receipt, setReceipt] = useState<FeedbackReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const id = useRef<string | undefined>(undefined);
  const sending = useRef(false);
  const source = useRef("");
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const audio = useFeedbackVoice(async (spoken, append) => {
    source.current = append ? [source.current, spoken].filter(Boolean).join("\n") : spoken;
    if (source.current.length > 8000) throw new Error("Feedback exceeds 8,000 characters.");
    setText(source.current);
    try {
      const summary = summarize ? await client.summarize(source.current) : source.current;
      setText(summary); return summary;
    } catch { setError(true); return source.current; }
  }, language, (blob) => client.transcribe(blob, transcriptionLanguage));
  const locked = busy || audio.busy || audio.recording;
  const refresh = async (reference: string) => {
    try { setReceipt(await client.status(reference)); setError(false); }
    catch { setError(true); }
  };
  useEffect(() => {
    try { const reference = sessionStorage.getItem(storageKey); if (reference) void refresh(reference); }
    catch { /* The server receipt still works when browser storage is unavailable. */ }
  }, [storageKey, client]);
  useEffect(() => {
    if (!receipt || receipt.status !== "pending" || !receipt.configured || !open) return;
    const timer = setInterval(() => void refresh(receipt.id), 5000);
    return () => clearInterval(timer);
  }, [receipt, open, client]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const submit = async () => {
    if (sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setSubmitted(true); setError(false);
    id.current ??= crypto.randomUUID();
    try {
      const saved = await client.submit({ id: id.current, text, ...(screenshot ? { screenshot } : {}) });
      setReceipt(saved);
      try { sessionStorage.setItem(storageKey, saved.id); } catch { /* Storage is optional. */ }
    } catch { setError(true); }
    finally { sending.current = false; setBusy(false); }
  };
  const attach = async (action: () => Promise<string>) => {
    setBusy(true); setError(false);
    try { setScreenshot(await action()); } catch { setError(true); } finally { setBusy(false); }
  };
  return <aside className={className} style={{ position: "fixed", right: 16, bottom: 16, zIndex: 40, maxWidth: "calc(100vw - 32px)" }}>
    {open ? <section aria-label={labels.title} style={{ width: 360, maxWidth: "100%", maxHeight: "75dvh", overflow: "auto", padding: 16, border: "1px solid #ccc", borderRadius: 12, background: "Canvas", color: "CanvasText", display: "grid", gap: 12 }}>
      <header><strong>{labels.title}</strong> <button type="button" disabled={locked} onClick={() => { setOpen(false); trigger.current?.focus(); }}>{labels.close}</button></header>
      {receipt ? <>
        <p role="status">{receipt.status === "delivered" ? labels.delivered : labels.pending}</p>
        {!receipt.configured ? <p>{labels.unavailable}</p> : null}
        <p>{labels.reference}: {receipt.id}</p>
        <button type="button" onClick={() => {
          setReceipt(undefined); setSubmitted(false); setError(false); setText(""); setScreenshot(undefined); id.current = undefined; source.current = "";
          try { sessionStorage.removeItem(storageKey); } catch { /* Storage is optional. */ }
        }}>{labels.another}</button>
      </> : <>
        <label htmlFor={field}>{labels.text}</label>
        <textarea id={field} ref={input} maxLength={8000} value={text} disabled={locked || submitted} onChange={(event) => setText(event.target.value)} />
        {voice ? <div>
          <button type="button" disabled={!audio.recording && (locked || submitted || recordingBlocked)} onClick={() => audio.recording ? audio.stop() : void audio.start()}>{audio.recording ? labels.stop : labels.record}</button>
          <button type="button" disabled={locked || submitted || recordingBlocked || Boolean(audio.audio)} onClick={() => { source.current = text; void audio.startConversation(); }}>{labels.conversation}</button>
          {audio.audio ? <><button type="button" disabled={locked} onClick={() => void audio.retry()}>{labels.retry}</button><button type="button" disabled={locked} onClick={audio.discard}>{labels.discard}</button></> : null}
        </div> : null}
        {audio.speechUnavailable ? <p role="status">{labels.speech}</p> : null}
        {screenshots ? <>
          <button type="button" disabled={locked || submitted} onClick={() => void attach(captureFeedbackScreenshot)}>{labels.screenshot}</button>
          <label>{labels.attach}<input type="file" accept="image/png,image/jpeg" disabled={locked || submitted} onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(() => readFeedbackScreenshot(file)); }} /></label>
          {screenshot ? <><img src={screenshot} alt={labels.attach} style={{ maxHeight: 160, maxWidth: "100%" }} /><button type="button" disabled={locked || submitted} onClick={() => setScreenshot(undefined)}>{labels.remove}</button></> : null}
        </> : null}
        <p>{labels.privacy}</p>
        <button type="button" disabled={locked || !text.trim() || Boolean(audio.audio)} onClick={() => void submit()}>{labels.send}</button>
      </>}
      {error || audio.error ? <p role="alert">{labels.error}</p> : null}
    </section> : null}
    <button type="button" ref={trigger} aria-expanded={open} disabled={locked} onClick={() => setOpen(!open)}>{labels.title}</button>
  </aside>;
};
