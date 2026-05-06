// Reads harness/trace.ndjson (produced by run-race.js) and analyzes the
// save/publish interleaving from the trace alone.
//
// Before the fix, an unsafe race is visible when `publish.completed`
// happens before an already-received draft has committed, causing publish
// to return the previous committed value. After the fix, publish may still
// arrive during that window, but it should wait and complete only after the
// in-flight draft commits.
//
// Usage:
//   node harness/analyze-trace.js                   # uses harness/trace.ndjson
//   node harness/analyze-trace.js path/to/trace.ndjson

const fs = require('node:fs');
const path = require('node:path');

const tracePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, 'trace.ndjson');

if (!fs.existsSync(tracePath)) {
  console.error(`trace file not found: ${tracePath}`);
  console.error('run `node harness/run-race.js` first to produce one.');
  process.exit(1);
}

const events = fs.readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (events.length === 0) {
  console.error('trace file is empty');
  process.exit(1);
}

const t0 = events[0].t_ms;
const normalized = events.map((e) => ({ ...e, dt_ms: e.t_ms - t0 }));

// Walk the trace tracking which draft requests are in flight (received
// but not yet committed). For every publish, record whether it arrived
// during an in-flight draft and whether it completed safely.
const inflight = new Map();
const drafts = new Map();
const publishes = new Map();

for (const e of normalized) {
  if (e.event === 'reset') {
    inflight.clear();
  } else if (e.event === 'draft.received') {
    const draft = { reqId: e.reqId, startedAt_ms: e.dt_ms, content: e.content };
    drafts.set(e.reqId, draft);
    inflight.set(e.reqId, draft);
  } else if (e.event === 'draft.committed') {
    const draft = drafts.get(e.reqId);
    if (draft) {
      draft.committedAt_ms = e.dt_ms;
      draft.after = e.after;
    }
    inflight.delete(e.reqId);
  } else if (e.event === 'publish.received' && inflight.size > 0) {
    publishes.set(e.reqId, {
      reqId: e.reqId,
      receivedAt_ms: e.dt_ms,
      currentDraftSnapshot: e.currentDraftSnapshot,
      inflightDrafts: [...inflight.values()],
    });
  } else if (e.event === 'publish.waitedForDrafts') {
    const publish = publishes.get(e.reqId);
    if (publish) {
      publish.waitedAt_ms = e.dt_ms;
      publish.afterWaitSnapshot = e.currentDraftSnapshot;
    }
  } else if (e.event === 'publish.completed') {
    const publish = publishes.get(e.reqId);
    if (publish) {
      publish.completedAt_ms = e.dt_ms;
      publish.published = e.published;
    }
  }
}

const analyzed = [...publishes.values()].map((publish) => {
  const unfinishedAtCompletion = publish.inflightDrafts.filter((draft) => (
    !draft.committedAt_ms || !publish.completedAt_ms || draft.committedAt_ms > publish.completedAt_ms
  ));
  const latestInFlightDraft = publish.inflightDrafts
    .slice()
    .sort((a, b) => b.startedAt_ms - a.startedAt_ms)[0];
  const publishedLatestDraft = latestInFlightDraft
    ? publish.published === latestInFlightDraft.content
    : true;

  return {
    ...publish,
    latestInFlightDraft,
    unfinishedAtCompletion,
    unsafe: unfinishedAtCompletion.length > 0 || !publishedLatestDraft,
  };
});

const unsafe = analyzed.filter((publish) => publish.unsafe);
const protectedInterleavings = analyzed.filter((publish) => !publish.unsafe);

console.log('--- timeline (ms since first event) ---');
for (const e of normalized) {
  const meta = { ...e };
  delete meta.t_ms;
  delete meta.dt_ms;
  delete meta.event;
  console.log(
    String(e.dt_ms).padStart(6),
    e.event.padEnd(20),
    JSON.stringify(meta),
  );
}

console.log('\n--- race verdict ---');
if (analyzed.length === 0) {
  console.log('No publish.received was observed while a draft was in flight.');
  console.log('Race window not exercised in this trace. Try a smaller --gap-ms.');
  process.exit(0);
}

console.log(`Observed ${analyzed.length} publish event(s) that arrived while a draft was still in flight.`);

if (protectedInterleavings.length > 0) {
  console.log(`\nProtected interleavings: ${protectedInterleavings.length}`);
}
for (const r of protectedInterleavings) {
  console.log('');
  console.log(`  publish reqId:           ${r.reqId}`);
  console.log(`  publish received at:     t+${r.receivedAt_ms}ms`);
  console.log(`  publish completed at:    t+${r.completedAt_ms}ms`);
  console.log(`  currentDraft on receive: ${JSON.stringify(r.currentDraftSnapshot)}`);
  console.log(`  published value:         ${JSON.stringify(r.published)}`);
  for (const d of r.inflightDrafts) {
    console.log(`  in-flight draft reqId:   ${d.reqId}`);
    console.log(`    received at:           t+${d.startedAt_ms}ms`);
    console.log(`    committed at:          t+${d.committedAt_ms}ms`);
    console.log(`    content:               ${JSON.stringify(d.content)}`);
  }
}

if (unsafe.length > 0) {
  console.log(`\nUnsafe races: ${unsafe.length}`);
}
for (const r of unsafe) {
  console.log('');
  console.log(`  publish reqId:           ${r.reqId}`);
  console.log(`  publish received at:     t+${r.receivedAt_ms}ms`);
  console.log(`  publish completed at:    t+${r.completedAt_ms}ms`);
  console.log(`  currentDraft on receive: ${JSON.stringify(r.currentDraftSnapshot)}`);
  console.log(`  published value:         ${JSON.stringify(r.published)}`);
  for (const d of r.inflightDrafts) {
    console.log(`  in-flight draft reqId:   ${d.reqId}`);
    console.log(`    received at:           t+${d.startedAt_ms}ms`);
    console.log(`    committed at:          ${d.committedAt_ms === undefined ? '(after publish or missing)' : `t+${d.committedAt_ms}ms`}`);
    console.log(`    content:               ${JSON.stringify(d.content)}`);
  }
}

console.log('');
if (unsafe.length > 0) {
  console.log('Conclusion: unsafe race remains. /publish completed before');
  console.log('the in-flight draft was safely reflected in currentDraft.');
  process.exit(1);
}

console.log('Conclusion: no unsafe race remains. /publish may arrive while');
console.log('a draft is in flight, but it waits for that draft to commit before');
console.log('publishing, so it returns the latest saved content.');
