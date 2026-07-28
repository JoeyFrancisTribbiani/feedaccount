import test from "node:test";
import assert from "node:assert/strict";

import {
  alignPost,
  planNextPost,
  postViewportState,
  readingGeometry,
} from "../src/post-planner.js";

function post(postId, absoluteTop, height) {
  return { postId, absoluteTop, height, title: postId };
}

function feed(overrides = {}) {
  return {
    scrollY: 0,
    maxY: 5_000,
    viewportHeight: 825,
    headerBottom: 57,
    posts: [],
    ...overrides,
  };
}

test("reading geometry keeps posts below a fixed Reddit header", () => {
  const geometry = readingGeometry(feed());
  assert.deepEqual(geometry, { safeTop: 65, safeBottom: 813, availableHeight: 748 });

  const target = post("p1", 700, 600);
  const alignment = alignPost(target, feed());
  assert.equal(alignment.desiredTop, 139);
  assert.equal(alignment.distance, 561);

  const positioned = postViewportState(target, feed({ scrollY: alignment.distance }));
  assert.equal(positioned.top, 139);
  assert.equal(positioned.bottom, 739);
  assert.equal(positioned.fullyVisible, true);
  assert.equal(positioned.fitPossible, true);
});

test("planNextPost aligns exactly one normal post fully inside the viewport", () => {
  const current = post("p1", 65, 600);
  const next = post("p2", 700, 600);
  const layout = feed({ posts: [current, next] });
  const plan = planNextPost(layout, "p1");

  assert.equal(plan.kind, "next-post");
  assert.equal(plan.post.postId, "p2");
  assert.equal(plan.newPost, true);
  assert.equal(plan.distance, 561);
  assert.equal(plan.postComplete, true);

  const positioned = postViewportState(next, {
    ...layout,
    scrollY: layout.scrollY + plan.distance,
  });
  assert.equal(positioned.fullyVisible, true);
});

test("an oversized post is read in viewport-sized segments with overlap", () => {
  const tall = post("tall", 65, 1_800);
  const first = planNextPost(feed({ posts: [tall] }), "tall");
  assert.equal(first.kind, "continue-post");
  assert.equal(first.newPost, false);
  assert.equal(first.distance, 668);
  assert.equal(first.postComplete, false);

  const second = planNextPost(feed({ posts: [tall], scrollY: 668 }), "tall");
  assert.equal(second.kind, "continue-post");
  assert.equal(second.distance, 384);
  assert.equal(second.postComplete, true);
});

test("missing next post is retryable while the feed can still load", () => {
  const onlyPost = post("p1", 165, 600);
  const plan = planNextPost(feed({ posts: [onlyPost], scrollY: 100, maxY: 2_000 }), "p1");

  assert.equal(plan.kind, "loading");
  assert.equal(plan.atBottom, false);
  assert.equal(plan.retryable, true);
  assert.equal(plan.distance, 0);
});

test("missing next post reports end only at the document bottom", () => {
  const onlyPost = post("p1", 2_063, 600);
  const plan = planNextPost(feed({ posts: [onlyPost], scrollY: 1_998, maxY: 2_000 }), "p1");

  assert.equal(plan.kind, "end");
  assert.equal(plan.atBottom, true);
  assert.equal(plan.retryable, false);
  assert.equal(plan.distance, 0);
});

test("reading geometry excludes a measured fixed bottom obstruction", () => {
  const geometry = readingGeometry(
    feed({ bottomPadding: 160, safeBottom: 665 }),
  );
  assert.deepEqual(geometry, { safeTop: 65, safeBottom: 665, availableHeight: 600 });

  const target = post("p-safe", 700, 500);
  const alignment = alignPost(target, feed({ bottomPadding: 160, safeBottom: 665 }));
  assert.equal(alignment.desiredTop, 115);
  assert.equal(alignment.distance, 585);
});

test("a tiny remainder of the previous post does not make the planner scroll backward", () => {
  const previous = post("previous", 100, 670);
  const next = post("next", 900, 1_800);
  const layout = feed({ scrollY: 700, posts: [previous, next] });

  const plan = planNextPost(layout);

  assert.equal(plan.kind, "current-post");
  assert.equal(plan.post.postId, "next");
  assert.ok(plan.distance > 0);
  assert.equal(plan.distance, 135);
});

test("a promoted Feed unit remains a normal alignment target for safe skip decisions", () => {
  const promoted = {
    ...post("ad-1", 700, 600),
    isPromoted: true,
    clickEligible: false,
  };
  const layout = feed({ posts: [post("p1", 65, 600), promoted] });

  const plan = planNextPost(layout, "p1");

  assert.equal(plan.kind, "next-post");
  assert.equal(plan.post.postId, "ad-1");
  assert.equal(plan.post.isPromoted, true);
  assert.ok(plan.distance > 0);
});
