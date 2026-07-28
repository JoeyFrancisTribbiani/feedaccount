import test from "node:test";
import assert from "node:assert/strict";

import { JobManager } from "../src/job-manager.js";

function post(number, overrides = {}) {
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
    ...overrides,
  };
}

const detailOptions = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 1,
  waitMaxMs: 1,
  maxPosts: 0,
  autoStopAtBottom: false,
  detailLoopEnabled: true,
  detailAfterMinPosts: 3,
  detailAfterMaxPosts: 3,
  detailWaitMinSec: 2,
  detailWaitMaxSec: 15,
  detailWaitMinMs: 1,
  detailWaitMaxMs: 1,
  commentScrollMin: 2,
  commentScrollMax: 2,
  commentStepWaitMinMs: 1,
  commentStepWaitMaxMs: 1,
  returnWaitMinSec: 2,
  returnWaitMaxSec: 4,
  returnWaitMinMs: 1,
  returnWaitMaxMs: 1,
};

class DetailSession {
  constructor(feedPosts = [post(2), post(3), post(4), post(5)]) {
    this.feedPosts = feedPosts;
    this.scrollIndex = 0;
    this.openedPostIds = [];
    this.locateCalls = 0;
    this.commentCalls = 0;
    this.returnCalls = 0;
    this.closed = false;
  }

  async connect() {
    return {
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
      y: 0,
      max: 10_000,
      currentPost: post(1),
    };
  }

  async scroll() {
    const currentPost = this.feedPosts[this.scrollIndex] || post(100 + this.scrollIndex);
    this.scrollIndex += 1;
    return {
      actualDistance: 300,
      currentY: this.scrollIndex * 300,
      maxY: 10_000,
      newPost: true,
      scrollKind: "next-post",
      postComplete: true,
      noPostAvailable: false,
      atBottom: false,
      alignmentVerified: true,
      currentPost,
      inputMethod: "mouse-gesture",
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async openCurrentPost({ expectedPostId }) {
    this.openedPostIds.push(expectedPostId);
    return {
      opened: true,
      postId: expectedPostId,
      detailUrl: `https://www.reddit.com/r/test/comments/${expectedPostId}/post/`,
      navigationMode: "same-target",
    };
  }

  async locateComments() {
    this.locateCalls += 1;
    return {
      available: true,
      commentCount: 10,
      actualDistance: 500,
      currentY: 1_400,
      maxY: 8_000,
      atBottom: false,
    };
  }

  async scrollComments() {
    this.commentCalls += 1;
    return {
      moved: true,
      actualDistance: 400,
      currentY: 1_400 + this.commentCalls * 400,
      maxY: 8_000,
      atBottom: false,
    };
  }

  async returnToFeed() {
    this.returnCalls += 1;
    return {
      returned: true,
      anchorRestored: true,
      actualDistance: 0,
      currentY: 900,
      maxY: 10_000,
      currentPost: this.feedPosts[Math.max(0, this.scrollIndex - 1)],
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async close() {
    this.closed = true;
  }
}

function waitForJob(manager, profileId, predicate, timeoutMs = 1_500) {
  const current = manager.get(profileId);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("change", onChange);
      reject(new Error("Timed out waiting for detail workflow state"));
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

function managerFor(session, randomIntegerFn = (min) => min) {
  return new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn,
  });
}

test("readonly detail workflow opens after three real feed advances and returns after two comment scrolls", async () => {
  const session = new DetailSession();
  const manager = managerFor(session);
  const profileId = "profile-detail-cycle";
  manager.start({ id: profileId, seq: 1, name: "Detail cycle" }, detailOptions);

  const completedCycle = await waitForJob(
    manager,
    profileId,
    (job) =>
      job.detailVisitCount === 1 &&
      job.workflowPhase === "feed_align" &&
      job.feedPostsSinceDetail === 0,
  );

  assert.deepEqual(session.openedPostIds, ["p4"]);
  assert.equal(session.locateCalls, 1);
  assert.equal(session.commentCalls, 2);
  assert.equal(session.returnCalls, 1);
  assert.equal(completedCycle.postCount, 3);
  assert.equal(completedCycle.detailVisitCount, 1);
  assert.equal(completedCycle.commentScrollCount, 2);
  assert.equal(completedCycle.feedPostsTarget, 3);
  assert.equal(
    completedCycle.logs.some((entry) => entry.eventType === "detail_cycle_complete"),
    true,
  );
  await manager.stop(profileId);
});

test("a promoted unit at the threshold is counted as a feed advance but is never opened", async () => {
  const promoted = post(4, {
    title: "Promoted",
    isPromoted: true,
    clickEligible: false,
    ineligibleReason: "promoted",
  });
  const session = new DetailSession([post(2), post(3), promoted, post(5)]);
  const manager = managerFor(session);
  const profileId = "profile-skip-promoted";
  manager.start(
    { id: profileId, seq: 2, name: "Skip promoted" },
    { ...detailOptions, detailWaitMinMs: 10_000, detailWaitMaxMs: 10_000 },
  );

  const opened = await waitForJob(
    manager,
    profileId,
    (job) => job.detailVisitCount === 1 && job.workflowPhase === "detail_wait",
  );
  assert.deepEqual(session.openedPostIds, ["p5"]);
  assert.equal(opened.feedPostsSinceDetail, 4, "the ad still counts as a downward feed unit");
  assert.equal(opened.postCount, 3, "the ad is excluded from the organic post counter");
  assert.equal(opened.skippedPromotedCount, 1);
  assert.equal(
    opened.logs.some(
      (entry) => entry.eventType === "detail_candidate_skipped" && entry.message.includes("广告"),
    ),
    true,
  );
  await manager.stop(profileId);
});

test("pausing a detail wait preserves the pending operation and does not locate comments early", async () => {
  const session = new DetailSession();
  const manager = managerFor(session);
  const profileId = "profile-pause-detail";
  manager.start(
    { id: profileId, seq: 3, name: "Pause detail" },
    { ...detailOptions, detailWaitMinMs: 120, detailWaitMaxMs: 120 },
  );
  await waitForJob(
    manager,
    profileId,
    (job) => job.workflowPhase === "detail_wait" && job.status === "waiting",
  );

  const paused = await manager.pause(profileId);
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextOperation, "locate-comments");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(session.locateCalls, 0);

  manager.resume(profileId);
  await waitForJob(manager, profileId, (job) => job.workflowPhase === "locating_comments");
  assert.equal(session.locateCalls, 1);
  await manager.stop(profileId);
});
