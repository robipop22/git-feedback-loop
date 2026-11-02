import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isFeedbackIssue, parseAgentResult, runAgent, agentJob } from "../dist/agent.js";

const execute = promisify(execFile);
const issue = { number: 3, title: "Feedback", body: "<!-- feedback-loop:test -->\n\n<!-- feedback-loop:v1 -->\nText", html_url: "https://github.com/owner/repo/issues/3" };
test("routing accepts protocol and legacy issues, and rejects pull requests and unrelated issues", () => {
  assert.equal(isFeedbackIssue(issue), true);
  assert.equal(isFeedbackIssue({ ...issue, body: "<!-- medinotes-feedback:legacy -->\nText" }), true);
  assert.equal(isFeedbackIssue({ ...issue, body: "Ordinary issue" }), false);
  assert.equal(isFeedbackIssue({ ...issue, pull_request: {} }), false);
  assert.throws(() => parseAgentResult('{"status":"needs_review","summary":"Done","prUrl":"https://github.com/other/repo/pull/2"}', "owner/repo"));
});
test("an arbitrary executable receives the job through stdin and returns structured results", async () => {
  const result = await runAgent([process.execPath, "-e", 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify({status:"blocked",summary:JSON.parse(s).issue.title})))'], agentJob("owner/repo", issue));
  assert.deepEqual(result, { status: "blocked", summary: "Feedback" });
  await assert.rejects(runAgent([process.execPath, "-e", 'setTimeout(()=>{},10000)'], agentJob("owner/repo", issue), 20), /time limit/);
});
test("CLI uses gh, persists job results, and skips completed or interrupted work on restart", async () => {
  const temp = await mkdtemp(join(tmpdir(), "feedback-loop-"));
  try {
    const bin = join(temp, "bin"); await mkdir(bin);
    await writeFile(join(bin, "gh"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify([[issue]]))});\n`, { mode: 0o755 });
    const worker = join(temp, "worker.mjs");
    await writeFile(worker, 'import {appendFileSync} from "node:fs"; let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{appendFileSync(process.argv[2],"called\\n");console.log(JSON.stringify({status:"blocked",summary:"Need reproduction details"}));});');
    const count = join(temp, "count"); const state = join(temp, "state.json");
    const args = [resolve("dist/cli.js"), "run", "--repo", "owner/repo", "--state", state, "--", process.execPath, worker, count];
    const options = { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
    const first = await execute(process.execPath, args, options);
    assert.equal(JSON.parse(first.stdout).result.status, "blocked");
    await execute(process.execPath, args, options);
    assert.equal(await readFile(count, "utf8"), "called\n");
    const ledger = JSON.parse(await readFile(state, "utf8")); delete ledger[3].result;
    await writeFile(state, JSON.stringify(ledger));
    await execute(process.execPath, args, options);
    assert.equal(await readFile(count, "utf8"), "called\n");
    await writeFile(`${state}.lock`, "12345");
    await assert.rejects(execute(process.execPath, args, options), /coordinator lock exists/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
