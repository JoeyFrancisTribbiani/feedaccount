import test from "node:test";
import assert from "node:assert/strict";

import { LocalDatabase } from "../src/database.js";
import { JobManager } from "../src/job-manager.js";

const baseOptions = {
  waitMinSec: 1,
  waitMaxSec: 1,
  waitMinMs: 50,
  waitMaxMs: 50,
  maxPosts: 0,
  autoStopAtBottom: true,
  detailLoopEnabled: false,
  autoUpvoteEnabled: false,
  autoUpvoteProbability: 0,
  autoCommentUpvoteEnabled: false,
  autoCommentUpvoteProbability: 0,
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
    clickEligible: true,
  };
}

class JoinSession {
  constructor({ maxScrolls = 6, joinResult = null, joinError = null } = {}) {
    this.scrolls = 0;
    this.maxScrolls = maxScrolls;
    this.closed = false;
    this.joinCalls = [];
    this.joinResult = joinResult;
    this.joinError = joinError;
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
    if (this.scrolls < this.maxScrolls) {
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
    return {
      actualDistance: 0,
      currentY: this.scrolls * 300,
      maxY: 5_000,
      atBottom: true,
      newPost: false,
      noPostAvailable: true,
      scrollKind: "end",
      postComplete: true,
      currentPost: post(this.scrolls + 1),
      inputMethod: null,
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
    };
  }

  async joinSubreddit(name) {
    this.joinCalls.push(name);
    if (this.joinError && this.joinCalls.length === 1) throw this.joinError;
    if (this.joinResult === "alreadyJoined") {
      return { ok: true, alreadyJoined: true, subreddit: name };
    }
    return { ok: true, alreadyJoined: false, subreddit: name };
  }

  async close() {
    this.closed = true;
  }
}

function createManager(session, persistence, randomFn = (min) => min) {
  return new JobManager({
    bitBrowserApi: { openProfile: async () => ({ wsUrl: "ws://127.0.0.1/mock" }) },
    sessionFactory: () => session,
    randomIntegerFn: randomFn,
    persistence,
  });
}

function waitForJob(manager, profileId, predicate, timeoutMs = 3_000) {
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

function mockPersistence(joinTargets = [], joinedHistory = new Set()) {
  return {
    createRun: () => 1,
    updateRun: () => {},
    addEvent: () => {},
    finishRun: () => {},
    getJoinTargets: () => joinTargets.map((name) => ({ name })),
    getJoinedSubredditsForProfile: () => joinedHistory,
    getUpvotedIdsForProfile: () => ({ postIds: new Set(), commentIds: new Set() }),
  };
}

test("auto-join triggers for each target and respects maxPerRun", async () => {
  const session = new JoinSession({ maxScrolls: 8 });
  const targets = ["AskReddit", "worldnews", "gadgets", "programming"];
  const manager = createManager(session, mockPersistence(targets), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: true,
    autoJoinIntervalMinMs: 0,
    autoJoinIntervalMaxMs: 0,
    autoJoinMaxPerRun: 2,
  };

  const profileId = "join-max";
  manager.start({ id: profileId, seq: 1, name: "Join" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 2, "should join exactly maxPerRun targets");
  assert.equal(session.joinCalls[0], "AskReddit");
  assert.equal(session.joinCalls[1], "worldnews");
  assert.equal(completed.autoJoinCount, 2);
  assert.equal(completed.joinedSubredditCount, 2);
  assert.equal(session.closed, true);
});

test("auto-join skips already-joined subreddits", async () => {
  const session = new JoinSession({ maxScrolls: 8 });
  const targets = ["AskReddit", "worldnews", "gadgets"];
  const joinedHistory = new Set(["askreddit"]);
  const manager = createManager(session, mockPersistence(targets, joinedHistory), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: true,
    autoJoinIntervalMinMs: 0,
    autoJoinIntervalMaxMs: 0,
    autoJoinMaxPerRun: 5,
  };

  const profileId = "join-idempotent";
  manager.start({ id: profileId, seq: 2, name: "Idempotent" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 2, "should skip already-joined AskReddit");
  assert.equal(session.joinCalls[0], "worldnews");
  assert.equal(session.joinCalls[1], "gadgets");
  assert.equal(completed.autoJoinCount, 2);
  assert.equal(completed.joinedSubredditCount, 3, "includes restored history");
});

test("auto-join respects interval timing between joins", async () => {
  const session = new JoinSession({ maxScrolls: 8 });
  const targets = ["AskReddit", "worldnews"];
  const manager = createManager(session, mockPersistence(targets), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: true,
    autoJoinIntervalMinMs: 999_999,
    autoJoinIntervalMaxMs: 999_999,
    autoJoinMaxPerRun: 5,
  };

  const profileId = "join-interval";
  manager.start({ id: profileId, seq: 3, name: "Interval" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 1, "should only join once due to long interval");
  assert.equal(session.joinCalls[0], "AskReddit");
  assert.equal(completed.autoJoinCount, 1);
});

test("auto-join error does not crash the job and continues to next target", async () => {
  const joinError = new Error("导航超时");
  const session = new JoinSession({ maxScrolls: 8, joinError });
  const targets = ["BadSub", "GoodSub"];
  const manager = createManager(session, mockPersistence(targets), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: true,
    autoJoinIntervalMinMs: 0,
    autoJoinIntervalMaxMs: 0,
    autoJoinMaxPerRun: 5,
  };

  const profileId = "join-error";
  manager.start({ id: profileId, seq: 4, name: "Error" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 2, "should attempt both targets");
  assert.equal(session.joinCalls[0], "BadSub");
  assert.equal(session.joinCalls[1], "GoodSub");
  assert.equal(completed.autoJoinCount, 1, "only the successful join counts");
  assert.equal(completed.joinedSubredditCount, 1);
  assert.equal(completed.error, null, "job must not have an error");
});

test("auto-join does nothing when disabled", async () => {
  const session = new JoinSession({ maxScrolls: 4 });
  const targets = ["AskReddit", "worldnews"];
  const manager = createManager(session, mockPersistence(targets), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: false,
  };

  const profileId = "join-disabled";
  manager.start({ id: profileId, seq: 5, name: "Disabled" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 0, "no joins when disabled");
  assert.equal(completed.autoJoinCount, 0);
});

test("auto-join does nothing when target list is empty", async () => {
  const session = new JoinSession({ maxScrolls: 4 });
  const manager = createManager(session, mockPersistence([]), (min) => min);

  const options = {
    ...baseOptions,
    autoJoinEnabled: true,
    autoJoinIntervalMinMs: 0,
    autoJoinIntervalMaxMs: 0,
    autoJoinMaxPerRun: 5,
  };

  const profileId = "join-empty";
  manager.start({ id: profileId, seq: 6, name: "Empty" }, options);

  const completed = await waitForJob(manager, profileId, (job) => job.status === "completed");
  assert.equal(session.joinCalls.length, 0, "no joins with empty target list");
  assert.equal(completed.autoJoinCount, 0);
});

test("database persists and retrieves join targets", () => {
  const db = new LocalDatabase(":memory:");
  try {
    assert.deepEqual(db.getJoinTargets(), []);

    const saved = db.saveJoinTargets([
      { name: "AskReddit" },
      { name: "worldnews" },
      { name: "  gadgets  " },
      { noName: true },
      null,
    ]);
    assert.equal(saved.length, 3);
    assert.equal(saved[0].name, "AskReddit");
    assert.equal(saved[1].name, "worldnews");
    assert.equal(saved[2].name, "gadgets");

    const loaded = db.getJoinTargets();
    assert.equal(loaded.length, 3);
    assert.equal(loaded[2].name, "gadgets");

    db.saveJoinTargets([{ name: "programming" }]);
    assert.equal(db.getJoinTargets().length, 1);
    assert.equal(db.getJoinTargets()[0].name, "programming");
  } finally {
    db.close();
  }
});

test("database aggregates joined subreddits across runs for a profile", () => {
  const db = new LocalDatabase(":memory:");
  try {
    const profileId = "profile-join";
    const options = { ...baseOptions, autoJoinEnabled: true, autoJoinIntervalMinMs: 0, autoJoinIntervalMaxMs: 0, autoJoinMaxPerRun: 5 };

    const runId1 = db.createRun({ id: profileId, seq: 1, name: "P" }, options, "https://www.reddit.com/?feed=home", "2026-07-30T00:00:00.000Z");
    db.updateRun({
      runId: runId1, status: "completed", statusText: "done", updatedAt: "2026-07-30T01:00:00.000Z",
      stoppedAt: "2026-07-30T01:00:00.000Z", nextActionAt: null,
      postCount: 5, fullPostCount: 0, totalPixels: 0, lastScrollPixels: 0, currentY: 0, maxY: 0,
      pageTitle: "", pageUrl: "", currentPost: null, currentPostComplete: true,
      workflowPhase: "feed", feedPostsSinceDetail: 0, feedPostsTarget: 0,
      detailVisitCount: 0, commentScrollCount: 0, commentScrollProgress: 0,
      commentScrollTarget: 0, skippedPromotedCount: 0, currentDetailPost: null,
      error: null, upvotedPostIds: [], upvotedCommentIds: [],
      autoUpvoteCount: 0, autoCommentUpvoteCount: 0,
      joinedSubredditIds: ["askreddit", "worldnews"],
      autoJoinCount: 2,
    });

    const runId2 = db.createRun({ id: profileId, seq: 1, name: "P" }, options, "https://www.reddit.com/?feed=home", "2026-07-31T00:00:00.000Z");
    db.updateRun({
      runId: runId2, status: "completed", statusText: "done", updatedAt: "2026-07-31T01:00:00.000Z",
      stoppedAt: "2026-07-31T01:00:00.000Z", nextActionAt: null,
      postCount: 3, fullPostCount: 0, totalPixels: 0, lastScrollPixels: 0, currentY: 0, maxY: 0,
      pageTitle: "", pageUrl: "", currentPost: null, currentPostComplete: true,
      workflowPhase: "feed", feedPostsSinceDetail: 0, feedPostsTarget: 0,
      detailVisitCount: 0, commentScrollCount: 0, commentScrollProgress: 0,
      commentScrollTarget: 0, skippedPromotedCount: 0, currentDetailPost: null,
      error: null, upvotedPostIds: [], upvotedCommentIds: [],
      autoUpvoteCount: 0, autoCommentUpvoteCount: 0,
      joinedSubredditIds: ["gadgets"],
      autoJoinCount: 1,
    });

    const joined = db.getJoinedSubredditsForProfile(profileId);
    assert.equal(joined.size, 3);
    assert.ok(joined.has("askreddit"));
    assert.ok(joined.has("worldnews"));
    assert.ok(joined.has("gadgets"));

    const otherProfile = db.getJoinedSubredditsForProfile("other-profile");
    assert.equal(otherProfile.size, 0);
  } finally {
    db.close();
  }
});
