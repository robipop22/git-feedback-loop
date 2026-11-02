# Application integration

## Server endpoints

The browser client uses cookies through `credentials: include`.
Implement these routes in your existing authenticated server.
Check authorization and request origin before accepting a mutation.
Apply your application's request limits and rate limits.

| Route                           | Request                               | Response                                         |
| ------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `POST /api/feedback`            | `{ id, text, screenshot? }`           | `{ id, status, configured, attentionRequired? }` |
| `GET /api/feedback/:id`         | No body                               | `{ id, status, configured, attentionRequired? }` |
| `POST /api/feedback/transcribe` | Multipart `audio` file and `language` | `{ text }`                                       |
| `POST /api/feedback/summarize`  | `{ text }`                            | `{ summary }`                                    |

Only the first two routes are required for text feedback.
Disable `screenshots` when the server does not support attachments.
Enable `voice` only when transcription is available.
Enable `summarize` only when summary generation is available.
Use standard non-2xx HTTP statuses for failures.
The client throws `FeedbackClientError` with the HTTP status.

Check that the submission ID is a UUID.
Reject empty text and text longer than 8,000 characters.
Accept PNG or JPEG screenshots only. Check decoded bytes and file signatures on the server.
Limit each screenshot to 2 MB and each audio upload to 8 MB.
Do not trust a browser MIME type or file extension.
Your transcription adapter maps `transcriptionLanguage` to its provider's language identifier.
A successful summary response must contain complete text that the user can review.

## Durable records

Store the following fields in the application's database:

- Feedback ID and authenticated owner ID.
- Immutable submitted text and optional attachment reference.
- Destination repository and submission time.
- Delivery payload, status, and internal issue URL.
- Creation intent, attempt count, and next attempt time.

Use a unique constraint on the feedback ID.
Return the first stored record when the same owner retries an ID.
Reject an ID that belongs to another owner.
Never replace the first submission with changed retry content.
Check the owner before returning a receipt or attachment.
Return `configured: false` when delivery credentials are absent.
Keep the feedback pending until delivery becomes available.

The issue builder only serializes explicit input fields.
The application must choose which context fields may leave the application.
Free text and screenshots are not automatically anonymized.
Keep credentials, private documents, and internal traces outside the issue payload.
Store protected attachment links instead of access-bearing URLs.
The receipt must omit the internal issue URL.

## Database claim and delivery

1. Start a transaction.
2. Lock one due pending row with `FOR UPDATE SKIP LOCKED`, or an equivalent atomic claim.
3. Preserve its previous creation intent and attempt count.
4. Increment the attempt count.
5. Set a delivery lease of at least two minutes and a unique claim fence.
6. Commit the transaction.
7. Call `deliverClaimedFeedback` with the previous values.
8. Persist creation intent in its awaited `beforeCreate` callback.
9. Store the delivered or pending result only while the claim fence still matches.

```ts
await deliverClaimedFeedback({
  issue: buildFeedbackIssue(claimed.payload),
  repository: claimed.repository,
  token: serverToken,
  previousCreationAttempted: claimed.previousCreationAttempted,
  previousAttempts: claimed.previousAttempts,
  beforeCreate: () => store.markCreationIntent(claimed.id, claimed.fence),
  delivered: (issueUrl) => store.markDelivered(claimed.id, claimed.fence, issueUrl),
  pending: (state) => store.defer(claimed.id, claimed.fence, state),
});
```

Existing adapters may continue to persist intent in the claim transaction.
The callback narrows the interval before the POST but cannot eliminate a crash after the intent commit.
`pending` includes `reason` and `attentionRequired`.
Persist both fields. Expose the review signal to operators and in the receipt.
The widget stops automatic polling when a receipt includes `attentionRequired: true`.

Run retries at startup and every 30 seconds.
The retry delay grows from 30 seconds to one hour.
Run each attempt within its lease. Fence a late completion if your store permits lease overlap.
The HTTP transport has a 20-second overall deadline and an 8-second deadline per request.
It scans at most 2,000 recently updated issues.
A scan that cannot establish absence leaves delivery pending.

A definite GitHub rejection permits a later creation attempt.
An uncertain POST preserves creation intent and only searches for the existing issue.
A process crash before sending the recorded POST can leave feedback pending indefinitely.
Inspect GitHub before an operator clears that record's creation intent.
Never clear creation intent merely because one issue-list response omits the marker.

## GitHub credentials

Use a server-side token with repository metadata access and Issues read/write permission.
Configure the destination repository on the server.
Do not accept the destination repository or token from browser input.
A private destination repository can receive feedback from a public application.
Keep the feedback destination private when its contents require private access.
The package source can remain public independently.

## Existing applications

The framework adapter owns authentication, persistence, and provider selection.
You can retain your existing UI and import individual browser helpers.
`useFeedbackVoice(onText, language, transcribe)` accepts a transcription callback.
The callback returns text. `onText` returns the optional text for the browser to speak.
The `language` argument uses a browser language prefix, such as `en` or `sv`.

## Host UI and browser policy

`useFeedbackSubmission({ client, storageKey })` owns retries, receipt restoration, polling, and reset behavior.
It returns `receipt`, `busy`, `submitted`, `error`, `editableError`, `submit`, `refresh`, and `reset`.
Build your form with the host's shared UI primitives.
Disable editing while `submitted` is true. After a definite validation rejection, the hook clears that state.
Keep editing locked after network errors and retry the immutable stored payload.
The default widget exposes the same behavior.

Use both the account ID and organization ID in `storageKey` and the component's React `key`.
A changed storage key also clears draft fields and cancels voice work.
Hosts should keep their structural `FeedbackClient` object stable across renders.

The worklet asset is exported as `git-feedback-loop/worklet`.
Vite hosts can import `git-feedback-loop/worklet?url` and pass its same-origin URL as `workletUrl`.
Other bundlers can copy the asset to their public directory.
Do not weaken the application's CSP to enable blob scripts.

Voice capture pauses while local speech plays by default.
Use headphones before enabling `allowBargeIn`.
Browser echo cancellation does not reliably remove operating-system speech output.
The package retains a successful transcription when applying its text fails, so retry does not repeat the provider call.
Host callbacks must ignore or cancel their own pending asynchronous UI updates when the account changes.
