import test from "node:test";
import assert from "node:assert/strict";

import { BrowserSession } from "../src/browser-session.js";
import { NATURAL_INPUT_BOUNDS } from "../src/natural-input.js";

function post(postId, absoluteTop, height, feedIndex = 1) {
  return {
    postId,
    title: `Post ${postId}`,
    postType: "text",
    feedIndex,
    permalink: `https://www.reddit.com/r/test/comments/${postId}/post/`,
    textLength: 100,
    absoluteTop,
    height,
  };
}

function standardPosts() {
  return [post("p1", 65, 600, 1), post("p2", 700, 600, 2)];
}

function assertNaturalSingleClick(eventTypes) {
  const pressed = eventTypes
    .map((type, index) => ({ type, index }))
    .filter((event) => event.type === "mousePressed");
  const released = eventTypes
    .map((type, index) => ({ type, index }))
    .filter((event) => event.type === "mouseReleased");
  assert.ok(eventTypes.filter((type) => type === "mouseMoved").length >= 2);
  assert.equal(pressed.length, 1);
  assert.equal(released.length, 1);
  assert.ok(pressed[0].index < released[0].index);
  assert.equal(eventTypes.at(-1), "mouseReleased");
}

class FeedCdpClient {
  constructor({
    posts = standardPosts(),
    scrollY = 0,
    maxY = 8_000,
    viewportHeight = 825,
    headerBottom = 57,
    bottomPadding = 12,
    rejectGesture = false,
    gestureMovement = (distance) => distance,
    wheelMovement = (distance) => distance,
    feedState = null,
  } = {}) {
    this.posts = posts;
    this.y = scrollY;
    this.maxY = maxY;
    this.viewportHeight = viewportHeight;
    this.headerBottom = headerBottom;
    this.bottomPadding = bottomPadding;
    this.rejectGesture = rejectGesture;
    this.gestureMovement = gestureMovement;
    this.wheelMovement = wheelMovement;
    this.feedState = feedState;
    this.calls = [];
    this.closed = false;
    this.feedReads = 0;
    this.inputCount = 0;
    this.gestureCount = 0;
    this.wheelCount = 0;
  }

  async connect(wsUrl) {
    this.wsUrl = wsUrl;
  }

  #move(distance) {
    if (!Number.isFinite(distance)) return;
    this.y = Math.max(0, Math.min(this.maxY, Math.round(this.y + distance)));
  }

  #feed() {
    this.feedReads += 1;
    const dynamic = this.feedState?.(this) || {};
    const viewportHeight = dynamic.viewportHeight ?? this.viewportHeight;
    const headerBottom = dynamic.headerBottom ?? this.headerBottom;
    const bottomPadding = dynamic.bottomPadding ?? this.bottomPadding;
    const safeBottom = dynamic.safeBottom ?? viewportHeight - bottomPadding;
    const posts = (dynamic.posts ?? this.posts).map((item) => ({ ...item }));
    const inputX = dynamic.inputX ?? 600;
    const inputY = dynamic.inputY ?? Math.round((headerBottom + 8 + safeBottom) / 2);
    return {
      title: "Reddit",
      url: "https://www.reddit.com/?feed=home",
      ready: "complete",
      visibilityState: "visible",
      hasFocus: true,
      scrollY: this.y,
      maxY: dynamic.maxY ?? this.maxY,
      documentHeight: (dynamic.maxY ?? this.maxY) + viewportHeight,
      viewportHeight,
      headerBottom,
      bottomPadding,
      safeBottom,
      inputX,
      inputY,
      inputPoints: dynamic.inputPoints ?? [{ x: inputX, y: inputY }],
      inputPointVerified: dynamic.inputPointVerified ?? true,
      feedBottom: posts.length
        ? Math.max(...posts.map((item) => item.absoluteTop + item.height))
        : 0,
      posts,
    };
  }

  async call(method, params = {}, sessionId = null) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          {
            type: "page",
            targetId: "reddit-target",
            url: "https://www.reddit.com/?feed=home",
          },
        ],
      };
    }
    if (method === "Target.attachToTarget") return { sessionId: "reddit-session" };
    if (method === "Page.getLayoutMetrics") {
      return {
        cssVisualViewport: { clientWidth: 1_200, clientHeight: this.viewportHeight },
      };
    }
    if (method === "Input.synthesizeScrollGesture") {
      this.gestureCount += 1;
      if (this.rejectGesture) throw new Error("method unavailable");
      this.inputCount += 1;
      const requestedDistance = -params.yDistance;
      this.#move(this.gestureMovement(requestedDistance, this));
      return {};
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
      this.wheelCount += 1;
      this.inputCount += 1;
      this.#move(this.wheelMovement(params.deltaY, this));
      return {};
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:feed-dom")) {
      assert.doesNotThrow(
        () => new Function(params.expression),
        "the actual Feed DOM expression sent to Chromium must be valid JavaScript",
      );
      return { result: { value: this.#feed() } };
    }
    if (method === "Runtime.evaluate" && params.expression.startsWith("({ title:")) {
      return {
        result: {
          value: {
            title: "Reddit",
            url: "https://www.reddit.com/?feed=home",
            y: this.y,
            max: this.maxY,
            ready: "complete",
          },
        },
      };
    }
    return {};
  }

  close() {
    this.closed = true;
  }
}

async function connectedSession(client, overrides = {}) {
  const session = new BrowserSession({
    client,
    settleMs: 0,
    inputRandomIntegerFn: (_min, max) => max,
    inputDelayFn: async () => {},
    ...overrides,
  });
  await session.connect("ws://127.0.0.1/devtools/browser/test");
  return session;
}

