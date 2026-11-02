import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFeedbackIssue,
  deliverFeedbackIssue,
  FeedbackDeliveryError,
  deliverClaimedFeedback,
} from "../dist/index.js";
import {
  createFeedbackClient,
  FeedbackClientError,
  FeedbackTurnBuffer,
} from "../dist/browser/index.js";

const input = {
  id: "test-id",
  text: "The heading is missing.\n```\n<!-- unsafe -->",
  createdAt: "2026-11-02T10:00:00Z",
  context: { version: 3 },
};
const issue = buildFeedbackIssue(input);
test("issue protocol preserves literal feedback and only includes selected fields", () => {
  const built = buildFeedbackIssue({
    ...input,
    patient: "PRIVATE",
    token: "SECRET",
    context: { version: 3, literal: "```" },
  });
  assert.ok(built.body.startsWith("<!-- feedback-loop:test-id -->"));
  assert.ok(built.body.includes("<!-- feedback-loop:v1 -->"));
  assert.ok(built.body.includes("    <!-- unsafe -->"));
  assert.ok(!built.body.includes("PRIVATE"));
  assert.ok(!built.body.includes("SECRET"));
  assert.ok(built.body.includes('"literal": "\\u0060\\u0060\\u0060"'));
  assert.throws(() => buildFeedbackIssue({ ...input, id: "x -->" }));
  assert.throws(() =>
    buildFeedbackIssue({ ...input, links: [{ label: "Open", url: "javascript:alert(1)" }] }),
  );
});
test("delivery recovers an existing closed issue without creating a duplicate", async () => {
  const calls = [];
  const url = await deliverFeedbackIssue(issue, "owner/repo", "secret", {
    request: async (url, init) => {
      calls.push(init);
      return Response.json([{ number: 17, body: `${issue.marker}\nOld issue`, state: "closed" }]);
    },
  });
  assert.equal(url, "https://github.com/owner/repo/issues/17");
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].method, "POST");
});
test("delivery completes pagination before POST and does not trust a returned URL", async () => {
  const calls = [];
  const url = await deliverFeedbackIssue(issue, "owner/repo", "secret", {
    request: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1)
        return Response.json(
          Array.from({ length: 100 }, (_, number) => ({ number, body: "Other" })),
        );
      return Response.json(
        init.method === "POST" ? { number: 18, html_url: "https://wrong.invalid" } : [],
      );
    },
  });
  assert.equal(url, "https://github.com/owner/repo/issues/18");
  assert.match(calls[1].url, /page=2/);
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers.Authorization, "Bearer secret");
  assert.ok(!calls[2].init.body.includes("secret"));
});
test("uncertain POSTs remain reconciliation-only while definite rejections permit a retry", async () => {
  for (const status of [403, 429, 500]) {
    await assert.rejects(
      deliverFeedbackIssue(issue, "owner/repo", "secret", {
        request: async (_url, init) =>
          init.method === "POST" ? new Response("PRIVATE", { status }) : Response.json([]),
      }),
      (error) =>
        error instanceof FeedbackDeliveryError &&
        error.creationMayHaveSucceeded === (status === 500) &&
        !error.message.includes("PRIVATE"),
    );
  }
  assert.equal(
    await deliverFeedbackIssue(issue, "owner/repo", "secret", {
      allowCreate: false,
      request: async (_url, init) => {
        assert.notEqual(init.method, "POST");
        return Response.json([]);
      },
    }),
    null,
  );
  let pending;
  await deliverClaimedFeedback({
    issue,
    repository: "owner/repo",
    token: "secret",
    previousCreationAttempted: true,
    previousAttempts: 0,
    deliver: async () => {
      throw new FeedbackDeliveryError(false);
    },
    delivered: async () => assert.fail("Unexpected delivery"),
    pending: async (value) => {
      pending = value;
    },
  });
  assert.equal(pending.creationAttempted, true);
  assert.ok(pending.nextAttemptAt.getTime() >= Date.now() + 29_000);
});
test("a full reconciliation window stays pending and does not POST", async () => {
  let calls = 0;
  await assert.rejects(
    deliverFeedbackIssue(issue, "owner/repo", "secret", {
      request: async (_url, init) => {
        calls++;
        assert.notEqual(init.method, "POST");
        return Response.json(
          Array.from({ length: 100 }, (_, number) => ({ number, body: "Other" })),
        );
      },
    }),
    FeedbackDeliveryError,
  );
  assert.equal(calls, 20);
});
test("client uses same-origin routes, credentials, and the same caller-supplied reference", async () => {
  const calls = [];
  const client = createFeedbackClient({
    endpoint: "/api/product-feedback/",
    request: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ id: "stable", status: "pending", configured: true });
    },
  });
  const submission = { id: "stable", text: "Feedback" };
  await client.submit(submission);
  await client.submit(submission);
  await client.status("stable");
  assert.equal(calls[0].url, "/api/product-feedback");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.equal(calls[2].url, "/api/product-feedback/stable");
  await assert.rejects(
    createFeedbackClient({ request: async () => new Response("PRIVATE", { status: 401 }) }).submit(
      submission,
    ),
    FeedbackClientError,
  );
});
test("voice turns produce bounded WAV files and stop after silence", () => {
  const turns = [];
  const buffer = new FeedbackTurnBuffer(
    (audio) => turns.push(audio),
    () => {},
  );
  const speech = new Uint8Array(9600);
  const view = new DataView(speech.buffer);
  for (let i = 0; i < 4800; i++) view.setInt16(i * 2, 4000, true);
  buffer.push(speech);
  for (let i = 0; i < 5; i++) buffer.push(new Uint8Array(9600));
  assert.equal(turns.length, 1);
  assert.equal(new TextDecoder().decode(turns[0].subarray(0, 4)), "RIFF");
  assert.equal(new DataView(turns[0].buffer).getUint32(40, true), turns[0].length - 44);
  buffer.flush();
  assert.equal(turns.length, 1);
});
