# Agent guide

This repository contains the `git-feedback-loop` npm package.
Use Node.js 22 or later.

1. Run `npm ci` before editing the source.
2. Keep server modules separate from browser entry points.
3. Keep React optional for server and CLI consumers.
4. Preserve existing issue markers during delivery changes.
5. Preserve creation intent after uncertain GitHub responses.
6. Keep user feedback separate from agent instructions.
7. Add contract tests when behavior changes.
8. Run `npm test` before submitting a change.
9. Run `npm pack --dry-run` before preparing a release.

The runtime package must have no required dependencies.
Keep framework authentication, application storage, and AI provider selection in host adapters.
Do not include application secrets, feedback records, or private evidence in this repository.
Use direct English in documentation and agent instructions.