class ManualUpvoteCdpClient extends FeedCdpClient {
  constructor({
    posts = standardPosts(),
    voteState = "neutral",
    ownerId = "t3_p1",
    ownerCanonicalId = "p1",
    occluded = false,
    disabled = false,
    visible = true,
    inViewport = true,
    blockedReason = null,
    confidence = "high",
    changesOnRelease = true,
    failOnPress = false,
    moveOnProbe = null,
  } = {}) {
    super({ posts });
    this.voteState = voteState;
    this.ownerId = ownerId;
    this.ownerCanonicalId = ownerCanonicalId;
    this.occluded = occluded;
    this.disabled = disabled;
    this.visible = visible;
    this.inViewport = inViewport;
    this.blockedReason = blockedReason;
    this.confidence = confidence;
    this.changesOnRelease = changesOnRelease;
    this.failOnPress = failOnPress;
    this.moveOnProbe = moveOnProbe;
    this.manualMouseEvents = [];
    this.voteProbeCount = 0;
  }

  #target() {
    const shifted = Number.isInteger(this.moveOnProbe) && this.voteProbeCount >= this.moveOnProbe;
    const centerX = shifted ? 470 : 420;
    return {
      kind: "post_upvote",
      context: "post",
      ownerId: this.ownerId,
      ownerCanonicalId: this.ownerCanonicalId,
      ownerIdAliases: [this.ownerId, "post-shell-p1"],
      confidence: this.confidence,
      blockedReason: this.blockedReason,
      disabled: this.disabled,
      visible: this.visible,
      inViewport: this.inViewport,
      occluded: this.occluded,
      ariaPressed: this.voteState === "upvoted",
      selected: null,
      voteState: this.voteState,
      voteStateConflict: false,
      center: { x: centerX, y: 360 },
      rect: { x: centerX - 20, y: 340, width: 40, height: 40 },
    };
  }

  async call(method, params = {}, sessionId = null) {
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("reddit-flow:readonly-interaction-locator")
    ) {
      this.calls.push({ method, params, sessionId });
      this.voteProbeCount += 1;
      return {
        result: {
          value: {
            readonly: true,
            highlighted: false,
            url: "https://www.reddit.com/?feed=home",
            pageKind: "feed",
            targets: [this.#target()],
          },
        },
      };
    }
    if (method === "Input.dispatchMouseEvent" && params.type !== "mouseWheel") {
      this.calls.push({ method, params, sessionId });
      this.manualMouseEvents.push(params.type);
      if (params.type === "mousePressed" && this.failOnPress) {
        throw new Error("press response lost");
      }
      if (params.type === "mouseReleased" && this.changesOnRelease) {
        this.voteState = "upvoted";
      }
      return {};
    }
    return super.call(method, params, sessionId);
  }
}

async function readyManualUpvoteSession(client) {
  const session = await connectedSession(client);
  const current = await session.scroll();
  assert.equal(current.currentPost?.postId, client.posts[0].postId);
  return session;
}

test("manual upvote rejects a promoted current post without probing or clicking", async () => {
  const promoted = {
    ...post("p1", 65, 600, 1),
    isPromoted: true,
    promotionSignals: ["attribute"],
  };
  const client = new ManualUpvoteCdpClient({ posts: [promoted] });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "promoted");
  assert.equal(client.voteProbeCount, 0);
  assert.deepEqual(client.manualMouseEvents, []);
});

test("manual upvote rejects an expected id that is not both current and last", async () => {
  const client = new ManualUpvoteCdpClient();
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p2" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "current-post-mismatch");
  assert.deepEqual(client.manualMouseEvents, []);
});

test("manual upvote rejects an occluded control without dispatching input", async () => {
  const client = new ManualUpvoteCdpClient({ occluded: true });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "upvote-occluded");
  assert.deepEqual(client.manualMouseEvents, []);
});

test("manual upvote rejects an upvote owned by a different post", async () => {
  const client = new ManualUpvoteCdpClient({
    ownerId: "t3_other",
    ownerCanonicalId: "other",
  });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "upvote-not-found");
  assert.deepEqual(client.manualMouseEvents, []);
});

test("manual upvote treats an already selected control as success without clicking", async () => {
  const client = new ManualUpvoteCdpClient({ voteState: "upvoted" });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.deepEqual(
    {
      ok: result.ok,
      changed: result.changed,
      alreadyUpvoted: result.alreadyUpvoted,
      beforeState: result.beforeState,
      afterState: result.afterState,
    },
    {
      ok: true,
      changed: false,
      alreadyUpvoted: true,
      beforeState: "upvoted",
      afterState: "upvoted",
    },
  );
  assert.deepEqual(client.manualMouseEvents, []);
});

test("manual upvote resolves Feed aliases and dispatches exactly one verified click", async () => {
  const aliasedPost = {
    ...post("post-shell-p1", 65, 600, 1),
    canonicalPostId: "p1",
    postIdAliases: ["t3_p1", "p1", "post-shell-p1"],
    permalink: "https://www.reddit.com/r/test/comments/p1/post/",
  };
  const client = new ManualUpvoteCdpClient({ posts: [aliasedPost] });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({
    expectedPostId: "post-shell-p1",
  });

  assert.deepEqual(
    {
      ok: result.ok,
      changed: result.changed,
      alreadyUpvoted: result.alreadyUpvoted,
      postId: result.postId,
      beforeState: result.beforeState,
      afterState: result.afterState,
      uncertain: result.uncertain,
    },
    {
      ok: true,
      changed: true,
      alreadyUpvoted: false,
      postId: "post-shell-p1",
      beforeState: "neutral",
      afterState: "upvoted",
      uncertain: false,
    },
  );
  assertNaturalSingleClick(client.manualMouseEvents);
  assert.equal(client.voteProbeCount, 4);
});

