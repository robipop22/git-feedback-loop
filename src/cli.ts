#!/usr/bin/env node
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  agentJob,
  issueFingerprint,
  listFeedbackIssues,
  repositoryName,
  runAgent,
  type AgentResult,
  type AgentIssue,
} from "./agent.js";

const help = `feedback-loop inbox --repo OWNER/REPO [--label feedback:ready] [--legacy-namespace NAME]
feedback-loop run --repo OWNER/REPO [--label feedback:ready] [--state FILE] [--watch] [--interval 60] -- COMMAND [ARG...]

inbox prints marked issues as JSON. run sends each job as JSON to COMMAND on stdin.
COMMAND must return the result JSON described in docs/agent-loop.md.
run records jobs before execution. Existing jobs require operator approval for any replay.
Use one coordinator and one state file per repository. --watch polls until stopped.
`;
type Ledger = Record<
  string,
  {
    fingerprint: string;
    startedAt: string;
    result?: AgentResult;
    error?: string;
    changedFingerprint?: string;
  }
>;
const main = async () => {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help") {
    console.log(help);
    return;
  }
  const mode = args.shift();
  if (!["inbox", "run"].includes(mode!)) throw new Error("Use inbox or run.");
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args.splice(separator).slice(1) : [];
  const flags = new Map<string, string>();
  let watch = false;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--watch") {
      watch = true;
      continue;
    }
    if (
      !["--repo", "--label", "--state", "--interval", "--legacy-namespace"].includes(key) ||
      !args.length
    )
      throw new Error(`Invalid option: ${key}`);
    flags.set(key, args.shift()!);
  }
  const repository = repositoryName(flags.get("--repo") ?? "");
  const label = flags.get("--label") ?? "feedback:ready";
  if (!label.trim()) throw new Error("Specify a nonempty routing label.");
  const legacyNamespaces = flags.has("--legacy-namespace")
    ? flags.get("--legacy-namespace")!.split(",")
    : [];
  if (legacyNamespaces.some((value) => !/^[a-zA-Z0-9_-]{1,80}$/.test(value)))
    throw new Error("Invalid legacy marker namespace.");
  if (mode === "inbox") {
    console.log(
      JSON.stringify(await listFeedbackIssues(repository, label, { legacyNamespaces }), null, 2),
    );
    return;
  }
  if (!command.length) throw new Error("Specify an agent command after --.");
  const interval = Number(flags.get("--interval") ?? 60);
  if (!Number.isFinite(interval) || interval < 10 || interval > 86400)
    throw new Error("Use a polling interval from 10 to 86400 seconds.");
  const statePath = resolve(
    flags.get("--state") ?? `.feedback-loop/${repository.replace("/", "--")}.json`,
  );
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await open(`${statePath}.lock`, "wx", 0o600).catch(() => {
    throw new Error(
      `The coordinator lock exists: ${statePath}.lock. Check its PID before removing it.`,
    );
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await lock.writeFile(String(process.pid));
    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") ledger = {};
      else throw error;
    }
    if (!ledger || typeof ledger !== "object" || Array.isArray(ledger))
      throw new Error("Invalid coordinator state.");
    const save = async () => {
      const temp = `${statePath}.${process.pid}.tmp`;
      const file = await open(temp, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(ledger, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, statePath);
    };
    do {
      let issues: AgentIssue[];
      try {
        issues = await listFeedbackIssues(repository, label, {
          signal: controller.signal,
          legacyNamespaces,
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        if (!watch) throw error;
        console.error("The GitHub poll failed. The coordinator will retry.");
        await delay(interval * 1000, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
        continue;
      }
      for (const issue of issues) {
        if (controller.signal.aborted) break;
        const key = String(issue.number);
        const fingerprint = issueFingerprint(issue);
        const existing = ledger[key];
        if (existing) {
          if (existing.fingerprint !== fingerprint && existing.changedFingerprint !== fingerprint) {
            existing.changedFingerprint = fingerprint;
            await save();
            console.log(JSON.stringify({ issue: issue.number, status: "changed_since_run" }));
          }
          continue;
        }
        ledger[key] = { fingerprint, startedAt: new Date().toISOString() };
        await save();
        try {
          ledger[key]!.result = await runAgent(command, agentJob(repository, issue), undefined, {
            signal: controller.signal,
          });
        } catch (error) {
          ledger[key]!.error = error instanceof Error ? error.message : "Agent failed.";
        }
        await save();
        console.log(JSON.stringify({ issue: issue.number, ...ledger[key] }));
      }
      if (watch && !controller.signal.aborted)
        await delay(interval * 1000, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
    } while (watch && !controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.close();
    await unlink(`${statePath}.lock`);
  }
};
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Feedback loop failed.");
  process.exitCode = 1;
});
