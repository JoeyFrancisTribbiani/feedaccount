import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LocalDatabase } from "../src/database.js";

const options = {
  waitMinSec: 2,
  waitMaxSec: 4,
  waitMinMs: 2_000,
  waitMaxMs: 4_000,
  maxPosts: 10,
  autoStopAtBottom: true,
  detailLoopEnabled: true,
  detailAfterMinPosts: 3,
  detailAfterMaxPosts: 8,
  detailWaitMinSec: 2,
  detailWaitMaxSec: 15,
  commentScrollMin: 2,
  commentScrollMax: 7,
  returnWaitMinSec: 2,
  returnWaitMaxSec: 4,
};

function currentPost() {
  return {
    postId: "p3",
    title: "Third post",
    postType: "text",
    feedIndex: 3,
    permalink: "https://www.reddit.com/comments/p3",
    height: 600,
    visibleRatio: 1,
    fullyVisible: true,
    fitPossible: true,
    oversized: false,
  };
}

function completedJob(runId) {
  return {
    runId,
    status: "completed",
    statusText: "Completed",
    updatedAt: "2026-07-15T00:00:05.000Z",
    stoppedAt: "2026-07-15T00:00:05.000Z",
    nextActionAt: null,
    postCount: 2,
    fullPostCount: 1,
    totalPixels: 300,
    lastScrollPixels: 200,
    currentY: 300,
    maxY: 1_000,
    currentPost: currentPost(),
    currentPostComplete: true,
    workflowPhase: "comment_scrolling",
    feedPostsSinceDetail: 6,
    feedPostsTarget: 6,
    detailVisitCount: 1,
    commentScrollCount: 3,
    commentScrollProgress: 3,
    commentScrollTarget: 5,
    skippedPromotedCount: 1,
    currentDetailPost: {
      postId: "p3",
      title: "Third post",
      permalink: "https://www.reddit.com/comments/p3",
    },
    pageTitle: "Reddit",
    pageUrl: "https://www.reddit.com/?feed=home",
    error: null,
  };
}

