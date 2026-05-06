// Regression test for the save/publish race condition.
//
// This test asserts that publish reflects the most recent saved draft,
// even when save is in flight at the moment publish is called.
//
// Failure mode (broken code): publish reads stale state and publishes the
// previous saved value rather than the in-flight one.
//
// You did not write this test — we did. Your job is to make your fix pass it.
// See README.md for what the assignment asks of you.
// test comment

const test = require('node:test');
const assert = require('node:assert');
const supertest = require('supertest');

// Slow down the save commit to make the race reliable in test environments.
// Real production timing varies; for testing we control it.
process.env.SAVE_COMMIT_DELAY_MS = '300';

const app = require('../app/server.js');

test('publish reflects the most recent save, even when save is in flight', async () => {
  const agent = supertest(app);

  // Reset shared state between test runs.
  await agent.post('/reset').expect(200);

  // First, save "draft A" and wait for it to commit fully.
  // After this, the committed state is "draft A".
  await agent
    .post('/draft')
    .send({ content: 'draft A' })
    .expect(200);

  // Now send save with "draft B" but do NOT await its response.
  // The save is in flight; the server hasn't committed it yet.
  const savePromise = agent
    .post('/draft')
    .send({ content: 'draft B' });

  // Immediately fire publish, before save B has had time to commit.
  const publishPromise = agent.post('/publish');

  // Let both finish in whatever order they finish.
  const [_, publishResponse] = await Promise.all([savePromise, publishPromise]);

  // The published value should be "draft B", not the stale "draft A".
  // A correct fix ensures publish waits for or sees the latest save.
  assert.strictEqual(
    publishResponse.body.published,
    'draft B',
    'publish returned stale data — the in-flight save was not reflected',
  );
});

test('publish reflects the saved value when no save is in flight', async () => {
  const agent = supertest(app);

  await agent.post('/reset').expect(200);

  await agent
    .post('/draft')
    .send({ content: 'committed draft' })
    .expect(200);

  const publishResponse = await agent.post('/publish').expect(200);

  assert.strictEqual(publishResponse.body.published, 'committed draft');
});

test('/reset cancels in-flight draft commits so they cannot mutate state after reset', async () => {
  const agent = supertest(app);

  await agent.post('/reset').expect(200);

  // Fire a save but do NOT await its response. The trailing .then(r => r)
  // is required to trigger supertest to actually send the HTTP request now
  // (supertest defers .end() until something attaches to the Test thenable).
  // Its commit timer is set for SAVE_COMMIT_DELAY_MS (300ms in this test).
  const draftPromise = agent
    .post('/draft')
    .send({ content: 'should-be-discarded' })
    .then((r) => r);

  // Yield briefly so /draft reaches the server handler (and arms its
  // commit timer) before we send /reset.
  await new Promise((r) => setTimeout(r, 50));

  // Reset before that timer can fire. A correct /reset must clearTimeout
  // the in-flight commit; otherwise the timer fires later and writes
  // 'should-be-discarded' back into currentDraft, defeating the reset.
  await agent.post('/reset').expect(200);

  // The /draft request should now settle as canceled rather than committed.
  const draftResponse = await draftPromise;
  assert.strictEqual(
    draftResponse.body.canceled,
    true,
    '/draft was not reported as canceled after /reset',
  );

  // Wait past the original commit deadline to confirm no late mutation.
  await new Promise((r) => setTimeout(r, 400));

  const currentResp = await agent.get('/current').expect(200);
  assert.strictEqual(
    currentResp.body.current,
    '',
    'reset did not actually cancel the in-flight draft commit',
  );

  const publishResp = await agent.post('/publish').expect(200);
  assert.strictEqual(publishResp.body.published, '');
});
