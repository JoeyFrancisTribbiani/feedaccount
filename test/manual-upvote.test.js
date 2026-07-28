import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { LocalDatabase } from "../src/database.js";
import { JobManager } from "../src/job-manager.js";
import { createMonitorServer } from "../src/server.js";

const options = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 180,
  waitMaxMs: 180,
  maxPosts: 0,
  autoStopAtBottom: false,
  detailLoopEnabled: false,
};

function post(number, overrides = {}) {
  return {
    postId: `p${number}`,
    title: `Post ${number}`,
    postType: "text",
    feedIndex: number,
    permalink: `https://www.reddit.com/comments/p${number}`,
    height: 600,
    visibleRatio: 1,
    fullyVisible: true,
    fitPossible: true,
    oversized: false,
    clickEligible: true,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualSession {
  constructor(manualResult) {
    this.scrolls = 0;
    this.closed = false;
    this.manualCalls = [];
    this.manualResult = manualResult;
  }

  async connect() {
    return {
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
      y: 0,
      max: 5_000,
      currentPost: post(1),
    };
  }

  async scroll() {
    this.scrolls += 1;
    return {
      actualDistance: 300,
      currentY: this.scrolls * 300,
      maxY: 5_000,
      atBottom: false,
      newPost: true,
      noPostAvailable: false,
      scrollKind: "next-post",
      postComplete: true,
      currentPost: post(this.scrolls + 1),
      inputMethod: "mouse-gesture",
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async manualUpvoteCurrentPost(input) {
    this.manualCalls.push(input);
    return typeof this.manualResult === "function"
      ? this.manualResult(input)
      : this.manualResult;
  }

  async close() {
    this.closed = true;
  }
}

function createManager(session, persistence) {
  return new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min) => min,
    persistence,
  });
}

function waitForJob(manager, profileId, predicate, timeoutMs = 1_500) {
  const current = manager.get(profileId);
  if (current && predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("change", onChange);
      reject(new Error("Timed out waiting for job state"));
    }, timeoutMs);
    const onChange = (jobs) => {
      const job = jobs.find((item) => item.profileId === profileId);
      if (job && predicate(job)) {
        clearTimeout(timeout);
        manager.off("change", onChange);
        resolve(job);
      }
    };
    manager.on("change", onChange);
  });
}

test("manual upvote freezes the feed timer, verifies one post, then restores the remaining wait", async () => {
  const pending = deferred();
  const events = [];
  const session = new ManualSession(() => pending.promise);
  const manager = createManager(session, {
    createRun: () => 91,
    updateRun: () => {},
    addEvent: (event) => events.push(event),
  });
  const profileId = "manual-success";
  manager.start({ id: profileId, seq: 1, name: "Manual" }, options);
  const waiting = await waitForJob(
    manager,
    profileId,
    (job) => job.status === "waiting" && job.workflowPhase === "feed_wait",
  );
  assert.equal(waiting.currentPost.postId, "p2");
  assert.equal(waiting.manualUpvoteAvailable, true);

  const action = manager.manualUpvote(profileId, "p2");
  await waitForJob(manager, profileId, (job) => job.manualActionPending === true);
  await assert.rejects(() => manager.manualUpvote(profileId, "p2"), /重复提交/);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(session.scrolls, 1, "the feed must not advance while the confirmation is in flight");

  pending.resolve({
    ok: true,
    changed: true,
    alreadyUpvoted: false,
    postId: "p2",
    beforeState: "neutral",
    afterState: "upvoted",
  });
  const result = await action;
  assert.equal(result.changed, true);
  assert.deepEqual(session.manualCalls, [{ expectedPostId: "p2" }]);
  const restored = manager.get(profileId);
  assert.equal(restored.status, "waiting");
  assert.equal(restored.manualActionPending, false);
  assert.equal(restored.currentPostUpvoted, true);
  assert.equal(restored.lastManualUpvote.postId, "p2");
  assert.ok(restored.nextActionAt);
  assert.ok(events.some((event) => event.eventType === "manual_upvote_succeeded"));
  await assert.rejects(() => manager.manualUpvote(profileId, "p2"), /已是点赞状态/);
  assert.equal(session.manualCalls.length, 1, "a verified upvote must not call the browser again");

  await waitForJob(manager, profileId, (job) => job.postCount === 2);
  await manager.stop(profileId);
});