test("an unconfirmed manual upvote is uncertain and cannot be clicked twice in one session", async () => {
  const client = new ManualUpvoteCdpClient({ changesOnRelease: false });
  const session = await readyManualUpvoteSession(client);

  const first = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });
  const second = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(first.ok, false);
  assert.equal(first.uncertain, true);
  assert.equal(first.reason, "upvote-not-confirmed");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "upvote-already-attempted");
  assertNaturalSingleClick(client.manualMouseEvents);
});

test("manual upvote revalidates the exact target after its natural hover", async () => {
  const client = new ManualUpvoteCdpClient({ moveOnProbe: 3 });
  const session = await readyManualUpvoteSession(client);

  const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(result.reason, "upvote-target-changed-before-click");
  assert.equal(client.manualMouseEvents.filter((type) => type === "mousePressed").length, 0);
  assert.equal(client.manualMouseEvents.filter((type) => type === "mouseReleased").length, 0);
});

test("an ambiguous press failure releases the pointer, clears focus, and locks the vote", async () => {
  const client = new ManualUpvoteCdpClient({
    failOnPress: true,
    changesOnRelease: false,
  });
  const session = await readyManualUpvoteSession(client);

  const first = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });
  const eventCountAfterFirst = client.manualMouseEvents.length;
  const second = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });

  assert.equal(first.ok, false);
  assert.equal(first.uncertain, true);
  assert.equal(first.reason, "upvote-input-failed");
  assert.equal(client.manualMouseEvents.filter((type) => type === "mousePressed").length, 1);
  assert.equal(client.manualMouseEvents.filter((type) => type === "mouseReleased").length, 1);
  const focusCalls = client.calls.filter(
    (call) => call.method === "Emulation.setFocusEmulationEnabled",
  );
  assert.equal(focusCalls.at(-1)?.params?.enabled, false);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "upvote-already-attempted");
  assert.equal(client.manualMouseEvents.length, eventCountAfterFirst);
});

test("manual upvote never clicks an unknown, downvoted, or conflicting state", async (t) => {
  for (const voteState of ["unknown", "downvoted", "conflict"]) {
    await t.test(voteState, async () => {
      const client = new ManualUpvoteCdpClient({ voteState });
      const session = await readyManualUpvoteSession(client);
      const result = await session.manualUpvoteCurrentPost({ expectedPostId: "p1" });
      assert.equal(result.ok, false);
      assert.deepEqual(client.manualMouseEvents, []);
    });
  }
});

test("BrowserSession scrolls a background page with a focused mouse gesture", async () => {
  const client = new FeedCdpClient();
  const session = await connectedSession(client);

  const first = await session.scroll();
  assert.equal(first.newPost, true);
  assert.equal(first.currentPost.postId, "p1");
  assert.equal(first.alignmentVerified, true);

  const result = await session.scroll();
  assert.equal(result.actualDistance, 561);
  assert.equal(result.inputMethod, "mouse-gesture");
  assert.equal(result.newPost, true);
  assert.equal(result.currentPost.postId, "p2");
  assert.equal(result.currentPost.fullyVisible, true);
  assert.equal(result.alignmentVerified, true);
  const gestures = client.calls.filter((call) => call.method === "Input.synthesizeScrollGesture");
  assert.ok(gestures.length >= 2, "a long move approaches before its measured correction");
  assert.equal(gestures.reduce((sum, call) => sum - call.params.yDistance, 0), 561);
  assert.ok(gestures.every((call) => call.params.gestureSourceType === "mouse"));
  assert.ok(gestures.every((call) => call.params.speed >= 360 && call.params.speed <= 900));
});

test("BrowserSession falls back to a mouse wheel command when gestures are unavailable", async () => {
  const client = new FeedCdpClient({ rejectGesture: true });
  const session = await connectedSession(client);

  await session.scroll();
  const result = await session.scroll();

  assert.equal(result.actualDistance, 561);
  assert.equal(result.inputMethod, "mouse-wheel");
  const wheels = client.calls.filter(
    (call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseWheel",
  );
  assert.ok(wheels.length >= 2);
  assert.equal(wheels.reduce((sum, call) => sum + call.params.deltaY, 0), 561);
  assert.ok(wheels.every((call) => call.params.deltaY > 0));
  assert.equal(result.currentPost.postId, "p2");
  assert.equal(result.alignmentVerified, true);
});

test("BrowserSession awaits natural delays before dispatching scroll input", async () => {
  const client = new FeedCdpClient({ rejectGesture: true });
  const delays = [];
  let releaseFirstPause;
  const firstPause = new Promise((resolve) => {
    releaseFirstPause = resolve;
  });
  let pauseBlocked = false;
  const session = await connectedSession(client, {
    inputDelayFn: (delayMs, purpose) => {
      delays.push({ delayMs, purpose });
      if (purpose === "scroll-pause" && !pauseBlocked) {
        pauseBlocked = true;
        return firstPause;
      }
      return Promise.resolve();
    },
  });

  await session.scroll();
  const pending = session.scroll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pauseBlocked, true);
  assert.equal(client.gestureCount, 0);
  assert.equal(client.wheelCount, 0);

  releaseFirstPause();
  const result = await pending;
  assert.equal(result.alignmentVerified, true);
  const scrollPauses = delays.filter((item) => item.purpose === "scroll-pause");
  const wheelGaps = delays.filter((item) => item.purpose === "wheel-pulse-gap");
  assert.ok(scrollPauses.length >= 1);
  assert.ok(wheelGaps.length >= 1);
  assert.ok(scrollPauses.every(
    ({ delayMs }) =>
      delayMs >= NATURAL_INPUT_BOUNDS.scrollPauseMinMs &&
      delayMs <= NATURAL_INPUT_BOUNDS.scrollPauseMaxMs,
  ));
  assert.ok(wheelGaps.every(
    ({ delayMs }) =>
      delayMs >= NATURAL_INPUT_BOUNDS.wheelGapMinMs &&
      delayMs <= NATURAL_INPUT_BOUNDS.wheelGapMaxMs,
  ));
});

