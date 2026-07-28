import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPTIONS,
  normalizeOptions,
  publicOptions,
  randomInteger,
} from "../src/config.js";

test("normalizeOptions applies post-reading defaults and internal millisecond values", () => {
  const options = normalizeOptions();
  assert.equal(options.waitMinSec, DEFAULT_OPTIONS.waitMinSec);
  assert.equal(options.waitMaxSec, DEFAULT_OPTIONS.waitMaxSec);
  assert.equal(options.waitMinMs, DEFAULT_OPTIONS.waitMinSec * 1000);
  assert.equal(options.waitMaxMs, DEFAULT_OPTIONS.waitMaxSec * 1000);
  assert.equal(options.maxPosts, DEFAULT_OPTIONS.maxPosts);
  assert.equal(options.autoStopAtBottom, false);
  assert.equal(options.detailLoopEnabled, true);
  assert.equal(options.detailAfterMinPosts, 3);
  assert.equal(options.detailAfterMaxPosts, 8);
  assert.equal(options.detailWaitMinMs, 2_000);
  assert.equal(options.detailWaitMaxMs, 15_000);
  assert.equal(options.commentScrollMin, 2);
  assert.equal(options.commentScrollMax, 7);
  assert.equal(options.returnWaitMinMs, 2_000);
  assert.equal(options.returnWaitMaxMs, 4_000);
});

test("normalizeOptions rejects a reversed per-post reading wait range", () => {
  assert.throws(() => normalizeOptions({ waitMinSec: 20, waitMaxSec: 5 }));
});

test("normalizeOptions accepts maxPosts and maps legacy maxScrolls", () => {
  assert.equal(normalizeOptions({ maxPosts: 12 }).maxPosts, 12);
  assert.equal(normalizeOptions({ maxScrolls: 9 }).maxPosts, 9);
  assert.equal(normalizeOptions({ maxPosts: 4, maxScrolls: 99 }).maxPosts, 4);
  assert.throws(() => normalizeOptions({ maxPosts: -1 }));
});

test("normalizeOptions validates every read-only detail-loop range", () => {
  assert.throws(() => normalizeOptions({ detailAfterMinPosts: 9, detailAfterMaxPosts: 8 }));
  assert.throws(() => normalizeOptions({ detailWaitMinSec: 16, detailWaitMaxSec: 15 }));
  assert.throws(() => normalizeOptions({ commentScrollMin: 8, commentScrollMax: 7 }));
  assert.throws(() => normalizeOptions({ returnWaitMinSec: 5, returnWaitMaxSec: 4 }));
  assert.throws(() => normalizeOptions({ commentScrollMin: 0 }));
});

test("publicOptions exposes configuration without internal millisecond fields", () => {
  const options = publicOptions(normalizeOptions({ detailLoopEnabled: false }));
  assert.deepEqual(options, {
    waitMinSec: 5,
    waitMaxSec: 15,
    maxPosts: 0,
    autoStopAtBottom: false,
    detailLoopEnabled: false,
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
  assert.equal("detailWaitMinMs" in options, false);
  assert.equal("returnWaitMaxMs" in options, false);
});

test("randomInteger stays inside an inclusive range", () => {
  for (let index = 0; index < 100; index += 1) {
    const value = randomInteger(20, 25);
    assert.ok(value >= 20 && value <= 25);
  }
});
