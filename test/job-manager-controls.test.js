import test from "node:test";
import assert from "node:assert/strict";

import { JobManager } from "../src/job-manager.js";

const runningOptions = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 500,
  waitMaxMs: 500,
  maxPosts: 0,
  autoStopAtBottom: false,
};

function post(number) {
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

  async close() {
    this.closed = true;
  }
}

function waitForJob(manager, profileId, predicate, timeoutMs = 1_000) {
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

test("pause holds a reading job, resume continues it, and trigger opens the next post now", async () => {
  const session = new FakeSession();
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min) => min,
  });

  manager.start({ id: "profile-controls", seq: 3, name: "Controls" }, runningOptions);
  await waitForJob(
    manager,
    "profile-controls",
    (job) => job.status === "waiting" && job.postCount === 1,
  );

  const paused = await manager.pause("profile-controls");
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextActionAt, null);
  assert.equal(session.closed, false);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(session.scrolls, 1, "the cancelled wait timer must not advance while paused");

  const resumed = waitForJob(
    manager,
    "profile-controls",
    (job) => job.status === "waiting" && job.postCount === 2,
  );
  manager.resume("profile-controls");
  const afterResume = await resumed;
  assert.equal(afterResume.fullPostCount, 2);
  assert.equal(afterResume.currentPost.postId, "p3");

  const triggered = waitForJob(
    manager,
    "profile-controls",
    (job) => job.status === "waiting" && job.postCount === 3,
  );
  manager.triggerNow("profile-controls");
  const afterTrigger = await triggered;
  assert.equal(afterTrigger.currentPost.postId, "p4");

  await manager.stop("profile-controls");
  assert.equal(manager.get("profile-controls").status, "stopped");
  assert.equal(session.closed, true);
});

test("JobManager persists post navigation and final per-post state", async () => {
  const calls = { created: [], updated: [], events: [] };
  const persistence = {
    createRun(profile, options, targetUrl, startedAt) {
      calls.created.push({ profile, options, targetUrl, startedAt });
      return 42;
    },
    updateRun(job) {
      calls.updated.push({
        runId: job.runId,
        status: job.status,
        postCount: job.postCount,
        fullPostCount: job.fullPostCount,
        currentPostId: job.currentPost?.postId || null,
      });
    },
    addEvent(event) {
      calls.events.push(event);
      return calls.events.length;
    },
  };
  const session = new FakeSession();
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min) => min,
    persistence,
  });
  const onePost = {
    ...runningOptions,
    waitMinMs: 10_000,
    waitMaxMs: 10_000,
    maxPosts: 1,
  };

  const completed = waitForJob(manager, "profile-persisted", (job) => job.status === "completed");
  const started = manager.start(
    { id: "profile-persisted", seq: 4, name: "Persisted" },
    onePost,
  );
  assert.equal(started.runId, 42);
  const finalJob = await completed;

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].targetUrl, "https://www.reddit.com/?feed=home");
  assert.ok(calls.events.some((event) => event.eventType === "post_navigation"));
  assert.ok(calls.events.some((event) => event.eventType === "lifecycle"));
  assert.deepEqual(calls.updated.at(-1), {
    runId: 42,
    status: "completed",
    postCount: 1,
    fullPostCount: 1,
    currentPostId: "p2",
  });
  assert.equal(finalJob.currentPost.postId, "p2");
  assert.equal(session.closed, true);
});

