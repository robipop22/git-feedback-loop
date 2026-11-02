import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildFeedbackIssue,
  deliverFeedbackIssue,
  deliverClaimedFeedback,
  FeedbackDeliveryError,
} from "../dist/index.js";
import { isFeedbackIssue } from "../dist/agent.js";

const issue = buildFeedbackIssue({
  id: "delivery-test",
  text: "Synthetic feedback",
  createdAt: "2026-11-02T10:00:00Z",
});
test("language-neutral golden fixtures match complete issue output and coordinator recognition", async () => {
  const fixtures = JSON.parse(
    await readFile(new URL("../fixtures/protocol-v1.json", import.meta.url), "utf8"),
  );
  for (const fixture of fixtures.cases) {
    const built = buildFeedbackIssue(fixture.input, fixture.options);
    assert.deepEqual(built, fixture.expected, fixture.name);
    assert.equal(
      isFeedbackIssue({
        number: 1,
        title: built.title,
        body: built.body,
        html_url: "https://github.com/owner/repo/issues/1",
      }),
      true,
    );
  }
});
test("a sorted page older than the creation window permits creation after all markers are checked", async () => {
  const events = [];
  const list = Array.from({ length: 100 }, (_, number) => ({
    number: number + 1,
    body: "Other",
    created_at: "2026-11-02T09:40:00Z",
  }));
  const request = async (url, init) => {
    if (init.method === "POST") {
      events.push("post");
      return Response.json({ number: 200 });
    }
    events.push("list");
    assert.match(url, /since=2026-11-02T09%3A50%3A00/);
    return Response.json(list);
  };
  const url = await deliverFeedbackIssue(issue, "owner/repo", "test-key", {
    request,
    beforeCreate: async () => events.push("intent"),
  });
  assert.equal(url, "https://github.com/owner/repo/issues/200");
  assert.deepEqual(events, ["list", "intent", "post"]);
  list[99].body = issue.marker;
  events.length = 0;
  assert.equal(
    await deliverFeedbackIssue(issue, "owner/repo", "test-key", { request }),
    "https://github.com/owner/repo/issues/100",
  );
  assert.deepEqual(events, ["list"]);
});
test("a failed intent callback prevents the POST and reports only a safe delivery failure", async () => {
  const calls = [];
  await assert.rejects(
    deliverFeedbackIssue(issue, "owner/repo", "test-key", {
      request: async (_url, init) => {
        calls.push(init.method);
        return Response.json([]);
      },
      beforeCreate: async () => {
        throw new Error("PRIVATE DATABASE DETAIL");
      },
    }),
    (error) =>
      error instanceof FeedbackDeliveryError &&
      !error.creationMayHaveSucceeded &&
      !error.message.includes("PRIVATE"),
  );
  assert.deepEqual(calls, [undefined]);
});
test("uncertain, rejected, and bounded-scan outcomes expose an operator signal without credentials", async () => {
  for (const reason of ["reconciling", "rejected", "scan_limit"]) {
    let pending;
    await deliverClaimedFeedback({
      issue,
      repository: "owner/repo",
      token: "test-key",
      previousCreationAttempted: true,
      previousAttempts: 4,
      deliver: async () => {
        if (reason === "reconciling") return null;
        throw new FeedbackDeliveryError(false, reason, 401);
      },
      delivered: async () => assert.fail("Unexpected issue"),
      pending: async (value) => {
        pending = value;
      },
    });
    assert.equal(pending.reason, reason);
    assert.equal(pending.attentionRequired, true);
    assert.equal(pending.creationAttempted, true);
    assert.ok(!JSON.stringify(pending).includes("test-key"));
  }
});
