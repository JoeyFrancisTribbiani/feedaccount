import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { LocalDatabase } from "../src/database.js";
import { JobManager } from "../src/job-manager.js";
import { createMonitorServer } from "../src/server.js";

const options = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 1,
  waitMaxMs: 1,
  maxPosts: 0,
  autoStopAtBottom: false,
  detailLoopEnabled: true,
  detailAfterMinPosts: 1,
  detailAfterMaxPosts: 1,
  detailWaitMinSec: 1,
  detailWaitMaxSec: 1,
  detailWaitMinMs: 1,
  detailWaitMaxMs: 1,
  commentScrollMin: 1,
  commentScrollMax: 1,
  commentStepWaitMinMs: 1,
  commentStepWaitMaxMs: 1,
  returnWaitMinSec: 1,
  returnWaitMaxSec: 1,
  returnWaitMinMs: 260,
  returnWaitMaxMs: 260,
};

function post(number) {
  return {
    postId: `p${number}`,
    title: `Post ${number}`,
    postType: "text",
    feedIndex: number,
    permalink: `https://www.reddit.com/r/test/comments/p${number}/post/`,
    height: 600,
    visibleRatio: 1,
    fullyVisible: true,
    fitPossible: true,
    oversized: false,
    isPromoted: false,
    clickEligible: true,
  };
}

