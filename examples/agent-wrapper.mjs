#!/usr/bin/env node
// Implement runTask with your existing CLI agent, HTTP agent, or local agent SDK.
// Return an object. Send all diagnostic output to stderr.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
if (job.protocol !== 'feedback-loop/v1') throw new Error('Unsupported job protocol.');

async function runTask(job) {
  // Replace this demonstration response with your agent invocation.
  return { status: 'blocked', summary: `Connect an agent adapter for issue #${job.issue.number}.` };
}
process.stdout.write(JSON.stringify(await runTask(job)));
