#!/usr/bin/env node
// Stands in for `tools/piper_server.py` in tests: speaks the same
// line-delimited JSON protocol without needing Python or a real Piper voice
// model installed. Behavior is driven by the job's `text` field:
//   "CRASH" -> exits nonzero without replying (simulates a worker crash)
//   "HANG"  -> never replies (simulates a wedged synth, for timeout tests)
//   "ERROR" -> replies with ok:false
//   anything else -> replies ok:true after a short delay
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const job = JSON.parse(trimmed);
  if (job.text === "CRASH") {
    process.exit(1);
  } else if (job.text === "HANG") {
    // Deliberately never respond.
  } else if (job.text === "ERROR") {
    process.stdout.write(`${JSON.stringify({ id: job.id, ok: false, error: "boom" })}\n`);
  } else {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ id: job.id, ok: true })}\n`);
    }, 5);
  }
});