test("BrowserSession refuses an unverified scroll point", async () => {
  const client = new FeedCdpClient({
    feedState: () => ({ inputPoints: [], inputPointVerified: false }),
  });
  const session = await connectedSession(client);
  await session.scroll();

  await assert.rejects(() => session.scroll(), /可验证的主滚动输入点/);
  assert.equal(client.gestureCount, 0);
  assert.equal(client.wheelCount, 0);
});

test("20 percent under-scroll stays pending until the normal post is fully visible", async () => {
  const client = new FeedCdpClient({
    gestureMovement: (distance) =>
      Math.sign(distance) * Math.max(1, Math.round(Math.abs(distance) * 0.2)),
  });
  const session = await connectedSession(client);
  await session.scroll();

  const attempts = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const result = await session.scroll();
    attempts.push(result);
    if (result.alignmentVerified) break;
  }

  assert.ok(attempts.length >= 2, "five corrections cannot hide a persistent 80% under-scroll");
  for (const pending of attempts.slice(0, -1)) {
    assert.equal(pending.scrollKind, "alignment-pending");
    assert.equal(pending.alignmentPending, true);
    assert.equal(pending.newPost, false);
    assert.equal(pending.postComplete, false);
    assert.ok(Math.abs(pending.alignmentResidualPx) > 8);
  }
  const aligned = attempts.at(-1);
  assert.equal(aligned.alignmentVerified, true);
  assert.equal(aligned.alignmentPending, false);
  assert.equal(aligned.newPost, true);
  assert.equal(aligned.currentPost.postId, "p2");
  assert.equal(aligned.currentPost.fullyVisible, true);
  assert.ok(client.gestureCount > 5);
});

test("an accepted gesture with no movement switches to the CDP wheel fallback", async () => {
  const client = new FeedCdpClient({ gestureMovement: () => 0 });
  const session = await connectedSession(client);
  await session.scroll();

  const result = await session.scroll();

  assert.equal(result.alignmentVerified, true);
  assert.equal(result.currentPost.fullyVisible, true);
  assert.equal(result.inputMethod, "mouse-wheel");
  assert.equal(result.alignmentAttempts, 2);
  assert.equal(client.gestureCount, 1);
  assert.ok(client.wheelCount >= 2);
});

test("media growth from 600 to 1000px is remeasured as a tall post", async () => {
  const initialPosts = standardPosts();
  const client = new FeedCdpClient({
    posts: initialPosts,
    feedState: (state) => ({
      posts: state.inputCount > 0
        ? [initialPosts[0], { ...initialPosts[1], height: 1_000 }]
        : initialPosts,
    }),
  });
  const session = await connectedSession(client);
  await session.scroll();

  const firstSegment = await session.scroll();
  assert.equal(firstSegment.alignmentVerified, true);
  assert.equal(firstSegment.currentPost.height, 1_000);
  assert.equal(firstSegment.currentPost.oversized, true);
  assert.equal(firstSegment.currentPost.fullyVisible, false);
  assert.equal(firstSegment.segmentReady, true);
  assert.equal(firstSegment.postComplete, false);
  assert.equal(firstSegment.currentPost.viewportTop, 65);

  const finalSegment = await session.scroll();
  assert.equal(finalSegment.scrollKind, "continue-post");
  assert.equal(finalSegment.alignmentVerified, true);
  assert.equal(finalSegment.newPost, false);
  assert.equal(finalSegment.postComplete, true);
  assert.equal(finalSegment.actualDistance, 252);
});

test("a header that grows during scrolling is remeasured before alignment completes", async () => {
  const client = new FeedCdpClient({
    feedState: (state) => ({ headerBottom: state.inputCount > 0 ? 180 : 57 }),
  });
  const session = await connectedSession(client);
  await session.scroll();

  const result = await session.scroll();

  assert.equal(result.alignmentVerified, true);
  assert.equal(result.currentPost.fullyVisible, true);
  assert.ok(result.currentPost.viewportTop >= 188);
});

test("a fixed bottom obstruction reduces the safe viewport used for alignment", async () => {
  const posts = [post("p1", 65, 500, 1), post("p2", 650, 500, 2)];
  const client = new FeedCdpClient({ posts, bottomPadding: 160 });
  const session = await connectedSession(client);
  await session.scroll();

  const result = await session.scroll();

  assert.equal(result.alignmentVerified, true);
  assert.equal(result.currentPost.fullyVisible, true);
  assert.ok(result.currentPost.viewportBottom <= 665);
  const gesture = client.calls.find((call) => call.method === "Input.synthesizeScrollGesture");
  assert.ok(gesture.params.y >= 65 && gesture.params.y < 665);
});

