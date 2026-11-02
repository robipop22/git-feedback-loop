import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  prepareFeedbackSpeech,
  captureFeedbackScreenshot,
  readFeedbackScreenshot,
} from "../dist/browser/index.js";

async function harness(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.example" });
  const previous = new Map();
  let stopped = 0;
  let port;
  let utterance;
  const controls = [];
  const media = {
    getTracks: () => [
      {
        stop() {
          stopped++;
        },
      },
    ],
  };
  const node = () => ({ connect() {}, disconnect() {} });
  const synth = new dom.window.EventTarget();
  synth.getVoices = () => [{ localService: true, lang: "en-US" }];
  synth.cancel = () => {};
  synth.speak = (value) => {
    utterance = value;
  };
  Object.defineProperty(dom.window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    value: { getUserMedia: async () => media },
    configurable: true,
  });
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio"]) });
      this.onstop?.();
    }
  }
  const values = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    MediaRecorder: Recorder,
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    AudioContext: class {
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 1 } });
      async resume() {}
      async close() {}
    },
    AudioWorkletNode: class {
      constructor() {
        port = this.port;
      }
      port = {
        onmessage: null,
        postMessage: ({ type }) => {
          controls.push(type);
          if (type === "flush") this.port.onmessage?.({ data: { type: "flushed" } });
          if (type === "resume") this.port.onmessage?.({ data: { type: "resumed" } });
        },
      };
      connect() {}
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useFeedbackVoice, FeedbackWidget } = await import("../dist/react/index.js");
  const root = createRoot(document.getElementById("root"));
  let api;
  let isMounted = true;
  const render = async ({
    onText = async (text) => text,
    transcribe = async () => "Speech",
    options = {},
  } = {}) => {
    function Probe() {
      api = useFeedbackVoice(onText, "en", transcribe, options);
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
  };
  // Keep the component type stable so identity changes test the hook instead of a remount.
  let props;
  function StableProbe() {
    api = useFeedbackVoice(props.onText, "en", props.transcribe, props.options);
    return null;
  }
  const stableRender = async (value) => {
    props = value;
    await act(async () => root.render(createElement(StableProbe)));
  };
  const emitTurn = () => {
    const frame = new Int16Array(4800);
    frame.fill(5000);
    port.onmessage({ data: frame.buffer });
    for (let i = 0; i < 5; i++) port.onmessage({ data: new ArrayBuffer(9600) });
  };
  try {
    await run({
      dom,
      media,
      synth,
      controls,
      act,
      render,
      stableRender,
      api: () => api,
      stopped: () => stopped,
      utterance: () => utterance,
      emitTurn,
      widgetRender: async (client) =>
        act(async () =>
          root.render(
            createElement(FeedbackWidget, {
              client,
              storageKey: "voice-widget",
              voice: true,
              screenshots: false,
              workletUrl: "/worklet.js",
            }),
          ),
        ),
      unmount: async () => {
        await act(async () => root.unmount());
        isMounted = false;
      },
    });
  } finally {
    if (isMounted) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  }
}

test("a failed text callback retries cached transcription without another provider call", async () =>
  harness(async (h) => {
    let transcriptions = 0;
    let callbacks = 0;
    await h.render({
      transcribe: async () => {
        transcriptions++;
        return "Speech";
      },
      onText: async () => {
        if (++callbacks === 1) throw new Error("Text limit");
        return "Accepted";
      },
    });
    await h.act(async () => await h.api().start());
    await h.act(async () => h.api().stop());
    assert.equal(h.api().error, true);
    assert.ok(h.api().audio);
    assert.ok(h.stopped() > 0);
    await h.act(async () => await h.api().retry());
    assert.equal(transcriptions, 1);
    assert.equal(callbacks, 2);
    assert.equal(h.api().audio, null);
    assert.equal(h.api().error, false);
  }));

