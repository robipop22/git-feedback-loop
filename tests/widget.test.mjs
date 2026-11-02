import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { FeedbackClientError } from "../dist/browser/index.js";

async function harness(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.example" });
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    sessionStorage: dom.window.sessionStorage,
    FileReader: dom.window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FeedbackWidget, useFeedbackSubmission } = await import("../dist/react/index.js");
  const container = document.getElementById("root");
  let root = createRoot(container);
  const button = (label) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  const type = async (value) =>
    act(async () => {
      const input = container.querySelector("textarea");
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(
        input,
        value,
      );
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const defaultClient = {
    async submit(input) {
      return { id: input.id, status: "delivered", configured: true };
    },
    async status(id) {
      return { id, status: "delivered", configured: true };
    },
    async summarize(text) {
      return text;
    },
    async transcribe() {
      return "Spoken text";
    },
  };
  const render = async (client, props = {}) =>
    act(async () =>
      root.render(
        createElement(FeedbackWidget, {
          client,
          storageKey: "account:1",
          screenshots: false,
          ...props,
        }),
      ),
    );
  try {
    await run({
      dom,
      container,
      button,
      type,
      act,
      createElement,
      FeedbackWidget,
      useFeedbackSubmission,
      defaultClient,
      render,
      rawRender: async (node) => act(async () => root.render(node)),
      remount: async () => {
        await act(async () => root.unmount());
        root = createRoot(container);
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("widget keeps immutable network retries, hides issue links, and restores a receipt", async () =>
  harness(async (h) => {
    const submissions = [];
    const client = {
      ...h.defaultClient,
      async submit(input) {
        submissions.push(input);
        if (submissions.length === 1) throw new Error("Interrupted");
        return {
          id: input.id,
          status: "delivered",
          configured: true,
          issueUrl: "https://github.com/private/repo/issues/1",
        };
      },
    };
    await h.render(client);
    await h.act(async () => h.button("Feedback").click());
    await h.type("The button is too small.");
    await h.act(async () => h.button("Send feedback").click());
    assert.equal(h.container.querySelector("textarea").disabled, true);
    await h.act(async () => h.button("Send feedback").click());
    assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(h.container.querySelectorAll("a").length, 0);
    await h.remount();
    await h.render(client);
    await h.act(async () => h.button("Feedback").click());
    assert.match(h.container.textContent, new RegExp(submissions[0].id));
    await h.act(async () => h.button("Send more feedback").click());
    assert.ok(h.container.querySelector("textarea"));
    assert.equal(sessionStorage.getItem("account:1"), null);
  }));

test("a 413 unlocks editing and the corrected submission gets a new ID", async () =>
  harness(async (h) => {
    const submissions = [];
    const client = {
      ...h.defaultClient,
      async submit(input) {
        submissions.push(input);
        if (submissions.length === 1) throw new FeedbackClientError(413);
        return { id: input.id, status: "delivered", configured: true };
      },
    };
    await h.render(client);
    await h.act(async () => h.button("Feedback").click());
    await h.type("Rejected content");
    await h.act(async () => h.button("Send feedback").click());
    assert.equal(h.container.querySelector("textarea").disabled, false);
    assert.match(h.container.textContent, /Edit the feedback/);
    await h.type("Corrected content");
    await h.act(async () => h.button("Send feedback").click());
    assert.notEqual(submissions[0].id, submissions[1].id);
    assert.equal(submissions[1].text, "Corrected content");
  }));

test("a late status response cannot replace a reset or a newer submission", async () =>
  harness(async (h) => {
    let resolveStatus;
    let calls = 0;
    let current;
    sessionStorage.setItem("account:1", "old-reference");
    const client = {
      ...h.defaultClient,
      async status(id) {
        if (++calls === 1) return { id, status: "delivered", configured: true };
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      },
    };
    function Probe() {
      current = h.useFeedbackSubmission({ client, storageKey: "account:1", polling: false });
      return null;
    }
    await h.rawRender(h.createElement(Probe));
    assert.equal(current.receipt.id, "old-reference");
    let pending;
    await h.act(async () => {
      pending = current.refresh();
    });
    await h.act(async () => current.reset());
    await h.act(async () => current.submit({ text: "A new report" }));
    const next = current.receipt.id;
    await h.act(async () => {
      resolveStatus({ id: "old-reference", status: "delivered", configured: true });
      await pending;
    });
    assert.equal(current.receipt.id, next);
  }));

test("dead receipt references are removed and organization changes clear the form", async () =>
  harness(async (h) => {
    sessionStorage.setItem("account:1", "expired");
    const client = {
      ...h.defaultClient,
      async status() {
        throw new FeedbackClientError(404);
      },
    };
    await h.render(client);
    assert.equal(sessionStorage.getItem("account:1"), null);
    await h.act(async () => h.button("Feedback").click());
    await h.type("Private draft from organization one");
    await h.render(client, { storageKey: "account:2" });
    assert.equal(h.container.querySelector("textarea").value, "");
    assert.equal(h.container.querySelector("textarea").disabled, false);
  }));