test("overshoot is corrected upward instead of accepting a clipped normal post", async () => {
  const client = new FeedCdpClient({
    gestureMovement: (distance, state) =>
      state.gestureCount === 1 && distance > 0 ? distance + 160 : distance,
  });
  const session = await connectedSession(client);
  await session.scroll();

  const result = await session.scroll();

  assert.equal(result.alignmentVerified, true);
  assert.equal(result.currentPost.fullyVisible, true);
  assert.equal(result.currentY, 561);
  const gestures = client.calls.filter((call) => call.method === "Input.synthesizeScrollGesture");
  assert.equal(gestures.length, 2);
  assert.ok(gestures[1].params.yDistance > 0, "the second gesture must move upward");
});

test("771px and 1800px posts complete as verified, non-duplicated segments", async () => {
  const posts = [post("p771", 65, 771, 1), post("p1800", 871, 1_800, 2)];
  const client = new FeedCdpClient({ posts });
  const session = await connectedSession(client);

  const results = [];
  for (let index = 0; index < 5; index += 1) results.push(await session.scroll());

  assert.deepEqual(
    results.map((result) => [
      result.currentPost.postId,
      result.scrollKind,
      result.newPost,
      result.postComplete,
      result.alignmentVerified,
    ]),
    [
      ["p771", "current-post", true, false, true],
      ["p771", "continue-post", false, true, true],
      ["p1800", "next-post", true, false, true],
      ["p1800", "continue-post", false, false, true],
      ["p1800", "continue-post", false, true, true],
    ],
  );
  assert.deepEqual(results.map((result) => result.currentY), [0, 23, 806, 1_474, 1_858]);
  assert.ok(results.every((result) => result.segmentReady));
});

class DetailFlowCdpClient {
  constructor({
    promoted = false,
    unsafeTitle = false,
    newTarget = false,
    moveTitleBeforePress = false,
  } = {}) {
    this.promoted = promoted;
    this.unsafeTitle = unsafeTitle;
    this.newTarget = newTarget;
    this.moveTitleBeforePress = moveTitleBeforePress;
    this.mode = "feed";
    this.feedY = 0;
    this.detailY = 0;
    this.detailTargetOpen = false;
    this.detailTargetClosed = false;
    this.calls = [];
    this.clickEvents = [];
    this.titleProbeCount = 0;
    this.closed = false;
    this.detailUrl = "https://www.reddit.com/r/test/comments/p1/post/";
    this.feedPost = {
      ...post("p1", 65, 600, 1),
      isPromoted: promoted,
      promotionSignals: promoted ? ["attribute"] : [],
      clickEligible: !promoted,
      ineligibleReason: promoted ? "promoted" : null,
    };
  }

  async connect(wsUrl) {
    this.wsUrl = wsUrl;
  }

