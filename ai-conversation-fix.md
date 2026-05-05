# AI Conversation: Race Condition Fix

This file records the part of the AI conversation where the save/publish
race condition fix was implemented and verified.

## Context Before The Fix

The harness and instrumentation had already confirmed that the bug was a
race condition:

- `POST /draft` delayed committing `currentDraft` with `setTimeout`.
- `POST /publish` read `currentDraft` immediately.
- When publish arrived while a save was still in flight, it published the
  previous committed draft instead of the user's newest saved content.

The proposed fix was to have `/draft` expose in-flight commit promises and
have `/publish` wait for pending draft commits before reading `currentDraft`.

## Transcript

### User

> Can you implement this fix?

### Assistant

> I’ll implement the server-side fix now: track pending draft commits, have
> `/publish` wait for any in-flight saves before reading `currentDraft`, then
> rerun the regression test and harness to verify the race disappears.

The assistant read `app/server.js`, then described the intended small local
change:

> I’m going to keep the fix small and local to `app/server.js`: `POST /draft`
> will register a commit promise, and `POST /publish` will await the set of
> pending commits before taking its snapshot.

## Code Changes Made

### `app/server.js`

The assistant added a `Set` to track pending draft commits:

```js
let currentDraft = '';
let publishedDraft = '';
const pendingDraftCommits = new Set();
```

The delayed save was changed from a plain `setTimeout` into a tracked commit
promise:

```js
const commitPromise = new Promise((resolve) => {
  setTimeout(() => {
    resolve();
  }, SAVE_COMMIT_DELAY_MS);
});
pendingDraftCommits.add(commitPromise);

commitPromise.then(() => {
  const before = currentDraft;
  currentDraft = content;
  trace('draft.committed', { reqId, content, before, after: currentDraft });
  pendingDraftCommits.delete(commitPromise);
  res.json({ ok: true, saved: content, reqId });
});
```

The publish endpoint was changed to wait for pending saves before publishing:

```js
app.post('/publish', async (req, res) => {
  const reqId = crypto.randomUUID();
  trace('publish.received', {
    reqId,
    currentDraftSnapshot: currentDraft,
    pendingDraftCommits: pendingDraftCommits.size,
  });

  if (pendingDraftCommits.size > 0) {
    await Promise.all([...pendingDraftCommits]);
    trace('publish.waitedForDrafts', { reqId, currentDraftSnapshot: currentDraft });
  }

  publishedDraft = currentDraft;
  trace('publish.completed', { reqId, published: publishedDraft });
  res.json({ ok: true, published: publishedDraft, reqId });
});
```

The reset endpoint was also updated to clear the pending commit set:

```js
app.post('/reset', (req, res) => {
  trace('reset', {});
  currentDraft = '';
  publishedDraft = '';
  pendingDraftCommits.clear();
  res.json({ ok: true });
});
```

### Assistant

> The fix is in place. I’m checking the regression test first; if that passes,
> I’ll rerun the harness with the race timing to confirm it no longer publishes
> stale data.

## Verification

The assistant ran:

```bash
npm test
```

The tests passed:

```text
# tests 2
# pass 2
# fail 0
```

### Assistant

> The regression test is green now: both tests pass. I’ll run the harness with
> the previously failing timing (`--gap-ms 10`) to verify the trace shows publish
> waiting rather than racing.

The assistant ran:

```bash
node harness/run-race.js --runs 5 --gap-ms 10
```

The harness reported no stale publishes:

```text
race reproduced: 0/5 runs
```

## Harness Analyzer Update

After the fix, the original analyzer still reported that publish arrived while
a save was in flight. That was true, but no longer unsafe because publish now
waited before completing.

### Assistant

> The fix made the behavior correct, but the analyzer is still using the pre-fix
> definition of “race”: it flags that publish arrived during an in-flight save
> even when publish correctly waits before completing. I’m updating the analyzer
> so it distinguishes an unsafe race from a protected interleaving.

The assistant updated `harness/analyze-trace.js` so it distinguishes:

- An unsafe race: publish completes before the in-flight draft commits or
  publishes a stale value.
- A protected interleaving: publish arrives while a draft is in flight, waits
  for that draft to commit, and then publishes the latest content.

The assistant also updated `harness/README.md` to document this distinction.

## Final Verification

The assistant ran:

```bash
npm test && node harness/run-race.js --runs 5 --gap-ms 10 && node harness/analyze-trace.js
```

Results:

```text
# tests 2
# pass 2
# fail 0

race reproduced: 0/5 runs

Observed 5 publish event(s) that arrived while a draft was still in flight.
Protected interleavings: 5

Conclusion: no unsafe race remains. /publish may arrive while
a draft is in flight, but it waits for that draft to commit before
publishing, so it returns the latest saved content.
```

The assistant then checked lints for the edited files and reported no linter
errors.

### Assistant Final Summary

> Implemented the fix.
>
> `app/server.js` now tracks pending draft commit promises. When `/publish` is
> called, it checks whether any saves are still in flight and waits for them
> before reading `currentDraft`, so publish no longer snapshots the stale value.
>
> I also updated the harness analyzer so it distinguishes:
>
> - **unsafe race**: publish completes before the in-flight draft commits
> - **protected interleaving**: publish arrives during an in-flight save but
>   waits, then publishes the latest draft
>
> Verification passed:
>
> ```bash
> npm test
> # pass 2, fail 0
> ```
>
> And the harness now confirms the fix:
>
> ```bash
> node harness/run-race.js --runs 5 --gap-ms 10
> # race reproduced: 0/5 runs
> ```
>
> `harness/analyze-trace.js` now reports 5 protected interleavings and concludes
> no unsafe race remains. No linter errors found.

## Follow-Up Trace Conversation

### User

> Did you get a trace - save it to trace.txt and tell me if it indicated that
> there was a race condition.

### Assistant

> Yes, I captured a trace during the harness run. I’ll save the latest trace
> analysis to `trace.txt` now, then summarize whether it shows the race
> condition.

The assistant ran:

```bash
node harness/analyze-trace.js > trace.txt
```

### Assistant Final Trace Summary

> Yes. I saved the latest trace analysis to `trace.txt`.
>
> It **does indicate the race window existed**: publish arrived while a draft
> save was still in flight 5 times.
>
> But with the fix in place, it shows **no unsafe race remains**. Each publish
> waited for the in-flight draft to commit, then published the correct latest
> content (`draft B #0`, `draft B #1`, etc.).

