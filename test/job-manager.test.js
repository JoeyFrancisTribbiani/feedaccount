import test from "node:test";
import assert from "node:assert/strict";

import { JobManager } from "../src/job-manager.js";

const testOptions = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 5,
  waitMaxMs: 5,
  maxPosts: 0,
  autoStopAtBottom: true,
};

function visiblePost(number, fullyVisible = true) {
  return {
    postId: `p${number}`,
    title: `Post ${number}`,
    postType: "text",
    feedIndex: number,
    permalink: `https://www.reddit.com/r/test/comments/p${number}/post/`,
    height: 600,
    visibleRatio: fullyVisible ? 1 : 0.8,
    fullyVisible,
    fitPossible: true,
    oversized: false,
  };
}

class FakeSession {
  constructor() {
    this.scrolls = 0;
    this.closed = false;
  }

  async connect() {
    return {
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
      y: 0,
      max: 1_000,
      currentPost: visiblePost(1),
    };
  }

  async scroll() {
    this.scrolls += 1;
    if (this.scrolls <= 2) {
      const currentY = this.scrolls * 300;
      return {
        actualDistance: 300,
        currentY,
        maxY: 1_000,
        newPost: true,
        scrollKind: "next-post",
        postComplete: true,
        noPostAvailable: false,
        atBottom: false,
        currentPost: visiblePost(this.scrolls + 1),
        inputMethod: "mouse-gesture",
        title: "Reddit",
        url: "https://www.reddit.com/?feed=home",
      };
    }
    return {
      actualDistance: 0,
      currentY: 600,
      maxY: 600,
      newPost: false,
      scrollKind: "end",
      postComplete: true,
      noPostAvailable: true,
      atBottom: true,
      currentPost: visiblePost(3),
      inputMethod: null,
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async close() {
    this.closed = true;
  }
}

function waitForStatus(manager, profileId, status, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("change", onChange);
      reject(new Error(`Timed out waiting for ${status}`));
    }, timeoutMs);
    const onChange = (jobs) => {
      const job = jobs.find((item) => item.profileId === profileId);
      if (job?.status === status) {
        clearTimeout(timeout);
        manager.off("change", onChange);
        resolve(job);
      }
    };
    manager.on("change", onChange);
  });
}

function waitForJob(manager, profileId, predicate, timeoutMs = 1_500) {
  const current = manager.get(profileId);
  if (current && predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("change", onChange);
      reject(new Error("Timed out waiting for matching job state"));
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

test("each job reads posts independently and completes when no next post remains", async () => {
  const sessions = [];
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    randomIntegerFn: (min) => min,
  });

  const completed = waitForStatus(manager, "profile-1", "completed");
  manager.start({ id: "profile-1", seq: 1, name: "Test profile" }, testOptions);
  const job = await completed;

  assert.equal(job.postCount, 2);
  assert.equal(job.scrollCount, 2, "legacy public counter mirrors the post count");
  assert.equal(job.fullPostCount, 2);
  assert.equal(job.totalPixels, 600);
  assert.equal(job.currentPost.postId, "p3");
  assert.equal(job.currentPostComplete, true);
  assert.equal(sessions[0].closed, true);
});

test("stopping a job closes only its own session", async () => {
  const sessions = new Map();
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: (job) => {
      const session = new FakeSession();
      sessions.set(job.profileId, session);
      return session;
    },
    randomIntegerFn: () => 500,
  });

  const runningOptions = { ...testOptions, autoStopAtBottom: false };
  manager.start({ id: "profile-a", seq: 1, name: "A" }, runningOptions);
  manager.start({ id: "profile-b", seq: 2, name: "B" }, runningOptions);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await manager.stop("profile-a");

  assert.equal(manager.get("profile-a").status, "stopped");
  assert.equal(sessions.get("profile-a").closed, true);
  assert.ok(["waiting", "scrolling"].includes(manager.get("profile-b").status));
  assert.equal(sessions.get("profile-b").closed, false);
  await manager.stop("profile-b");
});

test("an incompletely aligned normal post retries without entering reading wait", async () => {
  const randomRanges = [];
  const observed = [];
  const session = new FakeSession();
  session.scroll = async function scroll() {
    this.scrolls += 1;
    if (this.scrolls === 1) {
      return {
        actualDistance: 112,
        currentY: 112,
        maxY: 1_000,
        newPost: false,
        scrollKind: "alignment-pending",
        postComplete: false,
        noPostAvailable: false,
        atBottom: false,
        alignmentVerified: false,
        alignmentPending: true,
        segmentReady: false,
        currentPost: visiblePost(1, false),
        inputMethod: "mouse-gesture",
        title: "Reddit",
        url: "https://www.reddit.com/?feed=home",
      };
    }
    return {
      actualDistance: 449,
      currentY: 561,
      maxY: 1_000,
      newPost: true,
      scrollKind: "realign-post",
      postComplete: true,
      noPostAvailable: false,
      atBottom: false,
      alignmentVerified: true,
      alignmentPending: false,
      segmentReady: true,
      currentPost: visiblePost(1, true),
      inputMethod: "mouse-wheel",
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  };

  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min, max) => {
      randomRanges.push([min, max]);
      return min;
    },
  });
  manager.on("change", (jobs) => {
    const job = jobs.find((item) => item.profileId === "profile-align-retry");
    if (job) observed.push({ status: job.status, postCount: job.postCount, calls: session.scrolls });
  });

  manager.start(
    { id: "profile-align-retry", seq: 9, name: "Alignment retry" },
    { ...testOptions, waitMinMs: 10_000, waitMaxMs: 10_000 },
  );
  const pending = await waitForJob(
    manager,
    "profile-align-retry",
    (job) => job.alignmentPending && job.alignmentRetryCount === 1,
  );

  assert.equal(pending.status, "scrolling");
  assert.equal(pending.postCount, 0);
  assert.equal(pending.fullPostCount, 0);
  assert.ok(pending.nextActionAt, "a short corrective retry should be scheduled");

  const aligned = await waitForJob(
    manager,
    "profile-align-retry",
    (job) => job.status === "waiting" && job.postCount === 1,
  );
  assert.equal(aligned.alignmentPending, false);
  assert.equal(aligned.alignmentRetryCount, 0);
  assert.equal(aligned.fullPostCount, 1);
  assert.equal(session.scrolls, 2);
  assert.deepEqual(randomRanges[0], [200, 500], "the first delay is an alignment retry");
  assert.deepEqual(randomRanges[1], [10_000, 10_000], "normal reading wait starts only after alignment");
  assert.equal(
    observed.some((state) => state.status === "waiting" && state.calls < 2),
    false,
    "an incomplete normal post must never enter the normal reading wait",
  );

  await manager.stop("profile-align-retry");
});