  #feed() {
    return {
      title: "Reddit Feed",
      url: "https://www.reddit.com/?feed=home",
      ready: "complete",
      visibilityState: "visible",
      hasFocus: true,
      scrollY: this.feedY,
      maxY: 5_000,
      documentHeight: 5_825,
      viewportHeight: 825,
      headerBottom: 57,
      bottomPadding: 12,
      safeBottom: 813,
      inputX: 600,
      inputY: 439,
      feedBottom: 665,
      posts: [{ ...this.feedPost }],
    };
  }

  #detail() {
    const comments = [
      { commentId: "t1_c1", absoluteTop: 900, height: 220 },
      { commentId: "t1_c2", absoluteTop: 1_350, height: 240 },
      { commentId: "t1_c3", absoluteTop: 1_850, height: 260 },
    ];
    return {
      title: "Post p1",
      url: this.detailUrl,
      ready: "complete",
      scrollY: this.detailY,
      maxY: 2_400,
      viewportHeight: 825,
      headerBottom: 57,
      safeTop: 65,
      safeBottom: 813,
      inputX: 600,
      inputY: 439,
      mainPostPresent: true,
      commentRoot: { absoluteTop: 880, height: 2_200 },
      comments,
      explicitEmpty: false,
      blocked: false,
    };
  }

  async call(method, params = {}, sessionId = null) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") {
      const feedUrl = !this.newTarget && this.mode === "detail"
        ? this.detailUrl
        : "https://www.reddit.com/?feed=home";
      const targetInfos = [
        { type: "page", targetId: "feed-target", url: feedUrl },
      ];
      if (this.detailTargetOpen && !this.detailTargetClosed) {
        targetInfos.push({
          type: "page",
          targetId: "detail-target",
          openerId: "feed-target",
          url: this.detailUrl,
        });
      }
      return { targetInfos };
    }
    if (method === "Target.attachToTarget") {
      return {
        sessionId: params.targetId === "detail-target" ? "detail-session" : "feed-session",
      };
    }
    if (method === "Target.closeTarget") {
      this.detailTargetClosed = true;
      return { success: true };
    }
    if (method === "Target.detachFromTarget" || method === "Page.enable") return {};
    if (method === "Page.getNavigationHistory") {
      return {
        currentIndex: 0,
        entries: [{ id: 7, url: "https://www.reddit.com/?feed=home" }],
      };
    }
    if (method === "Page.navigateToHistoryEntry") {
      this.mode = "feed";
      return {};
    }
    if (method === "Emulation.setFocusEmulationEnabled") return {};
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 1_200, clientHeight: 825 } };
    }
    if (method === "Input.synthesizeScrollGesture") {
      const distance = -params.yDistance;
      const detailSession = sessionId === "detail-session" || (!this.newTarget && this.mode === "detail");
      if (detailSession) {
        this.detailY = Math.max(0, Math.min(2_400, Math.round(this.detailY + distance)));
      } else {
        this.feedY = Math.max(0, Math.min(5_000, Math.round(this.feedY + distance)));
      }
      return {};
    }
    if (method === "Input.dispatchMouseEvent") {
      if (params.type === "mouseWheel") {
        const detailSession = sessionId === "detail-session" || (!this.newTarget && this.mode === "detail");
        if (detailSession) {
          this.detailY = Math.max(0, Math.min(2_400, Math.round(this.detailY + params.deltaY)));
        } else {
          this.feedY = Math.max(0, Math.min(5_000, Math.round(this.feedY + params.deltaY)));
        }
      } else {
        this.clickEvents.push(params.type);
        if (params.type === "mouseReleased" && !this.promoted && !this.unsafeTitle) {
          if (this.newTarget) this.detailTargetOpen = true;
          else this.mode = "detail";
        }
      }
      return {};
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:feed-dom")) {
      return { result: { value: this.#feed() } };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:feed-open-target")) {
      this.titleProbeCount += 1;
      if (this.promoted) {
        return { result: { value: { ok: false, reason: "promoted", postId: "p1" } } };
      }
      if (this.unsafeTitle) {
        return { result: { value: { ok: false, reason: "unsafe-title-link", postId: "p1" } } };
      }
      return {
        result: {
          value: {
            ok: true,
            reason: null,
            postId: "p1",
            href: this.detailUrl,
            x: this.moveTitleBeforePress && this.titleProbeCount >= 2 ? 650 : 600,
            y: 100,
            rect: { x: 500, y: 80, width: 200, height: 40 },
          },
        },
      };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:page-identity")) {
      const detailSession = sessionId === "detail-session" || (!this.newTarget && this.mode === "detail");
      return {
        result: {
          value: {
            title: detailSession ? "Post p1" : "Reddit Feed",
            url: detailSession ? this.detailUrl : "https://www.reddit.com/?feed=home",
            ready: "complete",
          },
        },
      };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:detail-dom")) {
      assert.doesNotThrow(
        () => new Function(params.expression),
        "the actual detail/comment DOM expression sent to Chromium must be valid JavaScript",
      );
      return { result: { value: this.#detail() } };
    }
    if (method === "Runtime.evaluate" && params.expression.includes("reddit-flow:return-feed")) {
      this.mode = "feed";
      return { result: { value: true } };
    }
    return {};
  }

  close() {
    this.closed = true;
  }
}

class ManualCommentUpvoteCdpClient extends DetailFlowCdpClient {
  constructor({
    voteState = "neutral",
    ownerId = "t1_c1",
    ownerCanonicalId = "c1",
    ownerIdAliases = ["t1_c1", "c1"],
    kind = "comment_upvote",
    context = "comment",
    occluded = false,
    disabled = false,
    visible = true,
    inViewport = true,
    blockedReason = null,
    confidence = "high",
    targetCount = 1,
    changesOnRelease = true,
    advanceAfterFirstProbe = false,
    moveOnProbe = null,
  } = {}) {
    super();
    this.voteState = voteState;
    this.ownerId = ownerId;
    this.ownerCanonicalId = ownerCanonicalId;
    this.ownerIdAliases = ownerIdAliases;
    this.kind = kind;
    this.context = context;
    this.occluded = occluded;
    this.disabled = disabled;
    this.visible = visible;
    this.inViewport = inViewport;
    this.blockedReason = blockedReason;
    this.confidence = confidence;
    this.targetCount = targetCount;
    this.changesOnRelease = changesOnRelease;
    this.advanceAfterFirstProbe = advanceAfterFirstProbe;
    this.moveOnProbe = moveOnProbe;
    this.commentVoteProbeCount = 0;
    this.commentMouseEvents = [];
  }

  commentTarget(index = 0) {
    const neutralSignal = this.voteState === "neutral" || this.voteState === "downvoted";
    const shifted = Number.isInteger(this.moveOnProbe) && this.commentVoteProbeCount >= this.moveOnProbe;
    const baseX = (shifted ? 470 : 420) + index * 50;
    return {
      kind: this.kind,
      context: this.context,
      ownerId: this.ownerId,
      ownerCanonicalId: this.ownerCanonicalId,
      ownerIdAliases: this.ownerIdAliases,
      confidence: this.confidence,
      blockedReason: this.blockedReason,
      disabled: this.disabled,
      visible: this.visible,
      inViewport: this.inViewport,
      occluded: this.occluded,
      ariaPressed: this.voteState === "upvoted" ? true : neutralSignal ? false : null,
      selected: null,
      voteState: this.voteState,
      voteStateConflict: this.voteState === "conflict",
      center: { x: baseX, y: 180 },
      rect: { x: baseX - 20, y: 160, width: 40, height: 40 },
    };
  }

  async call(method, params = {}, sessionId = null) {
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("reddit-flow:readonly-interaction-locator")
    ) {
      this.calls.push({ method, params, sessionId });
      this.commentVoteProbeCount += 1;
      const targets = Array.from(
        { length: this.targetCount },
        (_, index) => this.commentTarget(index),
      );
      if (this.advanceAfterFirstProbe && this.commentVoteProbeCount === 1) {
        this.detailY = 1_285;
      }
      return {
        result: {
          value: {
            readonly: true,
            highlighted: false,
            url: this.detailUrl,
            pageKind: "detail",
            targets,
          },
        },
      };
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params.type !== "mouseWheel" &&
      this.mode === "detail"
    ) {
      this.calls.push({ method, params, sessionId });
      this.commentMouseEvents.push(params.type);
      if (params.type === "mouseReleased" && this.changesOnRelease) {
        this.voteState = "upvoted";
      }
      return {};
    }
    return super.call(method, params, sessionId);
  }
}

class CurrentCommentStateCdpClient extends DetailFlowCdpClient {
  constructor() {
    super();
    this.hideComments = false;
    this.preferSecondCommentControl = false;
  }

  async call(method, params = {}, sessionId = null) {
    const response = await super.call(method, params, sessionId);
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("reddit-flow:detail-dom") &&
      response?.result?.value
    ) {
      if (this.hideComments) {
        response.result.value.comments = [];
        response.result.value.commentRoot = null;
        response.result.value.explicitEmpty = true;
      } else if (this.preferSecondCommentControl) {
        response.result.value.comments = response.result.value.comments.map((comment, index) => ({
          ...comment,
          hasVisibleUpvote: index === 1,
          upvoteCenterY: index === 1 ? 420 : null,
        }));
      }
    }
    return response;
  }
}

