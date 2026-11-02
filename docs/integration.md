# Application integration

## Server endpoints

The browser client uses cookies through `credentials: include`.
Implement these routes in your existing authenticated server.
Check authorization and request origin before accepting a mutation.
Apply your application's request limits and rate limits.

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/feedback` | `{ id, text, screenshot? }` | `{ id, status, configured }` |
| `GET /api/feedback/:id` | No body | `{ id, status, configured }` |
| `POST /api/feedback/transcribe` | Multipart `audio` file and `language` | `{ text }` |
| `POST /api/feedback/summarize` | `{ text }` | `{ summary }` |

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
3. Preserve the row's previous creation intent and attempt count.
4. Set `creationAttempted = true` before network I/O.
5. Increment the attempt count.
6. Set a delivery lease of at least two minutes.
7. Commit the transaction.
8. Call `deliverClaimedFeedback` with the previous values.
9. Store its delivered or pending result through the callbacks.

```ts
await deliverClaimedFeedback({
  issue: buildFeedbackIssue(claimed.payload),
  repository: claimed.repository,
  token: serverToken,
  previousCreationAttempted: claimed.previousCreationAttempted,
  previousAttempts: claimed.previousAttempts,
  delivered: issueUrl => store.markDelivered(claimed.id, issueUrl),
  pending: state => store.defer(claimed.id, state),
});
```

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
