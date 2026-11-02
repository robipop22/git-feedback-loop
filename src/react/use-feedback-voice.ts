import { speakFeedback, startFeedbackConversation, stopFeedbackSpeech } from "../browser/feedback-conversation.js";
import { useEffect, useRef, useState } from "react";

type Job = { blob: Blob; append: boolean; speech: number };
export const useFeedbackVoice = (onText: (text: string, append: boolean) => Promise<string | void>, language: string, transcribe: (audio: Blob, language: string) => Promise<string>) => {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [error, setError] = useState(false);
  const [speechUnavailable, setSpeechUnavailable] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const starting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conversation = useRef<(() => Promise<void>) | null>(null);
  const jobs = useRef<Job[]>([]);
  const draining = useRef(false);
  const failed = useRef(false);
  const speech = useRef(0);
  const callback = useRef(onText); callback.current = onText;
  const transcription = useRef(transcribe); transcription.current = transcribe;
  const stop = () => {
    clearTimeout(timer.current); stopFeedbackSpeech();
    if (conversation.current) {
      const finish = conversation.current; conversation.current = null;
      void finish().finally(() => {
        stream.current?.getTracks().forEach((track) => track.stop());
        if (mounted.current) setRecording(false);
      });
    } else if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const drain = async () => {
    if (draining.current) return;
    draining.current = true; failed.current = false; setBusy(true); setError(false);
    try {
      while (jobs.current.length && mounted.current) {
        const job = jobs.current[0]!;
        const text = await transcription.current(job.blob, language);
        if (!mounted.current) return;
        const summary = await callback.current(text, job.append);
        jobs.current.shift(); setAudio(null);
        if (job.append && summary && conversation.current && speech.current === job.speech) {
          setSpeechUnavailable(!speakFeedback(summary, language));
        }
      }
    } catch {
      if (mounted.current) { failed.current = true; setAudio(jobs.current[0]?.blob ?? null); setError(true); stop(); }
    } finally { draining.current = false; if (mounted.current) setBusy(false); }
  };
  const enqueue = (blob: Blob, append: boolean) => {
    if (!mounted.current) return;
    jobs.current.push({ blob, append, speech: speech.current });
    // Failed audio stays queued until the user retries it.
    if (!failed.current) void drain();
  };
  const start = async (continuous = false) => {
    if (starting.current || recording || busy || jobs.current.length) return;
    starting.current = true; setError(false); setBusy(true); setSpeechUnavailable(false);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!mounted.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      if (continuous) {
        const finish = await startFeedbackConversation(media, (blob) => enqueue(blob, true), () => { speech.current++; stopFeedbackSpeech(); });
        if (!mounted.current) { await finish(); media.getTracks().forEach((track) => track.stop()); return; }
        conversation.current = finish; setRecording(true); timer.current = setTimeout(stop, 300_000);
      } else {
        const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find((value) => MediaRecorder.isTypeSupported(value));
        const instance = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
        const chunks: Blob[] = []; let bytes = 0; recorder.current = instance;
        instance.ondataavailable = (event) => { chunks.push(event.data); bytes += event.data.size; if (bytes > 7_000_000) stop(); };
        instance.onstop = () => {
          clearTimeout(timer.current); media.getTracks().forEach((track) => track.stop());
          if (!mounted.current) return;
          setRecording(false); enqueue(new Blob(chunks, { type: instance.mimeType || mimeType || "audio/webm" }), false);
        };
        instance.onerror = () => { stop(); setError(true); };
        instance.start(1000); setRecording(true); timer.current = setTimeout(stop, 60_000);
      }
    } catch { stream.current?.getTracks().forEach((track) => track.stop()); setError(true); }
    finally { starting.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); stream.current?.getTracks().forEach((track) => track.stop()); jobs.current = []; };
  }, []);
  return { recording, busy, error, audio, speechUnavailable, start: () => start(), startConversation: () => start(true), stop, retry: drain, discard: () => { jobs.current = []; failed.current = false; setAudio(null); setError(false); } };
};