async function detailFlowSession(client) {
  const session = new BrowserSession({
    client,
    settleMs: 0,
    navigationTimeoutMs: 100,
    restoreTimeoutMs: 100,
    inputRandomIntegerFn: (_min, max) => max,
    inputDelayFn: async () => {},
  });
  await session.connect("ws://127.0.0.1/devtools/browser/detail-flow");
  return session;
}

test("readonly detail flow clicks a safe title, reads comments, and restores the Feed anchor", async () => {
  const client = new DetailFlowCdpClient();
  const session = await detailFlowSession(client);
  const aligned = await session.scroll();
  assert.equal(aligned.currentPost.clickEligible, true);

  const opened = await session.openCurrentPost({ expectedPostId: "p1" });
  assert.equal(opened.opened, true);
  assert.equal(opened.navigationMode, "same-target");
  assertNaturalSingleClick(client.clickEvents);

  const located = await session.locateComments();
  assert.equal(located.available, true);
  assert.equal(located.commentCount, 3);
  assert.ok(located.actualDistance > 0);
  assert.equal(located.currentComment?.commentId, "t1_c1");
  assert.equal(located.currentComment?.canonicalCommentId, "c1");
  assert.deepEqual(located.currentComment?.commentIdAliases, ["t1_c1", "c1"]);
  assert.equal(located.currentComment?.anchorInSafeViewport, true);
  assert.equal("text" in located.currentComment, false);

  const commentStep = await session.scrollComments();
  assert.equal(commentStep.moved, true);
  assert.ok(commentStep.actualDistance > 0);
  assert.equal(commentStep.currentComment?.commentId, "t1_c2");

  const returned = await session.returnToFeed();
  assert.equal(returned.returned, true);
  assert.equal(returned.anchorRestored, true);
  assert.equal(returned.currentPost.postId, "p1");
  assert.equal(returned.currentY, 0);
  assert.equal(returned.url, "https://www.reddit.com/?feed=home");
});

test("current comment prefers an owner-scoped visible upvote and never retains a stale id", async () => {
  const client = new CurrentCommentStateCdpClient();
  const session = await detailFlowSession(client);
  await session.scroll();
  await session.openCurrentPost({ expectedPostId: "p1" });
  client.preferSecondCommentControl = true;

  const located = await session.locateComments();
  assert.equal(located.currentComment?.commentId, "t1_c2");
  assert.equal(located.currentComment?.hasVisibleUpvote, true);

  client.hideComments = true;
  const step = await session.scrollCommentStep();
  assert.equal(step.currentComment, null);
});

async function readyManualCommentUpvoteSession(client) {
  const session = await detailFlowSession(client);
  await session.scroll();
  const opened = await session.openCurrentPost({ expectedPostId: "p1" });
  assert.equal(opened.opened, true);
  const located = await session.locateComments();
  assert.equal(located.currentComment?.commentId, "t1_c1");
  client.commentMouseEvents.length = 0;
  return session;
}

test("manual comment upvote resolves t1 aliases and dispatches exactly one verified click", async () => {
  const client = new ManualCommentUpvoteCdpClient();
  const session = await readyManualCommentUpvoteSession(client);

  const result = await session.manualUpvoteCurrentComment({ expectedCommentId: "c1" });

  assert.deepEqual(
    {
      ok: result.ok,
      changed: result.changed,
      alreadyUpvoted: result.alreadyUpvoted,
      uncertain: result.uncertain,
      commentId: result.commentId,
      beforeState: result.beforeState,
      afterState: result.afterState,
    },
    {
      ok: true,
      changed: true,
      alreadyUpvoted: false,
      uncertain: false,
      commentId: "c1",
      beforeState: "neutral",
      afterState: "upvoted",
    },
  );
  assertNaturalSingleClick(client.commentMouseEvents);
  assert.equal(client.commentVoteProbeCount, 4);
});

test("manual comment upvote is idempotent when the exact comment is already upvoted", async () => {
  const client = new ManualCommentUpvoteCdpClient({ voteState: "upvoted" });
  const session = await readyManualCommentUpvoteSession(client);

  const result = await session.manualUpvoteCurrentComment({ expectedCommentId: "t1_c1" });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.alreadyUpvoted, true);
  assert.equal(result.beforeState, "upvoted");
  assert.equal(result.afterState, "upvoted");
  assert.deepEqual(client.commentMouseEvents, []);
});

