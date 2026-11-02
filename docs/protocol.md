# Feedback Loop protocol, version 1

This protocol connects browser clients, application adapters, GitHub issues, and agent coordinators.
An application can implement its server adapter in any language.
The JavaScript server exports are reference implementations. They do not require a separate JavaScript backend in other applications.

## Issue reference

The first line is an immutable reference marker:

```text
<!-- NAMESPACE:ID -->
```

The namespace contains 1–80 ASCII letters, digits, underscores, or hyphens.
The ID contains 1–200 characters from the same set.
The default namespace is `feedback-loop`.
Use a globally unique ID. The browser submission contract uses a UUID.

The next nonblank line is the version marker:

```text
<!-- feedback-loop:v1 -->
```

The reference builder places one blank line between these markers.
The coordinator accepts whitespace between them.
The coordinator requires both markers by default.
`--legacy-namespace NAME` explicitly permits reference markers without the version marker for that namespace.
Legacy support never changes delivery reconciliation markers.

## Body

The reference builder joins the following parts with two LF characters:

1. The reference marker.
2. The version marker.
3. An optional `## Rating` section with `Thumbs up` or `Thumbs down`.
4. The `## Feedback` section.
5. The `## Trace reference` heading.
6. A fenced JSON block with the trace fields.
7. Optional application-controlled links and a notice.

Normalize CRLF and bare CR to LF before formatting feedback text.
Indent every feedback line with four spaces, including blank lines.
Use `No additional notes.` when the input text is empty.
This indentation keeps submitted Markdown and HTML literal.

The trace object contains only explicitly selected context fields, `feedbackId`, and `submittedAt`.
The builder writes two-space JSON indentation.
Replace every backtick in the serialized JSON with the literal JSON escape `\u0060`.
This prevents a context field from closing the fence.
The feedback ID and timestamp override context values with the same names.
JSON field order does not affect marker parsing or reconciliation.

Titles contain no CR or LF and have at most 256 JavaScript UTF-16 code units.
Application-controlled links use HTTP or HTTPS and contain no URL credentials.
Encode parentheses in link destinations. Remove brackets and line endings from link labels.
Do not include bearer tokens or signed attachment URLs.
Use an authenticated application route for each protected attachment.

`fixtures/protocol-v1.json` contains reference input/output cases.
The package tests compare their complete bodies and marker recognition.
Other language adapters must match these cases for the fields they support.

## Submission and receipts

The browser sends `{ id, text, screenshot? }` to an authenticated application route.
The server derives the owner, organization, timestamp, destination repository, and trace fields.
It stores one immutable record per submission ID before delivery.
A retry by the same owner returns that record without replacing its content.
Another owner or organization cannot read or replace it.

A receipt contains `id`, `status: pending | delivered`, and `configured`.
It can include `attentionRequired: true` when delivery needs operator review.
A receipt never contains a GitHub token or internal issue URL.
The reference UI stops automatic status polling for a receipt that requires review.

## Claim and creation intent

1. Claim a due record with a database lease and a unique fence value.
2. Read its previous creation intent.
3. Commit the claim before network calls.
4. Reconcile existing issues.
5. Persist creation intent in an awaited callback immediately before the first creation POST.
6. Send the POST only after that callback succeeds.
7. Store the result only while the claim fence still matches.

A crash between the intent commit and the POST remains possible.
Moving the callback closer to the POST reduces that interval but cannot eliminate it.
The protocol does not promise exactly-once delivery across the database and GitHub.
Existing adapters can keep persisting intent in their claim transaction.

## Reconciliation

List issues directly through GitHub's repository issues endpoint.
Include open and closed issues. Ignore pull requests.
Set `since` to the submission time minus ten minutes.
Sort by creation time in descending order, with 100 results per page.
Match an issue whose body starts with the complete reference marker.
Construct its canonical issue URL from the configured repository and returned issue number.
Never trust an upstream `html_url` as the destination.

Search every issue in a returned page before stopping.
A short page proves the bounded result set ended.
A page containing an issue created before the ten-minute window also ends the search.
The application must maintain a synchronized server clock within that margin.
Scan at most 20 pages within 20 seconds. Bound each HTTP request to eight seconds.
A limit or deadline does not prove absence. It must leave delivery pending.
Large repositories and old pending records can exceed this bound and require operator review.

## Outcomes

- A known issue number means delivered.
- A missing issue with existing creation intent means `reconciling`. Do not create again.
- A definite HTTP 4xx rejection means `rejected`. The current POST did not create an issue.
- A network error or HTTP 5xx means `transient`. A sent POST may have succeeded.
- An incomplete bounded scan means `scan_limit`. Do not create an unverified duplicate.

Never clear an earlier creation intent after a later rejected request.
The outbox helper marks non-transient pending outcomes for attention after five attempts.
The host must persist this signal and expose an operator path for reconciliation.
The retry delay grows from 30 seconds to one hour.
An operator must inspect GitHub before clearing uncertain creation intent.
The public errors must omit credentials, upstream response bodies, and private payloads.
