import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runAgent, agentJob } from "../dist/agent.js";
const issue = {
  number: 3,
  title: "Synthetic feedback",
  body: "<!-- feedback-loop:job -->\n\n<!-- feedback-loop:v1 -->",
  html_url: "https://github.com/owner/repo/issues/3",
};
const until = async (check, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Test condition timed out");
};
const exists = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "feedback-lifecycle-"));
  const bin = join(temp, "bin");
  await mkdir(bin);
  const child = join(temp, "heartbeat.mjs");
  const worker = join(temp, "worker.mjs");
  const beat = join(temp, "beat");
  await writeFile(
    child,
    'import {appendFileSync} from "node:fs";setInterval(()=>appendFileSync(process.argv[2],"x"),20);',
  );
  await writeFile(
    worker,
    'import{spawn}from"node:child_process";spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000);',
  );
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify([[issue]]))});\n`,
    { mode: 0o755 },
  );
  return { temp, bin, beat, child, worker };
}
test(
  "timeout stops a wrapper and its heartbeat-writing descendant",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        runAgent(
          [process.execPath, f.worker, f.child, f.beat],
          agentJob("owner/repo", issue),
          1000,
          { killGraceMs: 100 },
        ),
        /time limit/,
      );
      const before = await readFile(f.beat, "utf8");
      assert.ok(before.length > 0);
      await delay(150);
      assert.equal(await readFile(f.beat, "utf8"), before);
    } finally {
      await rm(f.temp, { recursive: true, force: true });
    }
  },
);
test(
  "SIGTERM stops the active agent, saves the interrupted job, and removes the coordinator lock",
  { timeout: 12000 },
  async () => {
    const f = await fixture();
    let child;
    let diagnostics = "";
    try {
      const state = join(f.temp, "state.json");
      child = spawn(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "run",
          "--repo",
          "owner/repo",
          "--state",
          state,
          "--watch",
          "--",
          process.execPath,
          f.worker,
          f.child,
          f.beat,
        ],
        {
          env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = new Promise((resolve) => child.on("exit", resolve));
      child.stdout.on("data", (chunk) => {
        diagnostics += chunk;
      });
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
      });
      await until(() => exists(f.beat)).catch((error) => {
        throw new Error(`${error.message}: ${diagnostics}`);
      });
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      await until(async () => !(await exists(`${state}.lock`)));
      assert.match(JSON.parse(await readFile(state, "utf8"))[3].error, /stopped/);
      const before = await readFile(f.beat, "utf8");
      await delay(150);
      assert.equal(await readFile(f.beat, "utf8"), before);
    } finally {
      child?.kill("SIGKILL");
      await rm(f.temp, { recursive: true, force: true });
    }
  },
);
test(
  "watch mode survives a failed gh poll and processes the next successful poll",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    let child;
    let diagnostics = "";
    try {
      const flag = join(f.temp, "polled");
      await writeFile(
        join(f.bin, "gh"),
        `#!/usr/bin/env node\nconst fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'1');process.exit(1);}console.log(${JSON.stringify(JSON.stringify([[issue]]))});`,
        { mode: 0o755 },
      );
      const worker = join(f.temp, "result.mjs");
      await writeFile(
        worker,
        'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({status:"blocked",summary:"Synthetic check"})));',
      );
      const state = join(f.temp, "state.json");
      child = spawn(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "run",
          "--repo",
          "owner/repo",
          "--state",
          state,
          "--watch",
          "--interval",
          "10",
          "--",
          process.execPath,
          worker,
        ],
        {
          env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = new Promise((resolve) => child.on("exit", resolve));
      child.stdout.on("data", (chunk) => {
        diagnostics += chunk;
      });
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
      });
      await until(async () => {
        try {
          return Boolean(JSON.parse(await readFile(state, "utf8"))[3]?.result);
        } catch {
          return false;
        }
      }, 16000).catch((error) => {
        throw new Error(`${error.message}: ${diagnostics}`);
      });
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.equal(await exists(`${state}.lock`), false);
    } finally {
      child?.kill("SIGKILL");
      await rm(f.temp, { recursive: true, force: true });
    }
  },
);