test("manual comment upvote rechecks that the confirmed comment is still current", async () => {
  const client = new ManualCommentUpvoteCdpClient({ advanceAfterFirstProbe: true });
  const session = await readyManualCommentUpvoteSession(client);

  const result = await session.manualUpvoteCurrentComment({ expectedCommentId: "t1_c1" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "current-comment-mismatch");
  assert.equal(client.commentVoteProbeCount, 1);
  assert.deepEqual(client.commentMouseEvents, []);
});

test("manual comment upvote revalidates its exact control after natural hover", async () => {
  const client = new ManualCommentUpvoteCdpClient({ moveOnProbe: 3 });
  const session = await readyManualCommentUpvoteSession(client);

  const result = await session.manualUpvoteCurrentComment({ expectedCommentId: "t1_c1" });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, false);
  assert.equal(result.reason, "comment-upvote-target-changed-before-click");
  assert.equal(client.commentMouseEvents.filter((type) => type === "mousePressed").length, 0);
  assert.equal(client.commentMouseEvents.filter((type) => type === "mouseReleased").length, 0);
});

test("an unconfirmed manual comment upvote locks that comment for the session", async () => {
  const client = new ManualCommentUpvoteCdpClient({ changesOnRelease: false });
  const session = await readyManualCommentUpvoteSession(client);

  const first = await session.manualUpvoteCurrentComment({ expectedCommentId: "t1_c1" });
  const second = await session.manualUpvoteCurrentComment({ expectedCommentId: "c1" });

  assert.equal(first.ok, false);
  assert.equal(first.uncertain, true);
  assert.equal(first.reason, "comment-upvote-not-confirmed");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "comment-upvote-already-attempted");
  assertNaturalSingleClick(client.commentMouseEvents);
});

test("manual comment upvote fails closed for unsafe targets and vote states", async (t) => {
  const cases = [
    ["wrong owner", { ownerId: "t1_other", ownerCanonicalId: "other", ownerIdAliases: ["t1_other", "other"] }, "comment-upvote-not-found"],
    ["post control", { kind: "post_upvote", context: "post" }, "comment-upvote-not-found"],
    ["occluded", { occluded: true }, "comment-upvote-occluded"],
    ["disabled", { disabled: true }, "comment-upvote-disabled"],
    ["ambiguous", { targetCount: 2 }, "comment-upvote-target-ambiguous"],
    ["unknown", { voteState: "unknown" }, "comment-upvote-state-not-neutral"],
    ["downvoted", { voteState: "downvoted" }, "comment-upvote-state-not-neutral"],
    ["conflicting", { voteState: "conflict" }, "comment-upvote-state-conflict"],
    ["promoted", { blockedReason: "promoted" }, "promoted"],
  ];
  for (const [name, options, reason] of cases) {
    await t.test(name, async () => {
      const client = new ManualCommentUpvoteCdpClient(options);
      const session = await readyManualCommentUpvoteSession(client);
      const result = await session.manualUpvoteCurrentComment({ expectedCommentId: "t1_c1" });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assert.deepEqual(client.commentMouseEvents, []);
    });
  }
});

test("promoted Feed units remain visible to the planner but are never clicked", async () => {
  const client = new DetailFlowCdpClient({ promoted: true });
  const session = await detailFlowSession(client);
  const aligned = await session.scroll();
  assert.equal(aligned.currentPost.isPromoted, true);
  assert.equal(aligned.currentPost.clickEligible, false);

  const opened = await session.openCurrentPost({ expectedPostId: "p1" });
  assert.equal(opened.opened, false);
  assert.equal(opened.reason, "promoted");
  assert.deepEqual(client.clickEvents, []);
  assert.equal(
    client.calls.some(
      (call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed",
    ),
    false,
  );
});

test("unsafe title targets are rejected before any click input is dispatched", async () => {
  const client = new DetailFlowCdpClient({ unsafeTitle: true });
  const session = await detailFlowSession(client);
  await session.scroll();

  const opened = await session.openCurrentPost({ expectedPostId: "p1" });
  assert.equal(opened.opened, false);
  assert.equal(opened.reason, "unsafe-title-link");
  assert.deepEqual(client.clickEvents, []);
});

test("a title that moves during natural hover is rechecked without pressing", async () => {
  const client = new DetailFlowCdpClient({ moveTitleBeforePress: true });
  const session = await detailFlowSession(client);
  await session.scroll();

  const opened = await session.openCurrentPost({ expectedPostId: "p1" });

  assert.equal(opened.opened, false);
  assert.equal(opened.reason, "title-target-changed-before-click");
  assert.ok(client.clickEvents.filter((type) => type === "mouseMoved").length >= 2);
  assert.equal(client.clickEvents.filter((type) => type === "mousePressed").length, 0);
  assert.equal(client.clickEvents.filter((type) => type === "mouseReleased").length, 0);
});

test("the title hit-test accepts only Reddit's same-post full-link overlay", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/reddit-selectors.js", import.meta.url), "utf8"),
  );
  assert.match(source, /getAttribute\('slot'\) === 'full-post-link'/);
  assert.match(source, /hitUrl\.pathname === parsed\.pathname/);
  assert.match(source, /hitUrl\.search === parsed\.search/);
  assert.doesNotMatch(source, /samePostOverlay\s*=\s*Boolean\(hitAnchor\)/);
});

test("a title-opened detail tab is tied to the Feed opener and closed on return", async () => {
  const client = new DetailFlowCdpClient({ newTarget: true });
  const session = await detailFlowSession(client);
  await session.scroll();

  const opened = await session.openCurrentPost({ expectedPostId: "p1" });
  assert.equal(opened.opened, true);
  assert.equal(opened.navigationMode, "new-target");
  const returned = await session.returnToFeed();
  assert.equal(returned.returned, true);
  assert.equal(client.detailTargetClosed, true);
  assert.equal(returned.currentPost.postId, "p1");
});
