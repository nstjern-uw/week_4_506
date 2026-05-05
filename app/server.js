// Save-and-Publish Draft Editor
//
// This app has a known race condition between /draft and /publish.
// See README.md for the bug description and what you're being asked to do.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// TRACE=1 turns on structured NDJSON logging used by the harness in
// harness/. Off by default so normal runs and `npm test` are unaffected.
const TRACE = process.env.TRACE === '1';

function trace(event, fields) {
  if (!TRACE) return;
  const entry = {
    t_ms: Number(process.hrtime.bigint() / 1000000n),
    event,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
// `currentDraft` is the most recent saved draft.
// `publishedDraft` is what /publish has marked as live.
//
// In a real app these would live in a database. For this assignment, in-memory
// is fine — the bug is in the timing, not the storage.
let currentDraft = '';
let publishedDraft = '';
const pendingDraftCommits = new Set();

// SAVE_COMMIT_DELAY_MS controls how long a /draft request takes to commit.
// In production this would represent database write latency, network latency,
// or any other delay between "request received" and "value updated."
//
// Set to 200ms by default to make the race condition reliably reproducible.
// Tests may override this via environment variable.
const SAVE_COMMIT_DELAY_MS = parseInt(process.env.SAVE_COMMIT_DELAY_MS || '200', 10);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /draft — save the current draft text.
//
// Note the artificial delay: the draft is not committed to currentDraft
// until SAVE_COMMIT_DELAY_MS milliseconds after the request arrives.
app.post('/draft', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  const reqId = crypto.randomUUID();
  trace('draft.received', { reqId, content, currentDraft });

  // Each pending commit is tracked as an entry so /publish can await it and
  // /reset can cancel it. The mutation of currentDraft happens inside the
  // timer callback *before* the promise resolves, so any /publish awaiting
  // this promise observes the new value as soon as its await resumes —
  // independent of the order in which .then handlers were registered.
  const entry = {};
  entry.promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDraftCommits.delete(entry);
      const before = currentDraft;
      currentDraft = content;
      trace('draft.committed', { reqId, content, before, after: currentDraft });
      resolve();
    }, SAVE_COMMIT_DELAY_MS);
    entry.cancel = () => {
      clearTimeout(timer);
      pendingDraftCommits.delete(entry);
      reject(new Error('canceled by /reset'));
    };
  });
  pendingDraftCommits.add(entry);

  entry.promise.then(
    () => res.json({ ok: true, saved: content, reqId }),
    () => {
      trace('draft.canceled', { reqId, content });
      res.status(409).json({ ok: false, canceled: true, reqId });
    },
  );
});

// POST /publish — mark the most recent saved draft as live.
//
// Wait for any in-flight saves before reading currentDraft. This preserves
// request order for the user flow where Save is sent, then Publish is sent
// before the save's delayed commit has completed.
app.post('/publish', async (req, res) => {
  const reqId = crypto.randomUUID();
  trace('publish.received', {
    reqId,
    currentDraftSnapshot: currentDraft,
    pendingDraftCommits: pendingDraftCommits.size,
  });

  if (pendingDraftCommits.size > 0) {
    // allSettled (not all) so a concurrent /reset that rejects pending
    // commits doesn't surface here as an unhandled error and leave /publish
    // without a response. We don't care about the per-commit outcome — only
    // that the in-flight commits have all settled before we read currentDraft.
    await Promise.allSettled([...pendingDraftCommits].map((e) => e.promise));
    trace('publish.waitedForDrafts', { reqId, currentDraftSnapshot: currentDraft });
  }

  publishedDraft = currentDraft;
  trace('publish.completed', { reqId, published: publishedDraft });
  res.json({ ok: true, published: publishedDraft, reqId });
});

// GET /published — return the currently published draft.
app.get('/published', (req, res) => {
  res.json({ published: publishedDraft });
});

// GET /current — return the currently saved (committed) draft.
app.get('/current', (req, res) => {
  res.json({ current: currentDraft });
});

// Reset endpoint for tests.
app.post('/reset', (req, res) => {
  trace('reset', {});
  // Cancel in-flight draft commits before clearing state. Otherwise their
  // setTimeout callbacks still fire after the reset and write the (now
  // stale) content back into currentDraft, undoing the reset and possibly
  // resurrecting the original race for any /publish that arrives in the
  // gap. Iterate a snapshot since cancel() mutates the set.
  for (const entry of [...pendingDraftCommits]) entry.cancel();
  pendingDraftCommits.clear();
  currentDraft = '';
  publishedDraft = '';
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  app.listen(PORT, () => {
    if (!TRACE) {
      console.log(`Draft editor running on http://localhost:${PORT}`);
      console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}`);
    } else {
      // When tracing, emit a single JSON event so the harness's NDJSON
      // parser doesn't have to special-case the startup banner.
      trace('server.listening', { port: PORT, saveCommitDelayMs: SAVE_COMMIT_DELAY_MS });
    }
  });
}

module.exports = app;
