#!/usr/bin/env node
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { agentJob, issueFingerprint, listFeedbackIssues, repositoryName, runAgent, type AgentResult } from "./agent.js";

const help = `feedback-loop inbox --repo OWNER/REPO [--label feedback:ready]
feedback-loop run --repo OWNER/REPO [--label feedback:ready] [--state FILE] [--watch] [--interval 60] -- COMMAND [ARG...]

inbox prints marked issues as JSON. run sends each job as JSON to COMMAND on stdin.
COMMAND must return the result JSON described in docs/agent-loop.md.
run saves each result before it accepts another job. It does not merge or deploy.
Use one coordinator and one state file per repository. --watch polls until stopped.
`;
type Ledger = Record<string, { fingerprint: string; startedAt: string; result?: AgentResult; error?: string }>;
const main = async () => {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) { console.log(help); return; }
  const mode = args.shift();
  if (!["inbox", "run"].includes(mode!)) throw new Error("Use inbox or run.");
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args.splice(separator).slice(1) : [];
  const flags = new Map<string, string>();
  let watch = false;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--watch") { watch = true; continue; }
    if (!["--repo", "--label", "--state", "--interval"].includes(key) || !args.length) throw new Error(`Invalid option: ${key}`);
    flags.set(key, args.shift()!);
  }
  const repository = repositoryName(flags.get("--repo") ?? "");
  const label = flags.get("--label") ?? "feedback:ready";
  if (!label.trim()) throw new Error("Specify a nonempty routing label.");
  if (mode === "inbox") { console.log(JSON.stringify(await listFeedbackIssues(repository, label), null, 2)); return; }
  if (!command.length) throw new Error("Specify an agent command after --.");
  const interval = Number(flags.get("--interval") ?? 60);
  if (!Number.isFinite(interval) || interval < 10 || interval > 86400) throw new Error("Use a polling interval from 10 to 86400 seconds.");
  const statePath = resolve(flags.get("--state") ?? `.feedback-loop/${repository.replace("/", "--")}.json`);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  // The exclusive lock prevents concurrent coordinators that share this state path.
  const lock = await open(`${statePath}.lock`, "wx", 0o600).catch(() => { throw new Error(`The coordinator lock exists: ${statePath}.lock. Check its PID before removing it.`); });
  await lock.writeFile(String(process.pid));
  let ledger: Ledger;
  try {
    try { ledger = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") ledger = {}; else throw error; }
    if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) throw new Error("Invalid coordinator state.");
    const save = async () => {
      const temp = `${statePath}.${process.pid}.tmp`;
      const file = await open(temp, "w", 0o600);
      try { await file.writeFile(JSON.stringify(ledger, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temp, statePath);
    };
    do {
      for (const issue of await listFeedbackIssues(repository, label)) {
        const key = String(issue.number);
        const fingerprint = issueFingerprint(issue);
        // An interrupted job remains recorded. An operator must inspect its work before replay.
        if (ledger[key]?.fingerprint === fingerprint) continue;
        ledger[key] = { fingerprint, startedAt: new Date().toISOString() };
        await save();
        try { ledger[key]!.result = await runAgent(command, agentJob(repository, issue)); }
        catch (error) { ledger[key]!.error = error instanceof Error ? error.message : "Agent failed."; }
        await save();
        console.log(JSON.stringify({ issue: issue.number, ...ledger[key] }));
      }
      if (watch) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    } while (watch);
  } finally { await lock.close(); await unlink(`${statePath}.lock`); }
};
main().catch((error) => { console.error(error instanceof Error ? error.message : "Feedback loop failed."); process.exitCode = 1; });