test("pause cancels a short alignment retry and resume continues correction", async () => {
  const session = new FakeSession();
  session.scroll = async function scroll() {
    this.scrolls += 1;
    const aligned = this.scrolls > 1;
    return {
      actualDistance: aligned ? 449 : 112,
      currentY: aligned ? 561 : 112,
      maxY: 5_000,
      atBottom: false,
      newPost: aligned,
      noPostAvailable: false,
      scrollKind: aligned ? "realign-post" : "alignment-pending",
      postComplete: aligned,
      alignmentVerified: aligned,
      alignmentPending: !aligned,
      segmentReady: aligned,
      currentPost: {
        ...post(1),
        visibleRatio: aligned ? 1 : 0.62,
        fullyVisible: aligned,
      },
      inputMethod: aligned ? "mouse-wheel" : "mouse-gesture",
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  };
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min) => min,
  });

  manager.start({ id: "profile-pause-align", seq: 5, name: "Pause align" }, runningOptions);
  await waitForJob(
    manager,
    "profile-pause-align",
    (job) => job.alignmentPending && job.alignmentRetryCount === 1,
  );
  const paused = await manager.pause("profile-pause-align");
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextActionAt, null);

  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(session.scrolls, 1, "the 200-500ms corrective timer must stay cancelled");

  const resumed = waitForJob(
    manager,
    "profile-pause-align",
    (job) => job.status === "waiting" && job.postCount === 1,
  );
  manager.resume("profile-pause-align");
  const aligned = await resumed;
  assert.equal(aligned.alignmentPending, false);
  assert.equal(aligned.currentPost.fullyVisible, true);
  assert.equal(session.scrolls, 2);

  await manager.stop("profile-pause-align");
});

test("verified tall-post segments use reading waits without double-counting posts", async () => {
  function tallPost(id, height, visibleRatio) {
    return {
      postId: id,
      title: `Tall ${id}`,
      postType: "text",
      feedIndex: id === "p771" ? 1 : 2,
      permalink: `https://www.reddit.com/comments/${id}`,
      height,
      visibleRatio,
      fullyVisible: false,
      fitPossible: false,
      oversized: true,
    };
  }

  const steps = [
    { post: tallPost("p771", 771, 748 / 771), newPost: true, complete: false, distance: 0, kind: "current-post" },
    { post: tallPost("p771", 771, 748 / 771), newPost: false, complete: true, distance: 23, kind: "continue-post" },
    { post: tallPost("p1800", 1_800, 748 / 1_800), newPost: true, complete: false, distance: 100, kind: "next-post" },
    { post: tallPost("p1800", 1_800, 748 / 1_800), newPost: false, complete: false, distance: 668, kind: "continue-post" },
    { post: tallPost("p1800", 1_800, 748 / 1_800), newPost: false, complete: true, distance: 384, kind: "continue-post" },
  ];
  const session = new FakeSession();
  session.scroll = async function scroll() {
    const step = steps[this.scrolls];
    this.scrolls += 1;
    return {
      actualDistance: step.distance,
      currentY: steps.slice(0, this.scrolls).reduce((sum, item) => sum + item.distance, 0),
      maxY: 8_000,
      atBottom: false,
      newPost: step.newPost,
      noPostAvailable: false,
      scrollKind: step.kind,
      postComplete: step.complete,
      alignmentVerified: true,
      alignmentPending: false,
      segmentReady: true,
      currentPost: step.post,
      inputMethod: step.distance ? "mouse-gesture" : null,
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  };
  const manager = new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: (min) => min,
  });
  const profileId = "profile-tall-segments";
  manager.start({ id: profileId, seq: 6, name: "Tall segments" }, runningOptions);

  for (let expectedCalls = 1; expectedCalls <= steps.length; expectedCalls += 1) {
    const state = await waitForJob(
      manager,
      profileId,
      (job) => job.status === "waiting" && session.scrolls === expectedCalls,
    );
    assert.equal(state.alignmentPending, false);
    assert.equal(state.alignmentRetryCount, 0);
    assert.equal(state.postCount, expectedCalls < 3 ? 1 : 2);
    assert.equal(state.fullPostCount, 0, "an oversized post is never mislabeled fully visible");
    if (expectedCalls < steps.length) manager.triggerNow(profileId);
  }

  const final = manager.get(profileId);
  assert.equal(final.currentPost.postId, "p1800");
  assert.equal(final.currentPostComplete, true);
  assert.equal(final.postCount, 2);
  assert.equal(session.scrolls, 5);
  await manager.stop(profileId);
});