function comment(number) {
  return {
    commentId: `t1_c${number}`,
    fullyVisible: true,
    visibleRatio: 1,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class CommentSession {
  constructor(manualResult) {
    this.manualResult = manualResult;
    this.manualCalls = [];
    this.returnCalls = 0;
    this.commentCalls = 0;
    this.closed = false;
  }

  async connect() {
    return {
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
      y: 0,
      max: 8_000,
      currentPost: post(1),
    };
  }

  async scroll() {
    return {
      actualDistance: 300,
      currentY: 300,
      maxY: 8_000,
      newPost: true,
      scrollKind: "next-post",
      postComplete: true,
      noPostAvailable: false,
      atBottom: false,
      alignmentVerified: true,
      currentPost: post(2),
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async openCurrentPost({ expectedPostId }) {
    return {
      opened: true,
      postId: expectedPostId,
      detailUrl: `https://www.reddit.com/r/test/comments/${expectedPostId}/post/`,
      navigationMode: "same-target",
    };
  }

  async locateComments() {
    return {
      available: true,
      commentCount: 4,
      actualDistance: 300,
      currentY: 900,
      maxY: 5_000,
      atBottom: false,
      currentComment: comment(1),
    };
  }

  async scrollComments() {
    this.commentCalls += 1;
    return {
      moved: true,
      actualDistance: 350,
      currentY: 1_250,
      maxY: 5_000,
      atBottom: false,
      currentComment: comment(2),
    };
  }

  async manualUpvoteCurrentComment(input) {
    this.manualCalls.push(input);
    return typeof this.manualResult === "function"
      ? this.manualResult(input)
      : this.manualResult;
  }

  async returnToFeed() {
    this.returnCalls += 1;
    return {
      returned: true,
      anchorRestored: true,
      currentY: 300,
      maxY: 8_000,
      currentPost: post(2),
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async close() {
    this.closed = true;
  }
}

function managerFor(session, persistence) {
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
      reject(new Error("Timed out waiting for comment-upvote state"));
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

async function startAtReturnWait(manager, profileId) {
  manager.start({ id: profileId, seq: 8, name: "Comment upvote" }, options);
  return waitForJob(
    manager,
    profileId,
    (job) =>
      job.status === "waiting" &&
      job.workflowPhase === "return_wait" &&
      job.currentComment?.commentId === "t1_c2",
  );
}

test("manual comment upvote freezes return wait, verifies one comment, then resumes", async () => {
  const pending = deferred();
  const events = [];
  const session = new CommentSession(() => pending.promise);
  const manager = managerFor(session, {
    createRun: () => 201,
    updateRun: () => {},
    addEvent: (event) => events.push(event),
  });
  const profileId = "comment-success";
  const waiting = await startAtReturnWait(manager, profileId);
  assert.equal(waiting.manualCommentUpvoteAvailable, true);

  const action = manager.manualCommentUpvote(profileId, "t1_c2");
  await waitForJob(manager, profileId, (job) => job.manualCommentActionPending === true);
  assert.throws(() => manager.triggerNow(profileId), /人工确认点赞/);
  await assert.rejects(
    () => manager.manualCommentUpvote(profileId, "t1_c2"),
    /重复提交/,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(session.returnCalls, 0, "return timer must stay frozen during confirmation");

  pending.resolve({
    ok: true,
    changed: true,
    alreadyUpvoted: false,
    uncertain: false,
    commentId: "t1_c2",
    beforeState: "neutral",
    afterState: "upvoted",
  });
  const result = await action;
  assert.equal(result.changed, true);
  const restored = manager.get(profileId);
  assert.equal(restored.manualCommentActionPending, false);
  assert.equal(restored.manualCommentUpvoteState, "upvoted");
  assert.equal(restored.manualCommentUpvoteAvailable, false);
  assert.deepEqual(session.manualCalls, [{ expectedCommentId: "t1_c2" }]);
  assert.ok(events.some((event) => event.eventType === "manual_comment_upvote_succeeded"));
  await assert.rejects(
    () => manager.manualCommentUpvote(profileId, "t1_c2"),
    /已是点赞状态/,
  );
  assert.equal(session.manualCalls.length, 1);

  await waitForJob(manager, profileId, () => session.returnCalls === 1);
  await manager.stop(profileId);
});

test("manual comment upvote is also available during the stable gap between comment scrolls", async () => {
  const session = new CommentSession({
    ok: true,
    changed: true,
    alreadyUpvoted: false,
    uncertain: false,
    commentId: "t1_c2",
    beforeState: "neutral",
    afterState: "upvoted",
  });
  const manager = managerFor(session);
  const profileId = "comment-gap";
  manager.start(
    { id: profileId, seq: 9, name: "Comment gap" },
    {
      ...options,
      commentScrollMin: 2,
      commentScrollMax: 2,
      commentStepWaitMinMs: 260,
      commentStepWaitMaxMs: 260,
    },
  );
  const gap = await waitForJob(
    manager,
    profileId,
    (job) =>
      job.status === "waiting" &&
      job.workflowPhase === "comment_scrolling" &&
      job.currentComment?.commentId === "t1_c2",
  );
  assert.equal(gap.manualCommentUpvoteAvailable, true);
  const result = await manager.manualCommentUpvote(profileId, "t1_c2");
  assert.equal(result.changed, true);
  assert.equal(manager.get(profileId).workflowPhase, "comment_scrolling");
  await manager.stop(profileId);
});

test("comment upvote remains available while paused and does not resume the task", async () => {
  const session = new CommentSession({
    ok: true,
    changed: false,
    alreadyUpvoted: true,
    uncertain: false,
    commentId: "t1_c2",
    beforeState: "upvoted",
    afterState: "upvoted",
  });
  const manager = managerFor(session);
  const profileId = "comment-paused";
  await startAtReturnWait(manager, profileId);
  const paused = await manager.pause(profileId);
  assert.equal(paused.status, "paused");
  assert.equal(paused.manualCommentUpvoteAvailable, true);

  const result = await manager.manualCommentUpvote(profileId, "c2");
  assert.equal(result.alreadyUpvoted, true);
  assert.equal(result.commentId, "c2", "the API-facing result echoes the confirmed alias");
  const after = manager.get(profileId);
  assert.equal(after.status, "paused");
  assert.equal(after.nextActionAt, null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(session.returnCalls, 0);

  manager.resume(profileId);
  await waitForJob(manager, profileId, () => session.returnCalls === 1);
  await manager.stop(profileId);
});

test("stale comment ids and uncertain outcomes fail closed without failing the job", async () => {
  const session = new CommentSession({
    ok: false,
    changed: false,
    alreadyUpvoted: false,
    uncertain: true,
    commentId: "t1_c2",
    beforeState: "neutral",
    afterState: "unknown",
    reason: "comment-upvote-not-confirmed",
  });
  const manager = managerFor(session);
  const profileId = "comment-uncertain";
  await startAtReturnWait(manager, profileId);
  await assert.rejects(
    () => manager.manualCommentUpvote(profileId, "t1_stale"),
    /评论已变化/,
  );
  assert.equal(session.manualCalls.length, 0);
  await assert.rejects(
    () => manager.manualCommentUpvote(profileId, "t1_c2"),
    /not-confirmed/,
  );
  const job = manager.get(profileId);
  assert.equal(job.status, "waiting");
  assert.equal(job.error, null);
  assert.equal(job.manualCommentUpvoteState, "attempted-unknown");
  assert.equal(job.manualCommentUpvoteAvailable, false);
  await manager.stop(profileId);
});

test("manual-comment-upvote endpoint validates and forwards the confirmed comment id", async (t) => {
  class StubJobs extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
    }

    list() {
      return [];
    }

    async manualCommentUpvote(profileId, expectedCommentId) {
      this.calls.push({ profileId, expectedCommentId });
      return {
        ok: true,
        changed: true,
        alreadyUpvoted: false,
        commentId: expectedCommentId,
        beforeState: "neutral",
        afterState: "upvoted",
      };
    }

    get(profileId) {
      return { profileId, manualCommentUpvoteState: "upvoted" };
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
  const endpoint =
    `http://127.0.0.1:${server.address().port}` +
    "/api/jobs/profile%204/manual-comment-upvote";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedCommentId: "t1_confirmed" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(jobs.calls, [
    { profileId: "profile 4", expectedCommentId: "t1_confirmed" },
  ]);
  assert.equal(body.result.changed, true);

  const missing = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 400);
  assert.equal(jobs.calls.length, 1);
});
