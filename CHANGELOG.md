# Changelog

## 0.2.0

- Add language-neutral protocol documentation and golden fixtures.
- Normalize CR line endings before formatting feedback as literal Markdown.
- Add a static audio worklet for applications with a strict CSP.
- Extract a submission hook for host UI primitives.
- Recover from validation failures and ignore stale receipt responses.
- Cancel obsolete voice work and retain transcriptions for callback retries.
- Pause capture during spoken replies unless the host explicitly enables barge-in with headphones.
- Expose delivery reasons and operator-review signals.
- Add graceful coordinator shutdown and descendant cleanup.
- Require explicit replay approval after issue edits.
- Make legacy marker namespaces an explicit coordinator option.

## 0.1.0

- Extract GitHub feedback issue delivery from Medinotes.
- Add a React feedback widget and browser client.
- Include screenshots, recorded audio, and continuous voice turns.
- Add database delivery callbacks and retry delays.
- Add a GitHub CLI coordinator with a persistent job ledger.
- Define a JSON protocol for external coding agents.
