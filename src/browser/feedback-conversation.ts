import { FeedbackTurnBuffer } from "./feedback-turn-buffer.js";
import { pcmWorkletSource } from "./pcm-worklet.js";

export const startFeedbackConversation = async (media: MediaStream, onTurn: (blob: Blob) => void, onSpeech: () => void) => {
  const context = new AudioContext();
  const url = URL.createObjectURL(new Blob([pcmWorkletSource], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
    const source = context.createMediaStreamSource(media);
    const worklet = new AudioWorkletNode(context, "feedback-loop-pcm-capture");
    const silent = context.createGain(); silent.gain.value = 0;
    const buffer = new FeedbackTurnBuffer((wav) => onTurn(new Blob([wav as BlobPart], { type: "audio/wav" })), onSpeech);
    source.connect(worklet); worklet.connect(silent); silent.connect(context.destination);
    await context.resume();
    let stopped = false;
    let finish: (() => void) | undefined;
    worklet.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) buffer.push(new Uint8Array(event.data));
      if (event.data?.type === "flushed") finish?.();
    };
    return async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        finish = () => { clearTimeout(timer); resolve(); };
        worklet.port.postMessage({ type: "flush" });
      });
      buffer.flush(); source.disconnect(); worklet.disconnect(); silent.disconnect();
      await context.close();
    };
  } catch (error) { await context.close(); throw error; }
  finally { URL.revokeObjectURL(url); }
};

// Local voices keep feedback out of an additional speech service.
export const speakFeedback = (text: string, language: string) => {
  if (!("speechSynthesis" in window)) return false;
  const voice = window.speechSynthesis.getVoices().find((voice) => voice.localService && voice.lang.startsWith(language));
  if (!voice) return false;
  const utterance = new SpeechSynthesisUtterance(text); utterance.voice = voice;
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance);
  return true;
};
export const stopFeedbackSpeech = () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