test("a manual upvote failure does not fail the reading job and a pause request is preserved", async () => {
  const pending = deferred();
  const session = new ManualSession(() => pending.promise);
  const manager = createManager(session);
  const profileId = "manual-pause";
  manager.start({ id: profileId, seq: 2, name: "Pause" }, options);
  await waitForJob(manager, profileId, (job) => job.manualUpvoteAvailable === true);

  const action = manager.manualUpvote(profileId, "p2");
  await waitForJob(manager, profileId, (job) => job.manualActionPending === true);
  const pausing = await manager.pause(profileId);
  assert.equal(pausing.status, "pausing");
  pending.resolve({
    ok: false,
    changed: false,
    alreadyUpvoted: false,
    postId: "p2",
    beforeState: "neutral",
    afterState: "neutral",
    reason: "点赞按钮被页面遮挡",
    uncertain: true,
  });
  await assert.rejects(action, /遮挡/);
  const paused = await waitForJob(manager, profileId, (job) => job.status === "paused");
  assert.equal(paused.manualActionPending, false);
  assert.equal(paused.error, null, "a manual action error must not fail the background job");
  assert.equal(paused.manualUpvoteState, "attempted-unknown");
  assert.equal(paused.manualUpvoteAvailable, false);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(session.scrolls, 1);

  manager.resume(profileId);
  await waitForJob(manager, profileId, (job) => job.postCount === 2);
  await manager.stop(profileId);
});

test("manual upvote rejects stale post ids and promoted posts before touching the browser", async () => {
  const session = new ManualSession({ ok: true });
  const manager = createManager(session);
  const profileId = "manual-rejections";
  manager.start({ id: profileId, seq: 3, name: "Reject" }, options);
  await waitForJob(manager, profileId, (job) => job.manualUpvoteAvailable === true);
  await assert.rejects(() => manager.manualUpvote(profileId, "p999"), /帖子已变化/);
  assert.equal(session.manualCalls.length, 0);
  await manager.stop(profileId);

  const promotedSession = new ManualSession({ ok: true });
  promotedSession.scroll = async function scroll() {
    this.scrolls += 1;
    return {
      actualDistance: 300,
      currentY: 300,
      maxY: 5_000,
      atBottom: false,
      newPost: true,
      noPostAvailable: false,
      scrollKind: "next-post",
      postComplete: true,
      currentPost: post(8, { isPromoted: true, clickEligible: false }),
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  };
  const promotedManager = createManager(promotedSession);
  const promotedId = "manual-promoted";
  promotedManager.start({ id: promotedId, seq: 4, name: "Promoted" }, options);
  const promoted = await waitForJob(
    promotedManager,
    promotedId,
    (job) => job.status === "waiting" && job.workflowPhase === "feed_wait",
  );
  assert.equal(promoted.manualUpvoteAvailable, false);
  await assert.rejects(() => promotedManager.manualUpvote(promotedId, "p8"), /广告帖/);
  assert.equal(promotedSession.manualCalls.length, 0);
  await promotedManager.stop(promotedId);
});

test("manual-upvote HTTP endpoint forwards the confirmed post id and returns job plus result", async (t) => {
  class StubJobs extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
    }

    list() {
      return [];
    }

    async manualUpvote(profileId, expectedPostId) {
      this.calls.push({ profileId, expectedPostId });
      return {
        ok: true,
        changed: false,
        alreadyUpvoted: true,
        postId: expectedPostId,
        beforeState: "upvoted",
        afterState: "upvoted",
      };
    }

    get(profileId) {
      return { profileId, manualActionPending: false, currentPostUpvoted: true };
    }
  }

  const jobs = new StubJobs();
  const database = new LocalDatabase(":memory:");
  const { server } = createMonitorServer({
    jobManager: jobs,
    database,
    databasePath: ":memory:",
    bitBrowserApi: { listProfiles: async () => [] },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/jobs/profile%204/manual-upvote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedPostId: "t3_confirmed" }),
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(jobs.calls, [{ profileId: "profile 4", expectedPostId: "t3_confirmed" }]);
  assert.equal(body.result.alreadyUpvoted, true);
  assert.equal(body.job.currentPostUpvoted, true);

  const missing = await fetch(
    `http://127.0.0.1:${server.address().port}/api/jobs/profile%204/manual-upvote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(missing.status, 400);
  assert.equal(jobs.calls.length, 1);
});
