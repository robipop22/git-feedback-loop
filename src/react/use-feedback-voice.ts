import {
  prepareFeedbackSpeech,
  speakFeedback,
  startFeedbackConversation,
  stopFeedbackSpeech,
  type FeedbackConversation,
} from "../browser/feedback-conversation.js";
import { useEffect, useRef, useState } from "react";

type Job = { blob: Blob; append: boolean; speech: number; text?: string };
export type FeedbackVoiceOptions = {
  workletUrl?: string;
  allowBargeIn?: boolean;
  identityKey?: string;
};
export const useFeedbackVoice = (
  onText: (text: string, append: boolean) => Promise<string | void>,
  language: string,
  transcribe: (audio: Blob, language: string, signal?: AbortSignal) => Promise<string>,
  options: FeedbackVoiceOptions = {},
) => {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [error, setError] = useState(false);
  const [speechUnavailable, setSpeechUnavailable] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const identity = useRef(options.identityKey);
  if (identity.current !== options.identityKey) {
    identity.current = options.identityKey;
    epoch.current++;
  }
  const starting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conversation = useRef<FeedbackConversation | null>(null);
  const jobs = useRef<Job[]>([]);
  const draining = useRef(false);
  const failed = useRef(false);
  const speech = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const callback = useRef(onText);
  callback.current = onText;
  const transcription = useRef(transcribe);
  transcription.current = transcribe;
  const settings = useRef(options);
  settings.current = options;
  const alive = (active: number) => mounted.current && active === epoch.current;
  const stop = () => {
    clearTimeout(timer.current);
    stopFeedbackSpeech();
    const media = stream.current;
    const active = epoch.current;
    const notify = mounted.current;
    if (conversation.current) {
      const finish = conversation.current;
      conversation.current = null;
      void finish()
        .catch(() => {
          if (notify && alive(active)) setError(true);
        })
        .finally(() => {
          media?.getTracks().forEach((track) => track.stop());
          if (stream.current === media) stream.current = null;
          if (notify && alive(active)) setRecording(false);
        });
    } else if (recorder.current?.state === "recording") recorder.current.stop();
    else media?.getTracks().forEach((track) => track.stop());
  };
  const drain = async () => {
    if (draining.current || !mounted.current) return;
    const active = epoch.current;
    draining.current = true;
    failed.current = false;
    setBusy(true);
    setError(false);
    try {
      while (jobs.current.length && alive(active)) {
        const job = jobs.current[0]!;
        const controller = new AbortController();
        request.current = controller;
        job.text ??= await transcription.current(job.blob, language, controller.signal);
        if (!alive(active)) return;
        const summary = await callback.current(job.text, job.append);
        if (!alive(active)) return;
        jobs.current.shift();
        setAudio(null);
        if (job.append && summary && conversation.current && speech.current === job.speech) {
          await prepareFeedbackSpeech(language);
          if (!alive(active) || !conversation.current || speech.current !== job.speech) continue;
          const capture = conversation.current;
          setSpeechUnavailable(
            !speakFeedback(
              summary,
              language,
              settings.current.allowBargeIn
                ? {}
                : {
                    onStart: () => capture.pause(),
                    onEnd: () => capture.resume(),
                  },
            ),
          );
        }
      }
    } catch {
      if (alive(active)) {
        failed.current = true;
        setAudio(jobs.current[0]?.blob ?? null);
        setError(true);
        stop();
      }
    } finally {
      if (alive(active)) {
        request.current = undefined;
        draining.current = false;
        setBusy(false);
      }
    }
  };
  const enqueue = (blob: Blob, append: boolean, active: number) => {
    if (!alive(active)) return;
    jobs.current.push({ blob, append, speech: speech.current });
    if (!failed.current) void drain();
  };
  const start = async (continuous = false) => {
    if (starting.current || recording || busy || jobs.current.length) return;
    const active = epoch.current;
    starting.current = true;
    setError(false);
    setBusy(true);
    setSpeechUnavailable(false);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!alive(active)) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (continuous) {
        const finish = await startFeedbackConversation(
          media,
          (blob) => enqueue(blob, true, active),
          () => {
            speech.current++;
            stopFeedbackSpeech();
          },
          { workletUrl: settings.current.workletUrl },
        );
        if (!alive(active)) {
          await finish();
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        conversation.current = finish;
        setRecording(true);
        timer.current = setTimeout(stop, 300_000);
      } else {
        const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"].find((value) =>
          MediaRecorder.isTypeSupported(value),
        );
        const instance = mimeType
          ? new MediaRecorder(media, { mimeType })
          : new MediaRecorder(media);
        const chunks: Blob[] = [];
        let bytes = 0;
        recorder.current = instance;
        instance.ondataavailable = (event) => {
          chunks.push(event.data);
          bytes += event.data.size;
          if (bytes > 7_000_000) stop();
        };
        instance.onstop = () => {
          media.getTracks().forEach((track) => track.stop());
          if (!alive(active)) return;
          clearTimeout(timer.current);
          setRecording(false);
          enqueue(
            new Blob(chunks, { type: instance.mimeType || mimeType || "audio/webm" }),
            false,
            active,
          );
        };
        instance.onerror = () => {
          if (alive(active)) {
            stop();
            setError(true);
          }
        };
        instance.start(1000);
        setRecording(true);
        timer.current = setTimeout(stop, 60_000);
      }
    } catch {
      if (alive(active)) {
        stream.current?.getTracks().forEach((track) => track.stop());
        setError(true);
      }
    } finally {
      if (alive(active)) {
        starting.current = false;
        setBusy(draining.current);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    starting.current = false;
    draining.current = false;
    failed.current = false;
    jobs.current = [];
    setRecording(false);
    setBusy(false);
    setAudio(null);
    setError(false);
    setSpeechUnavailable(false);
    return () => {
      mounted.current = false;
      epoch.current++;
      request.current?.abort();
      stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      jobs.current = [];
    };
  }, [options.identityKey]);
  return {
    recording,
    busy,
    error,
    audio,
    speechUnavailable,
    start: () => start(),
    startConversation: () => start(true),
    stop,
    retry: drain,
    discard: () => {
      jobs.current = [];
      failed.current = false;
      setAudio(null);
      setError(false);
    },
  };
};
