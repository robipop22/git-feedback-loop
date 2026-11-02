import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("widget keeps a stable submission after failure, hides internal links, and restores a receipt", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.example" });
  const previous = new Map();
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    sessionStorage: dom.window.sessionStorage, FileReader: dom.window.FileReader, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FeedbackWidget } = await import("../dist/react/index.js");
  const container = dom.window.document.getElementById("root");
  const submissions = [];
  const client = {
    async submit(value) {
      submissions.push(value);
      if (submissions.length === 1) throw new Error("Connection interrupted");
      return { id: value.id, status: "delivered", configured: true, issueUrl: "https://github.com/private/repo/issues/1" };
    },
    async status(id) { return { id, status: "delivered", configured: true }; },
    async summarize(text) { return text; },
    async transcribe() { return "Spoken text"; },
  };
  const widget = () => createElement(FeedbackWidget, { client, storageKey: "account:1", screenshots: false });
  let root = createRoot(container);
  const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  try {
    await act(async () => root.render(widget()));
    await act(async () => button("Feedback").click());
    const input = container.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, "The button is too small.");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(button("Send feedback").disabled, false);
    await act(async () => button("Send feedback").click());
    assert.equal(input.disabled, true);
    assert.ok(container.querySelector('[role="alert"]'));
    await act(async () => button("Send feedback").click());
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.match(container.textContent, /Feedback delivered/);
    assert.equal(container.querySelectorAll("a").length, 0);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(widget()));
    await act(async () => button("Feedback").click());
    assert.match(container.textContent, new RegExp(submissions[0].id));
    await act(async () => button("Send more feedback").click());
    assert.ok(container.querySelector("textarea"));
    assert.equal(sessionStorage.getItem("account:1"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
