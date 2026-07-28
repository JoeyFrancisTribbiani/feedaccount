import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("monitor page exposes every configurable read-only detail-loop range", () => {
  for (const id of [
    "detail-loop-enabled",
    "detail-after-min-posts",
    "detail-after-max-posts",
    "detail-wait-min",
    "detail-wait-max",
    "comment-scroll-min",
    "comment-scroll-max",
    "return-wait-min",
    "return-wait-max",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /默认只读浏览/);
  assert.match(app, /feed_detail_readonly/);
  assert.match(app, /commentScrollProgress/);
});

test("monitor page exposes auto-upvote configuration but no downvote or auto-submit controls", () => {
  assert.match(html, /id=["']auto-upvote-enabled["']/);
  assert.match(html, /id=["']auto-upvote-probability["']/);
  assert.match(html, /id=["']auto-comment-upvote-enabled["']/);
  assert.match(html, /id=["']auto-comment-upvote-probability["']/);
  assert.doesNotMatch(html, /id=["'][^"']*(?:downvote|autoLike|autoSubmit)[^"']*["']/i);
  assert.doesNotMatch(app, /(?:downvoteCount|autoVoteEnabled|autoSubmit)/);
});

test("monitor page offers a guarded one-post manual upvote beside the feed continue control", () => {
  const triggerIndex = app.indexOf('class="trigger-job"');
  const manualUpvoteIndex = app.indexOf('class="manual-upvote-job');
  assert.ok(triggerIndex >= 0);
  assert.ok(manualUpvoteIndex > triggerIndex);

  assert.match(app, /job\?\.status === "waiting"/);
  assert.match(app, /job\.workflowPhase === "feed_wait"/);
  assert.match(app, /isOrdinaryCurrentPost\(job\.currentPost\)/);
  assert.match(app, /job\.manualUpvoteAvailable !== false/);
  assert.match(app, /job\.manualActionPending !== true/);
  assert.match(app, /const upvoteLabel = manualUpvotePending/);
  assert.match(app, /\? "已点赞"/);
  assert.match(styles, /\.manual-upvote-job/);
});

test("manual upvote requires confirmation, sends the expected post id, and reports outcomes", () => {
  const handlerIndex = app.indexOf("async function manuallyUpvoteCurrentPost");
  const confirmIndex = app.indexOf("window.confirm", handlerIndex);
  const requestIndex = app.indexOf("/manual-upvote", handlerIndex);
  assert.ok(handlerIndex >= 0);
  assert.ok(confirmIndex > handlerIndex);
  assert.ok(requestIndex > confirmIndex);

  assert.match(app, /JSON\.stringify\(\{ expectedPostId \}\)/);
  assert.match(app, /pendingManualUpvotes\.has\(profileId\)/);
  assert.match(app, /pendingManualUpvotes\.add\(profileId\)/);
  assert.match(app, /正在确认当前帖的点赞状态…/);
  assert.match(app, /showToast\("已点赞"\)/);
  assert.match(app, /该帖已是点赞状态，未重复点击/);
  assert.match(app, /点赞失败：\$\{error\.message\}/);
});

test("monitor page offers one guarded manual comment upvote beside the continue control", () => {
  const triggerIndex = app.indexOf('class="trigger-job"');
  const commentUpvoteIndex = app.indexOf(
    "manualCommentUpvoteControlHtml(",
    triggerIndex,
  );
  assert.ok(triggerIndex >= 0);
  assert.ok(commentUpvoteIndex > triggerIndex);

  assert.match(app, /class="manual-comment-upvote-job/);
  assert.match(app, /\["waiting", "paused"\]\.includes\(job\?\.status\)/);
  assert.match(app, /\["comment_scrolling", "return_wait"\]\.includes\(job\.workflowPhase\)/);
  assert.match(app, /Boolean\(job\.currentComment\?\.commentId\)/);
  assert.match(app, /job\.manualCommentUpvoteAvailable === true/);
  assert.match(app, /job\.manualCommentActionPending !== true/);
  assert.match(app, /data-comment-id=/);
  assert.match(app, /\? "点赞中…"/);
  assert.match(app, /\? "已点赞"/);
  assert.match(app, /: "确认赞评论"/);
  assert.match(styles, /\.manual-comment-upvote-job/);
});

test("paused comment reading places the same guarded upvote beside resume", () => {
  const pausedBlockIndex = app.indexOf('if (job.status === "paused")');
  const resumeIndex = app.indexOf('class="resume-job"', pausedBlockIndex);
  const commentControlIndex = app.indexOf(
    "manualCommentUpvoteControlHtml(",
    resumeIndex,
  );
  const stopIndex = app.indexOf('class="stop-job"', resumeIndex);
  assert.ok(pausedBlockIndex >= 0);
  assert.ok(resumeIndex > pausedBlockIndex);
  assert.ok(commentControlIndex > resumeIndex);
  assert.ok(stopIndex > commentControlIndex);
  assert.match(app, /canManuallyUpvoteCurrentComment\(job\) && !actionPending/);
});

test("manual comment upvote requires confirmation and sends only the expected comment id", () => {
  const handlerIndex = app.indexOf("async function manuallyUpvoteCurrentComment");
  const confirmIndex = app.indexOf("window.confirm", handlerIndex);
  const requestIndex = app.indexOf("/manual-comment-upvote", handlerIndex);
  assert.ok(handlerIndex >= 0);
  assert.ok(confirmIndex > handlerIndex);
  assert.ok(requestIndex > confirmIndex);

  assert.match(app, /确定点赞当前显示的这条评论吗？/);
  assert.doesNotMatch(
    app.slice(confirmIndex, requestIndex),
    /currentComment\.(?:body|text|content)/,
  );
  assert.match(app, /JSON\.stringify\(\{ expectedCommentId \}\)/);
  assert.match(app, /pendingManualCommentUpvotes\.has\(profileId\)/);
  assert.match(app, /pendingManualCommentUpvotes\.add\(profileId\)/);
  assert.match(app, /正在确认当前评论的点赞状态…/);
  assert.match(app, /showToast\("已点赞当前评论"\)/);
  assert.match(app, /该评论已是点赞状态，未重复点击/);
  assert.match(app, /评论点赞失败：\$\{error\.message\}/);
});

test("manual voting keeps stop available while preventing duplicate actions", () => {
  assert.match(
    app,
    /const stopDisabled = state\.pendingJobActions\.has\(job\.profileId\)/,
  );
  assert.match(
    app,
    /manualUpvotePending \|\|\s*manualCommentUpvotePending/,
  );
  assert.doesNotMatch(
    app,
    /const stopDisabled = .*manualCommentUpvotePending/,
  );
});