test("LocalDatabase persists per-post settings, runs, events and aggregate stats", (t) => {
  const database = new LocalDatabase(":memory:");
  t.after(() => database.close());

  database.upsertProfiles([
    { id: "profile-1", seq: 1, name: "Profile one", status: 1, running: true, pid: 1234 },
  ]);
  database.upsertProfiles([
    { id: "profile-1", seq: 1, name: "Renamed profile", status: 0, running: false, pid: null },
  ]);

  assert.deepEqual(database.saveOptions(options), {
    waitMinSec: 2,
    waitMaxSec: 4,
    maxPosts: 10,
    autoStopAtBottom: true,
    detailLoopEnabled: true,
    detailAfterMinPosts: 3,
    detailAfterMaxPosts: 8,
    detailWaitMinSec: 2,
    detailWaitMaxSec: 15,
    commentScrollMin: 2,
    commentScrollMax: 7,
    returnWaitMinSec: 2,
    returnWaitMaxSec: 4,
    autoUpvoteEnabled: false,
    autoUpvoteProbability: 0,
    autoCommentUpvoteEnabled: false,
    autoCommentUpvoteProbability: 0,
  });
  assert.deepEqual(database.getSavedOptions(), {
    waitMinSec: 2,
    waitMaxSec: 4,
    maxPosts: 10,
    autoStopAtBottom: true,
    detailLoopEnabled: true,
    detailAfterMinPosts: 3,
    detailAfterMaxPosts: 8,
    detailWaitMinSec: 2,
    detailWaitMaxSec: 15,
    commentScrollMin: 2,
    commentScrollMax: 7,
    returnWaitMinSec: 2,
    returnWaitMaxSec: 4,
    autoUpvoteEnabled: false,
    autoUpvoteProbability: 0,
    autoCommentUpvoteEnabled: false,
    autoCommentUpvoteProbability: 0,
  });

  const runId = database.createRun(
    { id: "profile-1", seq: 1, name: "Renamed profile" },
    options,
    "https://www.reddit.com/?feed=home",
    "2026-07-15T00:00:00.000Z",
  );
  database.addEvent({
    runId,
    profileId: "profile-1",
    level: "info",
    eventType: "post_navigation",
    message: "Opened post",
    data: { postId: "p2", fullyVisible: true },
  });
  database.addEvent({
    runId,
    profileId: "profile-1",
    level: "error",
    eventType: "error",
    message: "Example error event",
  });
  database.updateRun(completedJob(runId));

  const [run] = database.listRuns({ profileId: "profile-1", status: "completed" });
  assert.equal(run.id, runId);
  assert.equal(run.profileName, "Renamed profile");
  assert.equal(run.taskMode, "post");
  assert.equal(run.workflowMode, "feed_detail_readonly");
  assert.equal(run.workflowPhase, "comment_scrolling");
  assert.equal(run.postCount, 2);
  assert.equal(run.fullPostCount, 1);
  assert.equal(run.scrollCount, 2, "legacy column mirrors post count for new runs");
  assert.equal(run.totalPixels, 300);
  assert.equal(run.options.maxPosts, 10);
  assert.equal(run.options.autoStopAtBottom, true);
  assert.deepEqual(run.currentPost, currentPost());
  assert.equal(run.currentPostComplete, true);
  assert.equal(run.feedPostsSinceDetail, 6);
  assert.equal(run.feedPostsTarget, 6);
  assert.equal(run.detailVisitCount, 1);
  assert.equal(run.commentScrollCount, 3);
  assert.equal(run.commentScrollProgress, 3);
  assert.equal(run.commentScrollTarget, 5);
  assert.equal(run.skippedPromotedCount, 1);
  assert.equal(run.currentDetailPost.title, "Third post");

  const detail = database.getRun(runId);
  assert.equal(detail.events.length, 2);
  assert.deepEqual(
    detail.events.find((event) => event.eventType === "post_navigation").data,
    { postId: "p2", fullyVisible: true },
  );
  assert.equal(database.listEvents({ level: "error" }).length, 1);

  assert.deepEqual(database.getStats(), {
    profileCount: 1,
    runCount: 1,
    scrollCount: 2,
    postCount: 2,
    fullPostCount: 1,
    detailVisitCount: 1,
    commentScrollCount: 3,
    skippedPromotedCount: 1,
    autoUpvoteCount: 0,
    autoCommentUpvoteCount: 0,
    totalPixels: 300,
    completedCount: 1,
    errorCount: 0,
    eventCount: 2,
  });

  assert.equal(database.clearEvents({ profileId: "profile-1" }), 2);
  assert.equal(database.getStats().eventCount, 0);
});

