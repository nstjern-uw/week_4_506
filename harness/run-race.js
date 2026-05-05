// Race condition harness for the save/publish bug in app/server.js.
//
// Boots the app server in-process with TRACE=1, captures structured NDJSON
// trace events from stdout, and drives the "save A → save B (no await)
// → publish" scenario N times. Reports per-run timing and whether each
// run reproduced the race (publish returned the stale 'draft A' instead
// of the in-flight 'draft B').
//
// Usage:
//   node harness/run-race.js                     # default: 5 runs, 0ms gap
//   node harness/run-race.js --runs 20           # more trials
//   node harness/run-race.js --gap-ms 50         # delay before publish
//   node harness/run-race.js --save-delay-ms 500 # slow saves down
//   node harness/run-race.js --port 4123         # custom test port
//
// Side effect: writes the captured trace to harness/trace.ndjson, which
// harness/analyze-trace.js reads to demonstrate the temporal interleaving.

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const fs = require('node:fs');

function parseArgs(argv) {
  const args = { gapMs: 0, runs: 5, saveDelayMs: 300, port: 4100 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--gap-ms') { args.gapMs = parseInt(v, 10); i++; }
    else if (k === '--runs') { args.runs = parseInt(v, 10); i++; }
    else if (k === '--save-delay-ms') { args.saveDelayMs = parseInt(v, 10); i++; }
    else if (k === '--port') { args.port = parseInt(v, 10); i++; }
    else if (k === '--help' || k === '-h') {
      console.log('Usage: node harness/run-race.js [--runs N] [--gap-ms N] [--save-delay-ms N] [--port N]');
      process.exit(0);
    }
  }
  return args;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function startServer({ port, saveDelayMs }) {
  const serverPath = path.resolve(__dirname, '..', 'app', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      TRACE: '1',
      PORT: String(port),
      SAVE_COMMIT_DELAY_MS: String(saveDelayMs),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const events = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      // Should not happen with TRACE=1, but log to aid debugging.
      process.stderr.write(`harness: non-JSON server output: ${line}\n`);
    }
  });

  // Poll until the server's listening event arrives or a GET succeeds.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.event === 'server.listening')) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/published`);
      if (r.ok) break;
    } catch { /* not ready yet */ }
    await waitMs(50);
  }

  return { child, events };
}

async function runOnce({ port, gapMs }, runIndex) {
  await postJson(port, '/reset');

  // Commit "draft A" fully so currentDraft = "draft A" before we start the race.
  await postJson(port, '/draft', { content: 'draft A' });

  const expected = `draft B #${runIndex}`;
  const tStart = Number(process.hrtime.bigint() / 1000000n);

  // Fire save B (do NOT await), optional gap, then fire publish.
  const savePromise = postJson(port, '/draft', { content: expected });
  if (gapMs > 0) await waitMs(gapMs);
  const publishPromise = postJson(port, '/publish');

  const [save, publish] = await Promise.all([savePromise, publishPromise]);
  const tEnd = Number(process.hrtime.bigint() / 1000000n);

  return {
    runIndex,
    durationMs: tEnd - tStart,
    expected,
    saveBody: save.body,
    publishBody: publish.body,
    raceObserved: publish.body.published !== expected,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { child, events } = await startServer(args);

  let exitCode = 0;
  try {
    const results = [];
    for (let i = 0; i < args.runs; i++) {
      results.push(await runOnce(args, i));
    }

    const repro = results.filter((r) => r.raceObserved).length;
    console.log('--- harness summary ---');
    console.table(results.map((r) => ({
      run: r.runIndex,
      published: r.publishBody.published,
      expected: r.expected,
      stale: r.raceObserved,
      ms: r.durationMs,
    })));
    console.log(`race reproduced: ${repro}/${args.runs} runs`);
    console.log(`save delay: ${args.saveDelayMs}ms, gap before publish: ${args.gapMs}ms`);

    const tracePath = path.resolve(__dirname, 'trace.ndjson');
    fs.writeFileSync(
      tracePath,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    console.log(`wrote ${events.length} trace events to ${path.relative(process.cwd(), tracePath)}`);

    if (repro === 0) {
      console.warn('warning: race did not reproduce in any run. Try --gap-ms 0 with a larger --save-delay-ms.');
    }
  } catch (err) {
    console.error('harness error:', err);
    exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    // Give the child a moment to flush.
    await waitMs(50);
    process.exit(exitCode);
  }
}

main();
