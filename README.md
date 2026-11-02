# Feedback Loop

Collect product feedback, deliver GitHub issues, and send approved issues to any coding agent.
The package includes a React widget, browser capture helpers, issue delivery, and a GitHub CLI coordinator.
It has no runtime dependencies. React is an optional peer dependency.
Node.js 22 or later runs the server modules and CLI.

## Install

```sh
npm install git-feedback-loop
```

Use the `/react` entry for React applications.
Use the `/browser` entry for another browser framework.
Use the root entry for server delivery.
The browser entries do not import server code or the GitHub token.

## Add the widget

```tsx
import { createFeedbackClient } from "git-feedback-loop/browser";
import { FeedbackWidget } from "git-feedback-loop/react";
import workletUrl from "git-feedback-loop/worklet?url";

// Keep this client stable across renders.
const client = createFeedbackClient({ endpoint: "/api/feedback" });

export function Feedback({ userId }: { userId: string }) {
  return (
    <FeedbackWidget
      key={userId}
      client={client}
      storageKey={`product-feedback:${userId}`}
      workletUrl={workletUrl}
    />
  );
}
```

The widget accepts text and optional screenshots.
It shows a feedback reference and delivery status.
It restores the latest receipt from session storage after a reload.
It reuses the submission reference after a failed request.
After a submission starts, it freezes the submitted content until the server returns a receipt.
GitHub issue URLs remain internal to the server.

Pass `labels` to translate the widget. Pass `className` to style its container.
For an existing interface, use `useFeedbackSubmission` with your own controls.
The voice and capture helpers remain available separately.
See [the integration contract](docs/integration.md) for authentication, storage, and endpoint requirements.

## Add voice feedback

```tsx
<FeedbackWidget
  key={userId}
  client={client}
  storageKey={`product-feedback:${userId}`}
  voice
  language="en"
  transcriptionLanguage="eng"
  summarize
  workletUrl={workletUrl}
/>
```

Your server supplies transcription and optional summary endpoints.
The package does not select an AI provider.
Continuous capture creates WAV turns after one second of silence.
Local browser speech reads each response when a matching local voice exists.
Capture pauses during spoken replies by default.
With headphones, pass `allowBargeIn` to keep listening and interrupt replies with new speech.
Serve the exported worklet from the same origin when your CSP forbids blob scripts.
The user reviews the text before sending feedback.
Pass `recordingBlocked` when another application feature owns the microphone.

## Deliver an issue

```ts
import { buildFeedbackIssue, deliverFeedbackIssue } from "git-feedback-loop";

const issue = buildFeedbackIssue({
  id: savedFeedback.id,
  text: savedFeedback.text,
  createdAt: savedFeedback.createdAt,
  rating: "down",
  context: { screen: "editor", version: "1.2.0" },
});
const issueUrl = await deliverFeedbackIssue(issue, "OWNER/REPO", serverToken, {
  allowCreate: !savedFeedback.creationAttempted,
  beforeCreate: () => store.persistCreationIntent(savedFeedback.id, claimFence),
});
```

Store feedback before delivery. Persist creation intent in the awaited `beforeCreate` callback before each first POST.
The example shows the transport call. [The integration contract](docs/integration.md) defines the required database claim and retry behavior.
`deliverClaimedFeedback` handles the delivery result and retry delay after your database claims a record.
It requires callbacks to store the delivered or pending state.

Delivery scans the GitHub issue list before creating an issue.
It also finds closed issues and avoids GitHub search indexing delays.
An uncertain POST must only reconcile on later attempts.
The package does not claim exactly-once delivery across an application database and GitHub.

## Connect an agent

Install and authenticate `gh` on the coordinator host.
Label an issue `feedback:ready` after triage.

```sh
npx git-feedback-loop inbox --repo OWNER/REPO
npx git-feedback-loop run --repo OWNER/REPO -- ./my-agent-wrapper
npx git-feedback-loop run --repo OWNER/REPO --watch -- ./my-agent-wrapper
```

The wrapper receives one JSON job on stdin.
It returns one JSON result on stdout.
Agent logs go to stderr.
The coordinator stores results locally and skips unchanged issues after a restart.
It records interrupted and failed jobs for operator review.
A later title or body edit requires explicit replay approval.
See [the agent protocol](docs/agent-loop.md) and [the example wrapper](examples/agent-wrapper.mjs).
The coordinator does not post comments, merge pull requests, or deploy applications.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

The package was extracted from Medinotes.
The npm registry and GitHub releases contain installable artifacts.
Clinical rules, database encryption, authentication, translations, and the Windows UI remain in the host application.
The Windows client continues to use the same HTTP endpoints.

## Protocol and other server languages

[The version 1 protocol](docs/protocol.md) defines issue markers, escaping, receipts, and delivery reconciliation.
The npm package includes `fixtures/protocol-v1.json` for adapters in Rust or another server language.
Only the browser and React modules need to run in a JavaScript application.
Your existing backend implements authentication, persistence, media processing, and the protocol.

[The release procedure](docs/releases.md) describes npm publication.
