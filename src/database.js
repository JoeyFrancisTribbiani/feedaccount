import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_OPTIONS } from "./config.js";

const ACTIVE_RUN_STATUSES = ["connecting", "scrolling", "waiting", "pausing", "paused", "stopping"];

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function booleanInt(value) {
  return value ? 1 : 0;
}

export class LocalDatabase {
  constructor(filename) {
    this.filename = filename;
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (filename !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.#markInterruptedRuns();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        name TEXT NOT NULL,
        status INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        pid INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_runs (
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
        task_mode TEXT NOT NULL DEFAULT 'post',
        workflow_mode TEXT NOT NULL DEFAULT 'feed_only',
        workflow_phase TEXT NOT NULL DEFAULT 'feed',
        detail_after_min_posts INTEGER NOT NULL DEFAULT 0,
        detail_after_max_posts INTEGER NOT NULL DEFAULT 0,
        detail_wait_min_sec INTEGER NOT NULL DEFAULT 0,
        detail_wait_max_sec INTEGER NOT NULL DEFAULT 0,
        comment_scroll_min INTEGER NOT NULL DEFAULT 0,
        comment_scroll_max INTEGER NOT NULL DEFAULT 0,
        return_wait_min_sec INTEGER NOT NULL DEFAULT 0,
        return_wait_max_sec INTEGER NOT NULL DEFAULT 0,
        post_count INTEGER NOT NULL DEFAULT 0,
        full_post_count INTEGER NOT NULL DEFAULT 0,
        current_post_json TEXT,
        current_post_complete INTEGER NOT NULL DEFAULT 1,
        feed_posts_since_detail INTEGER NOT NULL DEFAULT 0,
        feed_posts_target INTEGER NOT NULL DEFAULT 0,
        detail_visit_count INTEGER NOT NULL DEFAULT 0,
        comment_scroll_count INTEGER NOT NULL DEFAULT 0,
        comment_scroll_progress INTEGER NOT NULL DEFAULT 0,
        comment_scroll_target INTEGER NOT NULL DEFAULT 0,
        skipped_promoted_count INTEGER NOT NULL DEFAULT 0,
        detail_post_json TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        event_type TEXT NOT NULL DEFAULT 'activity',
        message TEXT NOT NULL,
        data_json TEXT,
        FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_profile ON task_runs(profile_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_run ON task_events(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_profile ON task_events(profile_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_level ON task_events(level, created_at DESC);

      CREATE TABLE IF NOT EXISTS tiktok_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL,
        status_text TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stopped_at TEXT,
        options_json TEXT NOT NULL DEFAULT '{}',
        video_count INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        current_video_json TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS tiktok_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        event_type TEXT NOT NULL DEFAULT 'activity',
        message TEXT NOT NULL,
        data_json TEXT,
        FOREIGN KEY (run_id) REFERENCES tiktok_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tiktok_runs_profile ON tiktok_runs(profile_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tiktok_runs_status ON tiktok_runs(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tiktok_events_run ON tiktok_events(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tiktok_events_profile ON tiktok_events(profile_id, created_at DESC);

      -- TikTok 账号与实例映射表
      CREATE TABLE IF NOT EXISTS tk_accounts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE,
        account_name TEXT,
        avatar_url TEXT,
        region TEXT DEFAULT 'US',
        status TEXT DEFAULT 'active',
        nurture_stage TEXT DEFAULT 'warmup_day1_3',
        health_score INTEGER DEFAULT 80,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 视频素材库表
      CREATE TABLE IF NOT EXISTS tk_video_materials (
        id TEXT PRIMARY KEY,
        category TEXT DEFAULT 'general',
        file_path TEXT NOT NULL,
        cover_path TEXT,
        title TEXT NOT NULL,
        hashtags_json TEXT DEFAULT '[]',
        privacy_level TEXT DEFAULT 'public',
        status TEXT DEFAULT 'ready',
        created_at TEXT NOT NULL
      );

      -- 视频发布任务表
      CREATE TABLE IF NOT EXISTS tk_publish_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        executed_at TEXT,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        published_video_id TEXT,
        published_video_url TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      -- 视频发布效果分析表
      CREATE TABLE IF NOT EXISTS tk_video_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publish_job_id TEXT NOT NULL,
        views_count INTEGER DEFAULT 0,
        likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        shares_count INTEGER DEFAULT 0,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tk_accounts_profile ON tk_accounts(profile_id);
      CREATE INDEX IF NOT EXISTS idx_tk_publish_jobs_status ON tk_publish_jobs(status, scheduled_at ASC);

      CREATE TABLE IF NOT EXISTS remix_creators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT,
        avatar TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remix_videos (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        duration REAL,
        thumbnail TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (creator_id) REFERENCES remix_creators(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS remix_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        mode TEXT NOT NULL,
        video_urls_json TEXT NOT NULL,
        source_videos_json TEXT,
        video_count INTEGER NOT NULL,
        ratio TEXT,
        output_url TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_remix_videos_creator ON remix_videos(creator_id);
      CREATE INDEX IF NOT EXISTS idx_remix_tasks_status ON remix_tasks(status);

      CREATE TABLE IF NOT EXISTS reddit_accounts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE,
        reddit_username TEXT,
        registered_at TEXT,
        nurture_started_at TEXT,
        nurture_stage TEXT DEFAULT 'week1',
        karma_total INTEGER DEFAULT 0,
        karma_post INTEGER DEFAULT 0,
        karma_comment INTEGER DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reddit_accounts_profile ON reddit_accounts(profile_id);

      CREATE TABLE IF NOT EXISTS chrome_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cdp_host TEXT NOT NULL DEFAULT 'localhost',
        cdp_port INTEGER NOT NULL DEFAULT 9222,
        ngrok_url TEXT,
        daemon_port INTEGER DEFAULT 9223,
        status TEXT DEFAULT 'stopped',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cdp_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        data_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cdp_logs_instance ON cdp_logs(instance_id, created_at DESC);
    `);

    this.#ensureColumn("task_runs", "task_mode", "TEXT NOT NULL DEFAULT 'pixel'");
    this.#ensureColumn("task_runs", "workflow_mode", "TEXT NOT NULL DEFAULT 'feed_only'");
    this.#ensureColumn("task_runs", "workflow_phase", "TEXT NOT NULL DEFAULT 'feed'");
    this.#ensureColumn("task_runs", "detail_after_min_posts", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "detail_after_max_posts", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "detail_wait_min_sec", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "detail_wait_max_sec", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "comment_scroll_min", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "comment_scroll_max", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "return_wait_min_sec", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "return_wait_max_sec", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "post_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "full_post_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "current_post_json", "TEXT");
    this.#ensureColumn("task_runs", "current_post_complete", "INTEGER NOT NULL DEFAULT 1");
    this.#ensureColumn("task_runs", "feed_posts_since_detail", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "feed_posts_target", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "detail_visit_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "comment_scroll_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "comment_scroll_progress", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "comment_scroll_target", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "skipped_promoted_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "detail_post_json", "TEXT");
    this.#ensureColumn("task_runs", "upvoted_post_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_runs", "upvoted_comment_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_runs", "auto_upvote_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "auto_comment_upvote_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "auto_comment_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("task_runs", "posted_comment_post_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_runs", "joined_subreddits_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_runs", "auto_join_count", "INTEGER NOT NULL DEFAULT 0");
    this.#ensureColumn("reddit_accounts", "enabled_actions_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("reddit_accounts", "action_configs_json", "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn("tiktok_runs", "search_keyword", "TEXT");
    this.#ensureColumn("remix_tasks", "downloaded", "INTEGER NOT NULL DEFAULT 0");
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  #markInterruptedRuns() {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, profile_id FROM task_runs WHERE status IN (${placeholders})`)
      .all(...ACTIVE_RUN_STATUSES);
    if (!rows.length) return;

    const timestamp = nowIso();
    const update = this.db.prepare(
      `UPDATE task_runs
       SET status = 'interrupted', status_text = '服务重启后中断', updated_at = ?, stopped_at = ?, next_action_at = NULL
       WHERE id = ?`,
    );
    const event = this.db.prepare(
      `INSERT INTO task_events (run_id, profile_id, created_at, level, event_type, message)
       VALUES (?, ?, ?, 'warning', 'lifecycle', '监控服务重启，原任务被标记为中断')`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        update.run(timestamp, timestamp, row.id);
        event.run(row.id, row.profile_id, timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProfiles(profiles) {
    const timestamp = nowIso();
    const statement = this.db.prepare(`
      INSERT INTO profiles (id, seq, name, status, running, pid, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        seq = excluded.seq,
        name = excluded.name,
        status = excluded.status,
        running = excluded.running,
        pid = excluded.pid,
        last_seen_at = excluded.last_seen_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const profile of profiles) {
        statement.run(
          profile.id,
          profile.seq,
          profile.name,
          profile.status,
          booleanInt(profile.running),
          profile.pid,
          timestamp,
          timestamp,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(profile, options, targetUrl, startedAt = nowIso()) {
    const result = this.db
      .prepare(`
        INSERT INTO task_runs (
          profile_id, profile_seq, profile_name, target_url, status, status_text,
          started_at, updated_at, wait_min_sec, wait_max_sec, scroll_min_px,
          scroll_max_px, max_scrolls, auto_stop_at_bottom, task_mode, workflow_mode,
          detail_after_min_posts, detail_after_max_posts, detail_wait_min_sec,
          detail_wait_max_sec, comment_scroll_min, comment_scroll_max,
          return_wait_min_sec, return_wait_max_sec, workflow_phase
        ) VALUES (
          ?, ?, ?, ?, 'connecting', '正在连接', ?, ?, ?, ?, 0, 0, ?, ?, 'post',
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connecting'
        )
      `)
      .run(
        profile.id,
        profile.seq,
        profile.name,
        targetUrl,
        startedAt,
        startedAt,
        options.waitMinSec ?? DEFAULT_OPTIONS.waitMinSec,
        options.waitMaxSec ?? DEFAULT_OPTIONS.waitMaxSec,
        options.maxPosts ?? DEFAULT_OPTIONS.maxPosts,
        booleanInt(options.autoStopAtBottom),
        options.detailLoopEnabled === false ? "feed_only" : "feed_detail_readonly",
        options.detailAfterMinPosts ?? DEFAULT_OPTIONS.detailAfterMinPosts,
        options.detailAfterMaxPosts ?? DEFAULT_OPTIONS.detailAfterMaxPosts,
        options.detailWaitMinSec ?? DEFAULT_OPTIONS.detailWaitMinSec,
        options.detailWaitMaxSec ?? DEFAULT_OPTIONS.detailWaitMaxSec,
        options.commentScrollMin ?? DEFAULT_OPTIONS.commentScrollMin,
        options.commentScrollMax ?? DEFAULT_OPTIONS.commentScrollMax,
        options.returnWaitMinSec ?? DEFAULT_OPTIONS.returnWaitMinSec,
        options.returnWaitMaxSec ?? DEFAULT_OPTIONS.returnWaitMaxSec,
      );
    return Number(result.lastInsertRowid);
  }

  updateRun(job) {
    if (!job.runId) return;
    this.db
      .prepare(`
        UPDATE task_runs SET
          status = ?, status_text = ?, updated_at = ?, stopped_at = ?, next_action_at = ?,
          scroll_count = ?, total_pixels = ?, last_scroll_pixels = ?, current_y = ?, max_y = ?,
          page_title = ?, page_url = ?, post_count = ?, full_post_count = ?,
          current_post_json = ?, current_post_complete = ?, workflow_phase = ?,
          feed_posts_since_detail = ?, feed_posts_target = ?, detail_visit_count = ?,
          comment_scroll_count = ?, comment_scroll_progress = ?, comment_scroll_target = ?,
          skipped_promoted_count = ?, detail_post_json = ?, error = ?,
          upvoted_post_ids_json = ?, upvoted_comment_ids_json = ?,
          auto_upvote_count = ?, auto_comment_upvote_count = ?,
          joined_subreddits_json = ?, auto_join_count = ?,
          auto_comment_count = ?, posted_comment_post_ids_json = ?
        WHERE id = ?
      `)
      .run(
        job.status,
        job.statusText,
        job.updatedAt,
        job.stoppedAt,
        job.nextActionAt,
        Number(job.scrollCount || 0),
        job.totalPixels,
        job.lastScrollPixels,
        job.currentY,
        job.maxY,
        job.pageTitle,
        job.pageUrl,
        job.postCount,
        job.fullPostCount,
        job.currentPost ? JSON.stringify(job.currentPost) : null,
        booleanInt(job.currentPostComplete !== false),
        job.workflowPhase || "feed",
        Number(job.feedPostsSinceDetail || 0),
        Number(job.feedPostsTarget || 0),
        Number(job.detailVisitCount || 0),
        Number(job.commentScrollCount || 0),
        Number(job.commentScrollProgress || 0),
        Number(job.commentScrollTarget || 0),
        Number(job.skippedPromotedCount || 0),
        job.currentDetailPost ? JSON.stringify(job.currentDetailPost) : null,
        job.error,
        JSON.stringify([...(job.upvotedPostIds || [])]),
        JSON.stringify([...(job.upvotedCommentIds || [])]),
        Number(job.autoUpvoteCount || 0),
        Number(job.autoCommentUpvoteCount || 0),
        JSON.stringify([...(job.joinedSubredditIds || [])]),
        Number(job.autoJoinCount || 0),
        Number(job.autoCommentCount || 0),
        JSON.stringify([...(job.postedCommentPostIds || [])]),
        job.runId,
      );
  }

  addEvent({ runId, profileId, message, level = "info", eventType = "activity", data = null }) {
    if (!runId) return null;
    const result = this.db
      .prepare(`
        INSERT INTO task_events (run_id, profile_id, created_at, level, event_type, message, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        profileId,
        nowIso(),
        level,
        eventType,
        message,
        data === null ? null : JSON.stringify(data),
      );
    return Number(result.lastInsertRowid);
  }

  saveOptions(options, profileId = null) {
    const key = profileId ? `task_options:${profileId}` : "task_options";
    const publicValue = {
      waitMinSec: options.waitMinSec,
      waitMaxSec: options.waitMaxSec,
      maxPosts: options.maxPosts,
      autoStopAtBottom: options.autoStopAtBottom,
      detailLoopEnabled:
        options.detailLoopEnabled === undefined
          ? DEFAULT_OPTIONS.detailLoopEnabled
          : Boolean(options.detailLoopEnabled),
      detailAfterMinPosts:
        options.detailAfterMinPosts ?? DEFAULT_OPTIONS.detailAfterMinPosts,
      detailAfterMaxPosts:
        options.detailAfterMaxPosts ?? DEFAULT_OPTIONS.detailAfterMaxPosts,
      detailWaitMinSec: options.detailWaitMinSec ?? DEFAULT_OPTIONS.detailWaitMinSec,
      detailWaitMaxSec: options.detailWaitMaxSec ?? DEFAULT_OPTIONS.detailWaitMaxSec,
      commentScrollMin: options.commentScrollMin ?? DEFAULT_OPTIONS.commentScrollMin,
      commentScrollMax: options.commentScrollMax ?? DEFAULT_OPTIONS.commentScrollMax,
      returnWaitMinSec: options.returnWaitMinSec ?? DEFAULT_OPTIONS.returnWaitMinSec,
      returnWaitMaxSec: options.returnWaitMaxSec ?? DEFAULT_OPTIONS.returnWaitMaxSec,
      autoUpvoteEnabled:
        options.autoUpvoteEnabled === undefined
          ? DEFAULT_OPTIONS.autoUpvoteEnabled
          : Boolean(options.autoUpvoteEnabled),
      autoUpvoteProbability:
        options.autoUpvoteProbability ?? DEFAULT_OPTIONS.autoUpvoteProbability,
      autoCommentUpvoteEnabled:
        options.autoCommentUpvoteEnabled === undefined
          ? DEFAULT_OPTIONS.autoCommentUpvoteEnabled
          : Boolean(options.autoCommentUpvoteEnabled),
      autoCommentUpvoteProbability:
        options.autoCommentUpvoteProbability ?? DEFAULT_OPTIONS.autoCommentUpvoteProbability,
      autoJoinEnabled:
        options.autoJoinEnabled === undefined
          ? DEFAULT_OPTIONS.autoJoinEnabled
          : Boolean(options.autoJoinEnabled),
      autoJoinIntervalMinSec:
        options.autoJoinIntervalMinSec ?? DEFAULT_OPTIONS.autoJoinIntervalMinSec,
      autoJoinIntervalMaxSec:
        options.autoJoinIntervalMaxSec ?? DEFAULT_OPTIONS.autoJoinIntervalMaxSec,
      autoJoinMaxPerRun:
        options.autoJoinMaxPerRun ?? DEFAULT_OPTIONS.autoJoinMaxPerRun,
      autoCommentEnabled:
        options.autoCommentEnabled === undefined
          ? DEFAULT_OPTIONS.autoCommentEnabled
          : Boolean(options.autoCommentEnabled),
      autoCommentProbability:
        options.autoCommentProbability ?? DEFAULT_OPTIONS.autoCommentProbability,
      autoCommentMinIntervalSec:
        options.autoCommentMinIntervalSec ?? DEFAULT_OPTIONS.autoCommentMinIntervalSec,
      autoCommentMaxIntervalSec:
        options.autoCommentMaxIntervalSec ?? DEFAULT_OPTIONS.autoCommentMaxIntervalSec,
      autoCommentMaxPerRun:
        options.autoCommentMaxPerRun ?? DEFAULT_OPTIONS.autoCommentMaxPerRun,
      autoCommentTexts: Array.isArray(options.autoCommentTexts) ? options.autoCommentTexts : [],
    };
    this.db
      .prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(publicValue), nowIso());
    return publicValue;
  }

  getSavedOptions(profileId = null) {
    const key = profileId ? `task_options:${profileId}` : "task_options";
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
    const options = parseJson(row?.value_json, null);
    if (!options) return null;    return {
      waitMinSec: options.waitMinSec ?? DEFAULT_OPTIONS.waitMinSec,
      waitMaxSec: options.waitMaxSec ?? DEFAULT_OPTIONS.waitMaxSec,
      maxPosts: options.maxPosts ?? options.maxScrolls ?? 0,
      autoStopAtBottom: Boolean(options.autoStopAtBottom),
      detailLoopEnabled:
        options.detailLoopEnabled === undefined
          ? DEFAULT_OPTIONS.detailLoopEnabled
          : Boolean(options.detailLoopEnabled),
      detailAfterMinPosts:
        options.detailAfterMinPosts ?? DEFAULT_OPTIONS.detailAfterMinPosts,
      detailAfterMaxPosts:
        options.detailAfterMaxPosts ?? DEFAULT_OPTIONS.detailAfterMaxPosts,
      detailWaitMinSec: options.detailWaitMinSec ?? DEFAULT_OPTIONS.detailWaitMinSec,
      detailWaitMaxSec: options.detailWaitMaxSec ?? DEFAULT_OPTIONS.detailWaitMaxSec,
      commentScrollMin: options.commentScrollMin ?? DEFAULT_OPTIONS.commentScrollMin,
      commentScrollMax: options.commentScrollMax ?? DEFAULT_OPTIONS.commentScrollMax,
      returnWaitMinSec: options.returnWaitMinSec ?? DEFAULT_OPTIONS.returnWaitMinSec,
      returnWaitMaxSec: options.returnWaitMaxSec ?? DEFAULT_OPTIONS.returnWaitMaxSec,
      autoUpvoteEnabled: Boolean(options.autoUpvoteEnabled ?? DEFAULT_OPTIONS.autoUpvoteEnabled),
      autoUpvoteProbability: options.autoUpvoteProbability ?? DEFAULT_OPTIONS.autoUpvoteProbability,
      autoCommentUpvoteEnabled: Boolean(
        options.autoCommentUpvoteEnabled ?? DEFAULT_OPTIONS.autoCommentUpvoteEnabled,
      ),
      autoCommentUpvoteProbability:
        options.autoCommentUpvoteProbability ?? DEFAULT_OPTIONS.autoCommentUpvoteProbability,
      autoJoinEnabled: Boolean(options.autoJoinEnabled ?? DEFAULT_OPTIONS.autoJoinEnabled),
      autoJoinIntervalMinSec:
        options.autoJoinIntervalMinSec ?? DEFAULT_OPTIONS.autoJoinIntervalMinSec,
      autoJoinIntervalMaxSec:
        options.autoJoinIntervalMaxSec ?? DEFAULT_OPTIONS.autoJoinIntervalMaxSec,
      autoJoinMaxPerRun:
        options.autoJoinMaxPerRun ?? DEFAULT_OPTIONS.autoJoinMaxPerRun,
      autoCommentEnabled: Boolean(options.autoCommentEnabled ?? DEFAULT_OPTIONS.autoCommentEnabled),
      autoCommentProbability:
        options.autoCommentProbability ?? DEFAULT_OPTIONS.autoCommentProbability,
      autoCommentMinIntervalSec:
        options.autoCommentMinIntervalSec ?? DEFAULT_OPTIONS.autoCommentMinIntervalSec,
      autoCommentMaxIntervalSec:
        options.autoCommentMaxIntervalSec ?? DEFAULT_OPTIONS.autoCommentMaxIntervalSec,
      autoCommentMaxPerRun:
        options.autoCommentMaxPerRun ?? DEFAULT_OPTIONS.autoCommentMaxPerRun,
      autoCommentTexts: Array.isArray(options.autoCommentTexts) ? options.autoCommentTexts : [],
    };
  }

  saveTiktokOptions(profileId, options) {
    const key = profileId ? `tiktok_options:${profileId}` : "tiktok_options";
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(options || {}), nowIso());
    return this.getTiktokOptions(profileId);
  }

  getTiktokOptions(profileId) {
    const key = profileId ? `tiktok_options:${profileId}` : "tiktok_options";
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
    return parseJson(row?.value_json, null);
  }

  getStats() {
    const runStats = this.db
      .prepare(`
        SELECT
          COUNT(*) AS run_count,
          COALESCE(SUM(scroll_count), 0) AS scroll_count,
          COALESCE(SUM(CASE WHEN task_mode = 'post' THEN post_count ELSE 0 END), 0) AS post_count,
          COALESCE(SUM(CASE WHEN task_mode = 'post' THEN full_post_count ELSE 0 END), 0) AS full_post_count,
          COALESCE(SUM(detail_visit_count), 0) AS detail_visit_count,
          COALESCE(SUM(comment_scroll_count), 0) AS comment_scroll_count,
          COALESCE(SUM(skipped_promoted_count), 0) AS skipped_promoted_count,
          COALESCE(SUM(auto_upvote_count), 0) AS auto_upvote_count,
          COALESCE(SUM(auto_comment_upvote_count), 0) AS auto_comment_upvote_count,
          COALESCE(SUM(auto_comment_count), 0) AS auto_comment_count,
          COALESCE(SUM(auto_join_count), 0) AS auto_join_count,
          COALESCE(SUM(total_pixels), 0) AS total_pixels,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
        FROM task_runs
      `)
      .get();
    const profileCount = this.db.prepare("SELECT COUNT(*) AS count FROM profiles").get().count;
    const eventCount = this.db.prepare("SELECT COUNT(*) AS count FROM task_events").get().count;
    return {
      profileCount: Number(profileCount),
      runCount: Number(runStats.run_count),
      scrollCount: Number(runStats.scroll_count),
      postCount: Number(runStats.post_count),
      fullPostCount: Number(runStats.full_post_count),
      detailVisitCount: Number(runStats.detail_visit_count),
      commentScrollCount: Number(runStats.comment_scroll_count),
      skippedPromotedCount: Number(runStats.skipped_promoted_count),
      autoUpvoteCount: Number(runStats.auto_upvote_count || 0),
      autoCommentUpvoteCount: Number(runStats.auto_comment_upvote_count || 0),
      autoCommentCount: Number(runStats.auto_comment_count || 0),
      autoJoinCount: Number(runStats.auto_join_count || 0),
      totalPixels: Number(runStats.total_pixels),
      completedCount: Number(runStats.completed_count || 0),
      errorCount: Number(runStats.error_count || 0),
      eventCount: Number(eventCount),
    };
  }

  listRuns({ limit = 100, offset = 0, profileId = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (profileId) {
      clauses.push("profile_id = ?");
      params.push(profileId);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    params.push(Math.max(Number(offset) || 0, 0));
    return this.db
      .prepare(`SELECT * FROM task_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params)
      .map((row) => this.#publicRun(row));
  }

  getRun(runId) {
    const row = this.db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
    if (!row) return null;
    return {
      ...this.#publicRun(row),
      events: this.listEvents({ runId, limit: 500 }),
    };
  }

  getUpvotedIdsForProfile(profileId, { limit = 50 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT upvoted_post_ids_json, upvoted_comment_ids_json
         FROM task_runs
         WHERE profile_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(profileId, Math.min(Math.max(Number(limit) || 50, 1), 500));
    const postIds = new Set();
    const commentIds = new Set();
    for (const row of rows) {
      const posts = parseJson(row.upvoted_post_ids_json, []);
      const comments = parseJson(row.upvoted_comment_ids_json, []);
      if (Array.isArray(posts)) for (const id of posts) postIds.add(String(id));
      if (Array.isArray(comments)) for (const id of comments) commentIds.add(String(id));
    }
    return { postIds, commentIds };
  }

  getJoinedSubredditsForProfile(profileId, { limit = 50 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT joined_subreddits_json
         FROM task_runs
         WHERE profile_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(profileId, Math.min(Math.max(Number(limit) || 50, 1), 500));
    const joined = new Set();
    for (const row of rows) {
      const items = parseJson(row.joined_subreddits_json, []);
      if (Array.isArray(items)) for (const id of items) joined.add(String(id).toLowerCase());
    }
    return joined;
  }

  getJoinTargets() {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = 'reddit_join_targets'").get();
    const items = parseJson(row?.value_json, []);
    return Array.isArray(items) ? items : [];
  }

  saveJoinTargets(targets) {
    const clean = (Array.isArray(targets) ? targets : [])
      .map((t) => {
        let name = typeof t === "string" ? t.trim() : (t && typeof t.name === "string" ? t.name.trim() : "");
        if (!name) return null;
        try {
          const url = new URL(name);
          const match = url.pathname.match(/^\/r\/([^/]+)/i);
          if (match) name = match[1];
        } catch {}
        name = name.replace(/^\/?r\//i, "").replace(/\/.*$/, "").trim();
        return name ? { name } : null;
      })
      .filter(Boolean);
    this.db
      .prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES ('reddit_join_targets', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(clean), nowIso());
    return clean;
  }

  listEvents({ limit = 200, offset = 0, runId = null, profileId = null, level = null } = {}) {
    const clauses = [];
    const params = [];
    if (runId) {
      clauses.push("e.run_id = ?");
      params.push(Number(runId));
    }
    if (profileId) {
      clauses.push("e.profile_id = ?");
      params.push(profileId);
    }
    if (level) {
      clauses.push("e.level = ?");
      params.push(level);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    params.push(Math.max(Number(offset) || 0, 0));
    return this.db
      .prepare(`
        SELECT e.*, r.profile_seq, r.profile_name, r.status AS run_status
        FROM task_events e
        JOIN task_runs r ON r.id = e.run_id
        ${where}
         ORDER BY e.created_at DESC, e.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params)
      .map((row) => ({
        id: Number(row.id),
        runId: Number(row.run_id),
        profileId: row.profile_id,
        profileSeq: row.profile_seq,
        profileName: row.profile_name,
        createdAt: row.created_at,
        level: row.level,
        eventType: row.event_type,
        message: row.message,
        data: parseJson(row.data_json, null),
        runStatus: row.run_status,
      }));
  }

  clearEvents({ profileId = null } = {}) {
    const result = profileId
      ? this.db.prepare("DELETE FROM task_events WHERE profile_id = ?").run(profileId)
      : this.db.prepare("DELETE FROM task_events").run();
    return Number(result.changes);
  }

  #publicRun(row) {
    return {
      id: Number(row.id),
      profileId: row.profile_id,
      profileSeq: row.profile_seq,
      profileName: row.profile_name,
      targetUrl: row.target_url,
      status: row.status,
      statusText: row.status_text,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      stoppedAt: row.stopped_at,
      nextActionAt: row.next_action_at,
      taskMode: row.task_mode || "pixel",
      workflowMode: row.workflow_mode || "feed_only",
      workflowPhase: row.workflow_phase || "feed",
      options:
        row.task_mode === "post"
          ? {
              waitMinSec: row.wait_min_sec,
              waitMaxSec: row.wait_max_sec,
              maxPosts: row.max_scrolls,
              autoStopAtBottom: Boolean(row.auto_stop_at_bottom),
              detailLoopEnabled: row.workflow_mode === "feed_detail_readonly",
              detailAfterMinPosts: row.detail_after_min_posts,
              detailAfterMaxPosts: row.detail_after_max_posts,
              detailWaitMinSec: row.detail_wait_min_sec,
              detailWaitMaxSec: row.detail_wait_max_sec,
              commentScrollMin: row.comment_scroll_min,
              commentScrollMax: row.comment_scroll_max,
              returnWaitMinSec: row.return_wait_min_sec,
              returnWaitMaxSec: row.return_wait_max_sec,
            }
          : {
              waitMinSec: row.wait_min_sec,
              waitMaxSec: row.wait_max_sec,
              scrollMinPx: row.scroll_min_px,
              scrollMaxPx: row.scroll_max_px,
              maxScrolls: row.max_scrolls,
              autoStopAtBottom: Boolean(row.auto_stop_at_bottom),
            },
      scrollCount: row.scroll_count,
      postCount: row.task_mode === "post" ? row.post_count : 0,
      fullPostCount: row.task_mode === "post" ? row.full_post_count : 0,
      totalPixels: row.total_pixels,
      lastScrollPixels: row.last_scroll_pixels,
      currentY: row.current_y,
      maxY: row.max_y,
      pageTitle: row.page_title,
      pageUrl: row.page_url,
      currentPost: parseJson(row.current_post_json, null),
      currentPostComplete: Boolean(row.current_post_complete),
      feedPostsSinceDetail: Number(row.feed_posts_since_detail || 0),
      feedPostsTarget: Number(row.feed_posts_target || 0),
      detailVisitCount: Number(row.detail_visit_count || 0),
      commentScrollCount: Number(row.comment_scroll_count || 0),
      commentScrollProgress: Number(row.comment_scroll_progress || 0),
      commentScrollTarget: Number(row.comment_scroll_target || 0),
      skippedPromotedCount: Number(row.skipped_promoted_count || 0),
      currentDetailPost: parseJson(row.detail_post_json, null),
      autoUpvoteCount: Number(row.auto_upvote_count || 0),
      autoCommentUpvoteCount: Number(row.auto_comment_upvote_count || 0),
      autoCommentCount: Number(row.auto_comment_count || 0),
      autoJoinCount: Number(row.auto_join_count || 0),
      error: row.error,
    };
  }

  createTiktokRun(profile, options, targetUrl, startedAt = nowIso()) {
    const result = this.db.prepare(
      `INSERT INTO tiktok_runs (profile_id, profile_name, target_url, status, status_text, started_at, updated_at, options_json)
       VALUES (?, ?, ?, 'connecting', '正在连接', ?, ?, ?)`,
    ).run(profile.id, profile.name, targetUrl, startedAt, startedAt, JSON.stringify(options || {}));
    return Number(result.lastInsertRowid);
  }

  updateTiktokRun(job) {
    if (!job.runId) return;
    this.db.prepare(
      `UPDATE tiktok_runs SET status=?, status_text=?, updated_at=?, video_count=?, like_count=?, comment_count=?, current_video_json=?, search_keyword=?, error=? WHERE id=?`,
    ).run(
      job.status, job.statusText || job.status, nowIso(),
      Number(job.videoCount || 0), Number(job.likeCount || 0), Number(job.commentCount || 0),
      job.currentVideo ? JSON.stringify(job.currentVideo) : null,
      job.searchKeyword || null, job.error || null, job.runId,
    );
  }

  finishTiktokRun(runId, status, statusText) {
    this.db.prepare(
      `UPDATE tiktok_runs SET status=?, status_text=?, updated_at=?, stopped_at=? WHERE id=?`,
    ).run(status, statusText, nowIso(), nowIso(), runId);
  }

  logTiktokEvent(runId, profileId, { at, level = "info", eventType = "activity", message, data = {} }) {
    this.db.prepare(
      `INSERT INTO tiktok_events (run_id, profile_id, created_at, level, event_type, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, profileId, at || nowIso(), level, eventType, message, JSON.stringify(data || {}));
  }

  listTiktokRuns({ limit = 100, offset = 0, profileId = null, status = null } = {}) {
    const where = [];
    const params = [];
    if (profileId) { where.push("profile_id = ?"); params.push(profileId); }
    if (status) { where.push("status = ?"); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM tiktok_runs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, Number(limit), Number(offset)).map((row) => ({
      id: row.id, profileId: row.profile_id, profileName: row.profile_name,
      status: row.status, statusText: row.status_text,
      startedAt: row.started_at, stoppedAt: row.stopped_at,
      options: parseJson(row.options_json, {}),
      videoCount: Number(row.video_count || 0), likeCount: Number(row.like_count || 0),
      commentCount: Number(row.comment_count || 0),
      currentVideo: parseJson(row.current_video_json, null), error: row.error,
    }));
  }

  listTiktokEvents({ limit = 200, offset = 0, runId = null, profileId = null, level = null } = {}) {
    const where = [];
    const params = [];
    if (runId) { where.push("run_id = ?"); params.push(runId); }
    if (profileId) { where.push("profile_id = ?"); params.push(profileId); }
    if (level) { where.push("level = ?"); params.push(level); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM tiktok_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, Number(limit), Number(offset)).map((row) => ({
      id: row.id, runId: row.run_id, profileId: row.profile_id,
      createdAt: row.created_at, level: row.level, eventType: row.event_type,
      message: row.message, data: parseJson(row.data_json, {}),
    }));
  }

  clearTiktokEvents({ profileId = null } = {}) {
    if (profileId) {
      return this.db.prepare("DELETE FROM tiktok_events WHERE profile_id = ?").run(profileId).changes;
    }
    return this.db.prepare("DELETE FROM tiktok_events").run().changes;
  }

  // --- TK 账号与实例映射管理 ---
  upsertTkAccount(accountData) {
    const timestamp = nowIso();
    const id = accountData.id || `tk_acc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO tk_accounts (id, profile_id, account_name, avatar_url, region, status, nurture_stage, health_score, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        account_name = excluded.account_name,
        avatar_url = excluded.avatar_url,
        region = excluded.region,
        status = excluded.status,
        nurture_stage = excluded.nurture_stage,
        health_score = excluded.health_score,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      id, accountData.profileId, accountData.accountName || "", accountData.avatarUrl || "",
      accountData.region || "US", accountData.status || "active", accountData.nurtureStage || "warmup_day1_3",
      Number(accountData.healthScore ?? 80), accountData.notes || "", timestamp, timestamp
    );
    return this.getTkAccountByProfileId(accountData.profileId);
  }

  listTkAccounts() {
    return this.db.prepare(`
      SELECT a.*, p.name AS profile_name, p.running AS profile_running
      FROM tk_accounts a
      LEFT JOIN profiles p ON a.profile_id = p.id
      ORDER BY a.updated_at DESC
    `).all().map(row => ({
      id: row.id,
      profileId: row.profile_id,
      profileName: row.profile_name || row.profile_id,
      profileRunning: Boolean(row.profile_running),
      accountName: row.account_name,
      avatarUrl: row.avatar_url,
      region: row.region,
      status: row.status,
      nurtureStage: row.nurture_stage,
      healthScore: Number(row.health_score),
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  getTkAccountByProfileId(profileId) {
    const row = this.db.prepare(`SELECT * FROM tk_accounts WHERE profile_id = ?`).get(profileId);
    if (!row) return null;
    return {
      id: row.id,
      profileId: row.profile_id,
      accountName: row.account_name,
      avatarUrl: row.avatar_url,
      region: row.region,
      status: row.status,
      nurtureStage: row.nurture_stage,
      healthScore: Number(row.health_score),
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  deleteTkAccount(id) {
    return this.db.prepare(`DELETE FROM tk_accounts WHERE id = ? OR profile_id = ?`).run(id, id).changes;
  }

  // --- Reddit 账号管理 ---
  upsertRedditAccount(accountData) {
    const timestamp = nowIso();
    const id = accountData.id || `rdt_acc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const enabledActions = Array.isArray(accountData.enabledActions)
      ? accountData.enabledActions.filter((a) => typeof a === "string" && a.trim())
      : [];
    const actionConfigs = accountData.actionConfigs && typeof accountData.actionConfigs === "object"
      ? accountData.actionConfigs
      : {};
    this.db.prepare(`
      INSERT INTO reddit_accounts (id, profile_id, reddit_username, registered_at, nurture_started_at, nurture_stage, karma_total, karma_post, karma_comment, notes, enabled_actions_json, action_configs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        reddit_username = excluded.reddit_username,
        registered_at = excluded.registered_at,
        nurture_started_at = excluded.nurture_started_at,
        nurture_stage = excluded.nurture_stage,
        karma_total = excluded.karma_total,
        karma_post = excluded.karma_post,
        karma_comment = excluded.karma_comment,
        notes = excluded.notes,
        enabled_actions_json = excluded.enabled_actions_json,
        action_configs_json = excluded.action_configs_json,
        updated_at = excluded.updated_at
    `).run(
      id, accountData.profileId, accountData.redditUsername || "",
      accountData.registeredAt || null, accountData.nurtureStartedAt || null,
      accountData.nurtureStage || "week1",
      Number(accountData.karmaTotal ?? 0), Number(accountData.karmaPost ?? 0), Number(accountData.karmaComment ?? 0),
      accountData.notes || "", JSON.stringify(enabledActions), JSON.stringify(actionConfigs), timestamp, timestamp
    );
    return this.getRedditAccountByProfileId(accountData.profileId);
  }

  deleteProfileOptions(profileId) {
    return this.db.prepare("DELETE FROM app_settings WHERE key = ?").run(`task_options:${profileId}`).changes;
  }

  getAiCommentConfig() {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = 'ai_comment_config'").get();
    return parseJson(row?.value_json, null);
  }

  saveAiCommentConfig(config) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES ('ai_comment_config', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(config || {}), nowIso());
    return config;
  }

  listRedditAccounts() {
    return this.db.prepare(`
      SELECT a.*, p.name AS profile_name, p.seq AS profile_seq, p.running AS profile_running
      FROM reddit_accounts a
      LEFT JOIN profiles p ON a.profile_id = p.id
      ORDER BY p.seq ASC NULLS LAST, a.updated_at DESC
    `).all().map(row => ({
      id: row.id,
      profileId: row.profile_id,
      profileSeq: row.profile_seq,
      profileName: row.profile_name || row.profile_id,
      profileRunning: Boolean(row.profile_running),
      redditUsername: row.reddit_username,
      registeredAt: row.registered_at,
      nurtureStartedAt: row.nurture_started_at,
      nurtureStage: row.nurture_stage,
      karmaTotal: Number(row.karma_total),
      karmaPost: Number(row.karma_post),
      karmaComment: Number(row.karma_comment),
      notes: row.notes,
      enabledActions: parseJson(row.enabled_actions_json, []),
      actionConfigs: parseJson(row.action_configs_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getRedditAccountByProfileId(profileId) {
    const row = this.db.prepare(`SELECT * FROM reddit_accounts WHERE profile_id = ?`).get(profileId);
    if (!row) return null;
    return {
      id: row.id,
      profileId: row.profile_id,
      redditUsername: row.reddit_username,
      registeredAt: row.registered_at,
      nurtureStartedAt: row.nurture_started_at,
      nurtureStage: row.nurture_stage,
      karmaTotal: Number(row.karma_total),
      karmaPost: Number(row.karma_post),
      karmaComment: Number(row.karma_comment),
      notes: row.notes,
      enabledActions: parseJson(row.enabled_actions_json, []),
      actionConfigs: parseJson(row.action_configs_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteRedditAccount(id) {
    return this.db.prepare(`DELETE FROM reddit_accounts WHERE id = ? OR profile_id = ?`).run(id, id).changes;
  }

  // --- Chrome CDP 实例管理 ---
  upsertChromeInstance(data) {
    const ts = nowIso();
    const id = data.id || `chrome_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO chrome_instances (id, name, cdp_host, cdp_port, ngrok_url, daemon_port, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, cdp_host = excluded.cdp_host, cdp_port = excluded.cdp_port,
        ngrok_url = excluded.ngrok_url, daemon_port = excluded.daemon_port,
        status = excluded.status, notes = excluded.notes, updated_at = excluded.updated_at
    `).run(id, data.name || "", data.cdpHost || "localhost", Number(data.cdpPort || 9222),
      data.ngrokUrl || null, Number(data.daemonPort || 9223), data.status || "stopped",
      data.notes || "", ts, ts);
    return this.getChromeInstance(id);
  }

  listChromeInstances() {
    return this.db.prepare(`SELECT * FROM chrome_instances ORDER BY created_at DESC`).all().map(r => ({
      id: r.id, name: r.name, cdpHost: r.cdp_host, cdpPort: r.cdp_port,
      ngrokUrl: r.ngrok_url, daemonPort: r.daemon_port, status: r.status,
      notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  getChromeInstance(id) {
    const r = this.db.prepare(`SELECT * FROM chrome_instances WHERE id = ?`).get(id);
    if (!r) return null;
    return {
      id: r.id, name: r.name, cdpHost: r.cdp_host, cdpPort: r.cdp_port,
      ngrokUrl: r.ngrok_url, daemonPort: r.daemon_port, status: r.status,
      notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  deleteChromeInstance(id) {
    this.db.prepare(`DELETE FROM cdp_logs WHERE instance_id = ?`).run(id);
    return this.db.prepare(`DELETE FROM chrome_instances WHERE id = ?`).run(id).changes;
  }

  updateChromeInstanceStatus(id, status) {
    this.db.prepare(`UPDATE chrome_instances SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
  }

  logCdpEvent(instanceId, level, message, data = null) {
    this.db.prepare(`INSERT INTO cdp_logs (instance_id, created_at, level, message, data_json) VALUES (?, ?, ?, ?, ?)`)
      .run(instanceId, nowIso(), level, message, data ? JSON.stringify(data) : null);
  }

  listCdpLogs({ instanceId = null, limit = 100, level = null } = {}) {
    const clauses = [];
    const params = [];
    if (instanceId) { clauses.push("instance_id = ?"); params.push(instanceId); }
    if (level) { clauses.push("level = ?"); params.push(level); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Number(limit) || 100, 500));
    return this.db.prepare(`SELECT * FROM cdp_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params).map(r => ({
      id: r.id, instanceId: r.instance_id, createdAt: r.created_at,
      level: r.level, message: r.message, data: parseJson(r.data_json, null),
    }));
  }

  clearCdpLogs(instanceId = null) {
    if (instanceId) return this.db.prepare(`DELETE FROM cdp_logs WHERE instance_id = ?`).run(instanceId).changes;
    return this.db.prepare(`DELETE FROM cdp_logs`).run().changes;
  }

  // --- TK 视频素材库管理 ---
  createTkMaterial(data) {
    const timestamp = nowIso();
    const id = `mat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO tk_video_materials (id, category, file_path, cover_path, title, hashtags_json, privacy_level, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.category || 'general', data.filePath, data.coverPath || '',
      data.title, JSON.stringify(data.hashtags || []), data.privacyLevel || 'public',
      data.status || 'ready', timestamp
    );
    return this.getTkMaterial(id);
  }

  listTkMaterials({ category = null, status = null } = {}) {
    const where = [];
    const params = [];
    if (category) { where.push("category = ?"); params.push(category); }
    if (status) { where.push("status = ?"); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM tk_video_materials ${clause} ORDER BY created_at DESC`).all(...params).map(row => ({
      id: row.id,
      category: row.category,
      filePath: row.file_path,
      coverPath: row.cover_path,
      title: row.title,
      hashtags: parseJson(row.hashtags_json, []),
      privacyLevel: row.privacy_level,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  getTkMaterial(id) {
    const row = this.db.prepare(`SELECT * FROM tk_video_materials WHERE id = ?`).get(id);
    if (!row) return null;
    return {
      id: row.id,
      category: row.category,
      filePath: row.file_path,
      coverPath: row.cover_path,
      title: row.title,
      hashtags: parseJson(row.hashtags_json, []),
      privacyLevel: row.privacy_level,
      status: row.status,
      createdAt: row.created_at
    };
  }

  deleteTkMaterial(id) {
    return this.db.prepare(`DELETE FROM tk_video_materials WHERE id = ?`).run(id).changes;
  }

  // --- TK 视频自动发布任务队列管理 ---
  createTkPublishJob(data) {
    const timestamp = nowIso();
    const id = `pub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO tk_publish_jobs (id, account_id, profile_id, material_id, scheduled_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.accountId || data.profileId, data.profileId, data.materialId,
      data.scheduledAt || timestamp, data.status || 'pending', timestamp
    );
    return this.getTkPublishJob(id);
  }

  listTkPublishJobs({ status = null, profileId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push("j.status = ?"); params.push(status); }
    if (profileId) { where.push("j.profile_id = ?"); params.push(profileId); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT j.*, m.title AS material_title, m.file_path AS material_file_path, m.hashtags_json AS material_hashtags,
             a.account_name, p.name AS profile_name
      FROM tk_publish_jobs j
      LEFT JOIN tk_video_materials m ON j.material_id = m.id
      LEFT JOIN tk_accounts a ON j.account_id = a.id OR j.profile_id = a.profile_id
      LEFT JOIN profiles p ON j.profile_id = p.id
      ${clause}
      ORDER BY j.scheduled_at ASC
      LIMIT ?
    `).all(...params, Math.min(Number(limit) || 100, 500)).map(row => ({
      id: row.id,
      accountId: row.account_id,
      profileId: row.profile_id,
      profileName: row.profile_name || row.profile_id,
      accountName: row.account_name || '未命名账号',
      materialId: row.material_id,
      materialTitle: row.material_title,
      materialFilePath: row.material_file_path,
      materialHashtags: parseJson(row.material_hashtags, []),
      scheduledAt: row.scheduled_at,
      executedAt: row.executed_at,
      status: row.status,
      retryCount: Number(row.retry_count || 0),
      publishedVideoId: row.published_video_id,
      publishedVideoUrl: row.published_video_url,
      errorMessage: row.error_message,
      createdAt: row.created_at
    }));
  }

  getTkPublishJob(id) {
    const row = this.db.prepare(`
      SELECT j.*, m.title AS material_title, m.file_path AS material_file_path, m.hashtags_json AS material_hashtags,
             m.privacy_level AS material_privacy
      FROM tk_publish_jobs j
      LEFT JOIN tk_video_materials m ON j.material_id = m.id
      WHERE j.id = ?
    `).get(id);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      profileId: row.profile_id,
      materialId: row.material_id,
      materialTitle: row.material_title,
      materialFilePath: row.material_file_path,
      materialHashtags: parseJson(row.material_hashtags, []),
      materialPrivacy: row.material_privacy || 'public',
      scheduledAt: row.scheduled_at,
      executedAt: row.executed_at,
      status: row.status,
      retryCount: Number(row.retry_count || 0),
      publishedVideoId: row.published_video_id,
      publishedVideoUrl: row.published_video_url,
      errorMessage: row.error_message,
      createdAt: row.created_at
    };
  }

  updateTkPublishJobStatus(id, { status, executedAt = null, publishedVideoId = null, publishedVideoUrl = null, errorMessage = null }) {
    this.db.prepare(`
      UPDATE tk_publish_jobs
      SET status = ?,
          executed_at = COALESCE(?, executed_at),
          published_video_id = COALESCE(?, published_video_id),
          published_video_url = COALESCE(?, published_video_url),
          error_message = ?,
          retry_count = CASE WHEN ? = 'failed' THEN retry_count + 1 ELSE retry_count END
      WHERE id = ?
    `).run(status, executedAt, publishedVideoId, publishedVideoUrl, errorMessage, status, id);
    return this.getTkPublishJob(id);
  }

  deleteTkPublishJob(id) {
    return this.db.prepare(`DELETE FROM tk_publish_jobs WHERE id = ?`).run(id).changes;
  }

  // --- Remix 达人管理 ---
  createRemixCreator({ name, platform = null }) {
    const id = `rc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const ts = nowIso();
    this.db.prepare(`INSERT INTO remix_creators (id, name, platform, created_at) VALUES (?, ?, ?, ?)`).run(id, name, platform, ts);
    return this.getRemixCreator(id);
  }

  listRemixCreators() {
    const rows = this.db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM remix_videos v WHERE v.creator_id = c.id) AS video_count
      FROM remix_creators c ORDER BY c.created_at DESC
    `).all();
    return rows.map((r) => ({
      id: r.id, name: r.name, platform: r.platform, avatar: r.avatar,
      createdAt: r.created_at, _count: { videos: Number(r.video_count || 0) },
    }));
  }

  getRemixCreator(id) {
    const row = this.db.prepare(`SELECT * FROM remix_creators WHERE id = ?`).get(id);
    return row ? { id: row.id, name: row.name, platform: row.platform, avatar: row.avatar, createdAt: row.created_at } : null;
  }

  deleteRemixCreator(id) {
    this.db.prepare(`DELETE FROM remix_videos WHERE creator_id = ?`).run(id);
    return this.db.prepare(`DELETE FROM remix_creators WHERE id = ?`).run(id).changes;
  }

  // --- Remix 视频管理 ---
  createRemixVideo({ creatorId, url, title = null }) {
    const id = `rv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const ts = nowIso();
    this.db.prepare(`INSERT INTO remix_videos (id, creator_id, url, title, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, creatorId, url, title, ts);
    return this.getRemixVideo(id);
  }

  listRemixVideos(creatorId) {
    const rows = this.db.prepare(`SELECT * FROM remix_videos WHERE creator_id = ? ORDER BY created_at DESC`).all(creatorId);
    return rows.map((r) => ({
      id: r.id, creatorId: r.creator_id, url: r.url, title: r.title,
      duration: r.duration, thumbnail: r.thumbnail, createdAt: r.created_at,
    }));
  }

  getRemixVideo(id) {
    const row = this.db.prepare(`SELECT * FROM remix_videos WHERE id = ?`).get(id);
    return row ? {
      id: row.id, creatorId: row.creator_id, url: row.url, title: row.title,
      duration: row.duration, thumbnail: row.thumbnail, createdAt: row.created_at,
    } : null;
  }

  deleteRemixVideo(id) {
    return this.db.prepare(`DELETE FROM remix_videos WHERE id = ?`).run(id).changes;
  }

  updateRemixVideoDuration(id, duration) {
    this.db.prepare("UPDATE remix_videos SET duration = ? WHERE id = ?").run(duration, id);
  }

  // --- Remix 任务管理 ---
  createRemixTask({ title, mode, videoUrls, sourceVideos = null, ratio = "9:16" }) {
    const id = `rt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO remix_tasks (id, title, status, mode, video_urls_json, source_videos_json, video_count, ratio, created_at)
      VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    `).run(id, title, mode, JSON.stringify(videoUrls), sourceVideos ? JSON.stringify(sourceVideos) : null, videoUrls.length, ratio, ts);
    return this.getRemixTask(id);
  }

  listRemixTasks() {
    const rows = this.db.prepare(`SELECT * FROM remix_tasks ORDER BY created_at DESC`).all();
    return rows.map((r) => ({
      id: r.id, title: r.title, status: r.status, mode: r.mode,
      videoUrls: parseJson(r.video_urls_json, []),
      sourceVideos: parseJson(r.source_videos_json, null),
      videoCount: Number(r.video_count), ratio: r.ratio,
      outputUrl: r.output_url, errorMessage: r.error_message,
      downloaded: Boolean(r.downloaded),
      createdAt: r.created_at, completedAt: r.completed_at,
    }));
  }

  getRemixTask(id) {
    const row = this.db.prepare(`SELECT * FROM remix_tasks WHERE id = ?`).get(id);
    return row ? {
      id: row.id, title: row.title, status: row.status, mode: row.mode,
      videoUrls: parseJson(row.video_urls_json, []),
      sourceVideos: parseJson(row.source_videos_json, null),
      videoCount: Number(row.video_count), ratio: row.ratio,
      outputUrl: row.output_url, errorMessage: row.error_message,
      downloaded: Boolean(row.downloaded),
      createdAt: row.created_at, completedAt: row.completed_at,
    } : null;
  }

  markRemixTaskDownloaded(id) {
    this.db.prepare(`UPDATE remix_tasks SET downloaded = 1 WHERE id = ?`).run(id);
    return this.getRemixTask(id);
  }

  updateRemixTask(id, { status = null, outputUrl = null, errorMessage = null, completedAt = null }) {
    this.db.prepare(`
      UPDATE remix_tasks
      SET status = COALESCE(?, status),
          output_url = COALESCE(?, output_url),
          error_message = COALESCE(?, error_message),
          completed_at = COALESCE(?, completed_at)
      WHERE id = ?
    `).run(status, outputUrl, errorMessage, completedAt, id);
    return this.getRemixTask(id);
  }

  deleteRemixTask(id) {
    return this.db.prepare(`DELETE FROM remix_tasks WHERE id = ?`).run(id).changes;
  }

  close() {
    this.db.close();
  }
}
