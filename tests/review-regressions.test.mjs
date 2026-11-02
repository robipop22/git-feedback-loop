import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeedbackIssue } from "../dist/index.js";
import { startFeedbackConversation } from "../dist/browser/index.js";

test("feedback normalizes CR before indenting user text", () => {
  const issue = buildFeedbackIssue({
    id: "cr-test",
    text: "a\r## Forged trace\r@org/team\r\nend",
    createdAt: "2026-11-02T10:00:00Z",
  });
  assert.equal(issue.body.includes("\r"), false);
  assert.ok(issue.body.includes("    a\n    ## Forged trace\n    @org/team\n    end"));
});

test("conversation can load a same-origin worklet without creating a blob URL", async () => {
  const previousContext = globalThis.AudioContext;
  const previousWorklet = globalThis.AudioWorkletNode;
  const previousCreate = URL.createObjectURL;
  let moduleUrl;
  let createdBlob = false;
  const node = () => ({ connect() {}, disconnect() {} });
  globalThis.AudioContext = class {
    audioWorklet = {
      addModule: async (url) => {
        moduleUrl = url;
      },
    };
    destination = {};
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: { value: 1 } });
    async resume() {}
    async close() {}
  };
  globalThis.AudioWorkletNode = class {
    port = {
      onmessage: null,
      postMessage: () => this.port.onmessage?.({ data: { type: "flushed" } }),
    };
    connect() {}
    disconnect() {}
  };
  URL.createObjectURL = (...args) => {
    createdBlob = true;
    return previousCreate(...args);
  };
  let stop;
  try {
    stop = await startFeedbackConversation(
      {},
      () => {},
      () => {},
      { workletUrl: "/assets/pcm.worklet.js" },
    );
    assert.equal(moduleUrl, "/assets/pcm.worklet.js");
    assert.equal(createdBlob, false);
  } finally {
    await stop?.();
    globalThis.AudioContext = previousContext;
    globalThis.AudioWorkletNode = previousWorklet;
    URL.createObjectURL = previousCreate;
  }
});
