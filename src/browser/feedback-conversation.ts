import { FeedbackTurnBuffer } from "./feedback-turn-buffer.js";
import { pcmWorkletSource } from "./pcm-worklet.js";

export type FeedbackConversation = (() => Promise<void>) & {
  pause: () => void;
  resume: () => void;
};
export type ConversationOptions = { workletUrl?: string };

export const startFeedbackConversation = async (
  media: MediaStream,
  onTurn: (blob: Blob) => void,
  onSpeech: () => void,
  options: ConversationOptions = {},
): Promise<FeedbackConversation> => {
  const context = new AudioContext();
  const ownedUrl = options.workletUrl
    ? undefined
    : URL.createObjectURL(new Blob([pcmWorkletSource], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(options.workletUrl ?? ownedUrl!);
    const source = context.createMediaStreamSource(media);
    const worklet = new AudioWorkletNode(context, "feedback-loop-pcm-capture");
    const silent = context.createGain();
    silent.gain.value = 0;
    const buffer = new FeedbackTurnBuffer(
      (wav) => onTurn(new Blob([wav as BlobPart], { type: "audio/wav" })),
      onSpeech,
    );
    let stopped = false;
    let paused = false;
    let finish: (() => void) | undefined;
    worklet.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer && !paused) buffer.push(new Uint8Array(event.data));
      if (event.data?.type === "flushed") finish?.();
      if (event.data?.type === "resumed") paused = false;
    };
    source.connect(worklet);
    worklet.connect(silent);
    silent.connect(context.destination);
    await context.resume();
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          finish = () => {
            clearTimeout(timer);
            resolve();
          };
          worklet.port.postMessage({ type: "flush" });
        });
        buffer.flush();
      } finally {
        source.disconnect();
        worklet.disconnect();
        silent.disconnect();
        await context.close();
      }
    };
    return Object.assign(stop, {
      pause: () => {
        if (!stopped) {
          paused = true;
          buffer.flush();
          worklet.port.postMessage({ type: "pause" });
        }
      },
      resume: () => {
        if (!stopped) worklet.port.postMessage({ type: "resume" });
      },
    });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  } finally {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
  }
};

const localVoice = (language: string) =>
  window.speechSynthesis
    .getVoices()
    .find(
      (voice) => voice.localService && voice.lang.toLowerCase().startsWith(language.toLowerCase()),
    );

/** Waits for Chrome's initial asynchronous voice inventory. */
export const prepareFeedbackSpeech = async (language: string, timeoutMs = 1000) => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  const speech = window.speechSynthesis;
  if (speech.getVoices().length || !speech.addEventListener) return Boolean(localVoice(language));
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      speech.removeEventListener("voiceschanged", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    speech.addEventListener("voiceschanged", finish, { once: true });
    if (speech.getVoices().length) finish();
  });
  return Boolean(localVoice(language));
};

let finishSpeech: (() => void) | undefined;
export const stopFeedbackSpeech = () => {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  const finish = finishSpeech;
  finishSpeech = undefined;
  finish?.();
};

// Local voices keep feedback out of an additional speech service.
export const speakFeedback = (
  text: string,
  language: string,
  options: { onStart?: () => void; onEnd?: () => void } = {},
) => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  const voice = localVoice(language);
  if (!voice) return false;
  stopFeedbackSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      if (finishSpeech === finish) finishSpeech = undefined;
      options.onEnd?.();
    }
  };
  finishSpeech = finish;
  utterance.onend = finish;
  utterance.onerror = finish;
  try {
    options.onStart?.();
    window.speechSynthesis.speak(utterance);
  } catch {
    finish();
    return false;
  }
  return true;
};
