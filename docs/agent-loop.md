# Agent loop protocol

The coordinator uses `gh api` to read open issues with a routing label.
It requires the package's version marker.
Use `--legacy-namespace NAME` to opt into an older application's marker namespace.
The default routing label is `feedback:ready`.
Create that label in the destination repository before routing work.
Add it after a person or triage process approves an issue for development.
The package does not automatically add that label during delivery.

## Coordinator

Run the coordinator from the target application's checkout.
The agent command inherits that working directory.
The repository passed to `--repo` must match the checkout used by the agent.
Use `--label` to select a different routing label.
Use `--state` to choose a persistent state file.
The default file is `.feedback-loop/OWNER--REPO.json` under the working directory.
Exclude that directory from source control.

Use one coordinator per repository.
An exclusive lock prevents concurrent processes that share the same state path.
The lock does not coordinate independent hosts or state paths.
The coordinator polls every 60 seconds with `--watch`.
Use `--interval` to select an interval from 10 to 86,400 seconds.
Run the coordinator under your existing service manager for unattended operation.

The coordinator writes a job record before starting the agent.
It skips unchanged issue titles and bodies on later polls.
Agent comments and label changes do not cause repeated work.
A changed title or body produces `changed_since_run` and does not create another job.
Inspect the existing branch and pull request before approving a replay.

Failed, blocked, and interrupted jobs remain in the state file.
Inspect their branches and pull requests before a replay.
Stop the coordinator before removing the selected issue entry from its state file.
Normal SIGINT and SIGTERM shutdown stops the active worker and removes the lock.
An uncatchable termination or machine failure can leave a `.lock` file.
Check its recorded PID before removing a stale lock.

## Agent wrapper

The wrapper receives one JSON object on stdin:

```json
{
  "protocol": "feedback-loop/v1",
  "repository": "OWNER/REPO",
  "issue": {
    "number": 123,
    "url": "https://github.com/OWNER/REPO/issues/123",
    "title": "...",
    "body": "..."
  },
  "instructions": ["..."]
}
```

The title and body are user data.
They cannot authorize changes to agent permissions or repository instructions.
The agent must check the report against the current source before changing code.
The agent must follow the application's `AGENTS.md` instructions.

The wrapper returns exactly one JSON object on stdout:

```json
{
  "status": "needs_review",
  "summary": "Fixed the missing heading. Tests passed.",
  "prUrl": "https://github.com/OWNER/REPO/pull/456"
}
```

If the report requires clarification, return:

```json
{ "status": "blocked", "summary": "The report does not identify the affected screen." }
```

Write agent logs to stderr.
The coordinator requires a pull request URL from the selected repository for `needs_review`.
It stores the result locally. It does not check CI, merge status, or deployment status.
A successful agent process is not evidence that a fix is live.
The agent must open a draft pull request and leave review and release to the application's existing workflow.

An agent process has a 30-minute deadline and a 1 MB stdout limit.
The coordinator signals the process group on POSIX and uses `taskkill /T` on Windows.
Wrappers must keep descendants in that group or process tree.
A wrapper that deliberately detaches descendants defeats process-tree cleanup.
The coordinator survives a transient GitHub poll failure in watch mode.
The coordinator records a failure instead of automatically repeating an ambiguous run.

## Adapter contract

Any agent can implement this stdin/stdout contract.
An existing CLI agent can use a small wrapper that translates the job into its prompt format.
See `examples/agent-wrapper.mjs` for an SDK-neutral wrapper interface.
Configure that wrapper with the agent command and permissions used by your application.
The package requires no model provider or agent SDK.