test("LocalDatabase migrates legacy pixel runs without relabeling their history", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "reddit-flow-legacy-"));
  const databasePath = path.join(temporaryDirectory, "legacy.db");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        profile_seq INTEGER,
        profile_name TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL,
        status_text TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stopped_at TEXT,
        next_action_at TEXT,
        wait_min_sec INTEGER NOT NULL,
        wait_max_sec INTEGER NOT NULL,
        scroll_min_px INTEGER NOT NULL,
        scroll_max_px INTEGER NOT NULL,
        max_scrolls INTEGER NOT NULL,
        auto_stop_at_bottom INTEGER NOT NULL DEFAULT 0,
        scroll_count INTEGER NOT NULL DEFAULT 0,
        total_pixels INTEGER NOT NULL DEFAULT 0,
        last_scroll_pixels INTEGER NOT NULL DEFAULT 0,
        current_y INTEGER NOT NULL DEFAULT 0,
        max_y INTEGER NOT NULL DEFAULT 0,
        page_title TEXT NOT NULL DEFAULT '',
        page_url TEXT NOT NULL DEFAULT '',
        error TEXT
      );
    `);
    legacy
      .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('task_options', ?, ?)")
      .run(
        JSON.stringify({
          waitMinSec: 3,
          waitMaxSec: 6,
          scrollMinPx: 100,
          scrollMaxPx: 200,
          maxScrolls: 7,
          autoStopAtBottom: true,
        }),
        "2026-07-14T00:00:00.000Z",
      );
    legacy
      .prepare(`
        INSERT INTO task_runs (
          profile_id, profile_seq, profile_name, target_url, status, status_text,
          started_at, updated_at, stopped_at, wait_min_sec, wait_max_sec,
          scroll_min_px, scroll_max_px, max_scrolls, auto_stop_at_bottom,
          scroll_count, total_pixels, last_scroll_pixels, current_y, max_y,
          page_title, page_url
        ) VALUES (?, ?, ?, ?, 'completed', 'Completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "legacy-profile",
        9,
        "Legacy profile",
        "https://www.reddit.com/?feed=home",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:01:00.000Z",
        "2026-07-14T00:01:00.000Z",
        3,
        6,
        100,
        200,
        7,
        1,
        3,
        450,
        200,
        450,
        2_000,
        "Reddit",
        "https://www.reddit.com/?feed=home",
      );
    legacy.close();

    const migrated = new LocalDatabase(databasePath);
    try {
      const [run] = migrated.listRuns();
      assert.equal(run.taskMode, "pixel");
      assert.equal(run.workflowMode, "feed_only");
      assert.deepEqual(run.options, {
        waitMinSec: 3,
        waitMaxSec: 6,
        scrollMinPx: 100,
        scrollMaxPx: 200,
        maxScrolls: 7,
        autoStopAtBottom: true,
      });
      assert.equal(run.scrollCount, 3);
      assert.equal(run.postCount, 0);
      assert.equal(run.fullPostCount, 0);
      assert.equal(run.currentPost, null);
      assert.deepEqual(migrated.getSavedOptions(), {
        waitMinSec: 3,
        waitMaxSec: 6,
        maxPosts: 7,
        autoStopAtBottom: true,
        detailLoopEnabled: true,
        detailAfterMinPosts: 3,
        detailAfterMaxPosts: 8,
        detailWaitMinSec: 2,
        detailWaitMaxSec: 15,
        commentScrollMin: 2,
        commentScrollMax: 7,
        returnWaitMinSec: 2,
        returnWaitMaxSec: 4,
        autoUpvoteEnabled: false,
        autoUpvoteProbability: 0,
        autoCommentUpvoteEnabled: false,
        autoCommentUpvoteProbability: 0,
      });
      assert.equal(migrated.getStats().scrollCount, 3);
      assert.equal(migrated.getStats().postCount, 0);
      assert.equal(migrated.getStats().detailVisitCount, 0);
    } finally {
      migrated.close();
    }
  } finally {
    const resolvedDirectory = path.resolve(temporaryDirectory);
    assert.ok(resolvedDirectory.startsWith(path.resolve(os.tmpdir())));
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});

test("LocalDatabase marks active post-reading runs interrupted when reopened", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "reddit-flow-db-"));
  const databasePath = path.join(temporaryDirectory, "monitor.db");

  try {
    const first = new LocalDatabase(databasePath);
    const runId = first.createRun(
      { id: "profile-restart", seq: 8, name: "Restart profile" },
      options,
      "https://www.reddit.com/?feed=home",
      "2026-07-15T00:00:00.000Z",
    );
    first.close();

    const reopened = new LocalDatabase(databasePath);
    try {
      const run = reopened.getRun(runId);
      assert.equal(run.status, "interrupted");
      assert.equal(run.taskMode, "post");
      assert.equal(run.workflowMode, "feed_detail_readonly");
      assert.ok(run.stoppedAt);
      assert.equal(run.nextActionAt, null);
      assert.equal(run.events.length, 1);
      assert.equal(run.events[0].level, "warning");
      assert.equal(run.events[0].eventType, "lifecycle");
    } finally {
      reopened.close();
    }
  } finally {
    const resolvedDirectory = path.resolve(temporaryDirectory);
    assert.ok(resolvedDirectory.startsWith(path.resolve(os.tmpdir())));
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});