test("unmount aborts transcription and ignores its late result", async () =>
  harness(async (h) => {
    let finish;
    let signal;
    let callbacks = 0;
    await h.render({
      transcribe: async (_blob, _language, value) => {
        signal = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      onText: async () => {
        callbacks++;
      },
    });
    await h.act(async () => await h.api().start());
    await h.act(async () => h.api().stop());
    await h.unmount();
    assert.equal(signal.aborted, true);
    finish("Late speech");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(callbacks, 0);
  }));

test("an identity switch stops a late microphone stream without starting capture", async () =>
  harness(async (h) => {
    let finish;
    h.dom.window.navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const callbacks = { onText: async (text) => text, transcribe: async () => "Speech" };
    await h.stableRender({ ...callbacks, options: { identityKey: "one" } });
    let pending;
    await h.act(async () => {
      pending = h.api().start();
    });
    await h.stableRender({ ...callbacks, options: { identityKey: "two" } });
    await h.act(async () => {
      finish(h.media);
      await pending;
    });
    assert.equal(h.api().recording, false);
    assert.ok(h.stopped() > 0);
    assert.equal(h.api().busy, false);
  }));

test("continuous capture pauses during spoken replies and resumes on completion", async () =>
  harness(async (h) => {
    let transcriptions = 0;
    await h.render({
      transcribe: async () => {
        transcriptions++;
        return "Speech";
      },
      options: { workletUrl: "/assets/pcm.worklet.js" },
    });
    await h.act(async () => await h.api().startConversation());
    await h.act(async () => h.emitTurn());
    assert.ok(h.controls.includes("pause"));
    assert.ok(h.utterance());
    await h.act(async () => h.emitTurn());
    assert.equal(transcriptions, 1);
    await h.act(async () => h.utterance().onend());
    assert.ok(h.controls.includes("resume"));
    await h.act(async () => h.emitTurn());
    assert.equal(transcriptions, 2);
  }));

test("local speech waits for the initial voiceschanged event", async () =>
  harness(async (h) => {
    let ready = false;
    h.synth.getVoices = () => (ready ? [{ localService: true, lang: "en-US" }] : []);
    const pending = prepareFeedbackSpeech("en");
    ready = true;
    h.synth.dispatchEvent(new h.dom.window.Event("voiceschanged"));
    assert.equal(await pending, true);
  }));

test("screen capture always releases tracks when video capture fails", async () =>
  harness(async (h) => {
    h.dom.window.navigator.mediaDevices.getDisplayMedia = async () => h.media;
    h.dom.window.HTMLMediaElement.prototype.play = async () => {
      throw new Error("Synthetic video failure");
    };
    await assert.rejects(captureFeedbackScreenshot(), /Synthetic/);
    assert.equal(h.stopped(), 1);
    await assert.rejects(
      readFeedbackScreenshot(new h.dom.window.File(["data"], "bad.svg", { type: "image/svg+xml" })),
      /PNG or JPEG/,
    );
  }));

test("headphone barge-in keeps capture active and new speech interrupts a reply", async () =>
  harness(async (h) => {
    let cancelled = 0;
    h.synth.cancel = () => {
      cancelled++;
    };
    await h.render({ options: { workletUrl: "/worklet.js", allowBargeIn: true } });
    await h.act(async () => await h.api().startConversation());
    await h.act(async () => h.emitTurn());
    assert.equal(h.controls.includes("pause"), false);
    const previous = cancelled;
    await h.act(async () => h.emitTurn());
    assert.ok(cancelled > previous);
  }));

test("an over-length voice turn leaves the draft editable and retries cached text after correction", async () =>
  harness(async (h) => {
    let transcriptions = 0;
    const client = {
      async submit(input) {
        return { id: input.id, status: "pending", configured: false };
      },
      async status(id) {
        return { id, status: "pending", configured: false };
      },
      async transcribe() {
        transcriptions++;
        return "01234567890123456789";
      },
      async summarize(text) {
        return text;
      },
    };
    await h.widgetRender(client);
    const button = (text) =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === text);
    await h.act(async () => button("Feedback").click());
    const type = async (value) =>
      h.act(async () => {
        const input = document.querySelector("textarea");
        Object.getOwnPropertyDescriptor(
          h.dom.window.HTMLTextAreaElement.prototype,
          "value",
        ).set.call(input, value);
        input.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
      });
    const original = "x".repeat(7990);
    await type(original);
    await h.act(async () => button("Start conversation").click());
    await h.act(async () => h.emitTurn());
    assert.equal(document.querySelector("textarea").value, original);
    assert.ok(button("Retry audio"));
    await type("Corrected draft");
    await h.act(async () => button("Retry audio").click());
    assert.equal(transcriptions, 1);
    assert.equal(document.querySelector("textarea").value, "Corrected draft\n01234567890123456789");
  }));
