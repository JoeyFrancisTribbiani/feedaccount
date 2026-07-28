import test from "node:test";
import assert from "node:assert/strict";

import { BrowserSession } from "../src/browser-session.js";
import {
  buildRedditInteractionLocatorExpression,
  isRedditSubmitPath,
  locateRedditCommentTargets,
  locateRedditInteractionTargets,
  locateRedditPostComposerTargets,
  locateRedditVoteTargets,
} from "../src/reddit-interaction-locator.js";

const sampleTargets = [
  {
    kind: "post_upvote",
    ownerId: "t3_post",
    ownerCanonicalId: "post",
    ownerIdAliases: ["t3_post", "post"],
    inViewport: true,
    ariaPressed: false,
    selected: null,
    voteState: "neutral",
    voteStateConflict: false,
  },
  {
    kind: "comment_downvote",
    ownerId: "t1_comment",
    ownerCanonicalId: "comment",
    ownerIdAliases: ["t1_comment", "comment"],
    inViewport: true,
  },
  { kind: "comment_editor", ownerId: "t3_post", inViewport: false },
  { kind: "comment_submit", ownerId: "t3_post", inViewport: false },
  { kind: "create_post_entry", ownerId: null, inViewport: true },
  { kind: "post_title_editor", ownerId: null, inViewport: true },
  { kind: "post_body_editor", ownerId: null, inViewport: true },
  { kind: "post_submit", ownerId: null, inViewport: true },
];

class LocatorClient {
  constructor() {
    this.calls = [];
  }

  async call(method, params, sessionId, timeoutMs) {
    this.calls.push({ method, params, sessionId, timeoutMs });
    return {
      result: {
        value: {
          readonly: true,
          highlighted: params.expression.includes("const highlight = true"),
          url: "https://www.reddit.com/r/test/comments/post/title/",
          pageKind: "detail",
          targets: sampleTargets,
        },
      },
    };
  }
}

test("locator expression is valid JavaScript and contains no interaction dispatch", () => {
  const expression = buildRedditInteractionLocatorExpression({ highlight: true, highlightMs: 999_999 });
  assert.doesNotThrow(() => new Function(expression));
  assert.match(expression, /reddit-flow:readonly-interaction-locator/);
  assert.match(expression, /const highlight = true/);
  assert.match(expression, /const highlightMs = 30000/);
  assert.doesNotMatch(expression, /\.click\s*\(/);
  assert.doesNotMatch(expression, /\.focus\s*\(|\.submit\s*\(|requestSubmit|dispatchEvent/);
  assert.doesNotMatch(expression, /dispatchMouseEvent|dispatchKeyEvent|insertText|synthesizeTapGesture/);
  assert.doesNotMatch(expression, /fetch\s*\(|XMLHttpRequest|WebSocket|\.value\s*=/);
  assert.match(expression, /ownerCanonicalId/);
  assert.match(expression, /ownerIdAliases/);
  assert.match(expression, /stableDomId/);
  assert.match(expression, /canonicalId \? 't1_' \+ canonicalId/);
  assert.match(expression, /ariaPressed/);
  assert.match(expression, /voteStateConflict/);
  assert.match(expression, /target\.voteState/);
});

test("submit path matching is limited to Reddit's global or subreddit composer routes", () => {
  assert.equal(isRedditSubmitPath("/submit"), true);
  assert.equal(isRedditSubmitPath("/submit/"), true);
  assert.equal(isRedditSubmitPath("/r/test/submit"), true);
  assert.equal(isRedditSubmitPath("/r/test/submit/"), true);
  assert.equal(isRedditSubmitPath("/comments/submit"), false);
  assert.equal(isRedditSubmitPath("/r/test/comments/submit"), false);
  assert.equal(isRedditSubmitPath("/foo/submit"), false);
});

test("locator makes one read-only Runtime.evaluate call and returns geometry metadata", async () => {
  const client = new LocatorClient();
  const result = await locateRedditInteractionTargets({
    client,
    sessionId: "reddit-session",
    highlight: true,
    highlightMs: 2_000,
  });

  assert.equal(result.readonly, true);
  assert.equal(result.targets.length, sampleTargets.length);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "Runtime.evaluate");
  assert.equal(client.calls[0].sessionId, "reddit-session");
  assert.equal(client.calls[0].params.returnByValue, true);
  assert.equal(result.targets[0].ownerCanonicalId, "post");
  assert.equal(result.targets[0].ariaPressed, false);
  assert.equal(result.targets[0].voteState, "neutral");
  assert.equal(result.targets[1].ownerCanonicalId, "comment");
  assert.deepEqual(result.targets[1].ownerIdAliases, ["t1_comment", "comment"]);
});

test("vote, comment, and post-composer wrappers expose only their own locator kinds", async () => {
  const client = new LocatorClient();
  const common = { client, sessionId: "reddit-session" };
  const votes = await locateRedditVoteTargets(common);
  const comments = await locateRedditCommentTargets(common);
  const postComposer = await locateRedditPostComposerTargets(common);

  assert.deepEqual(votes.targets.map((target) => target.kind), ["post_upvote", "comment_downvote"]);
  assert.deepEqual(comments.targets.map((target) => target.kind), ["comment_editor", "comment_submit"]);
  assert.deepEqual(postComposer.targets.map((target) => target.kind), [
    "create_post_entry",
    "post_title_editor",
    "post_body_editor",
    "post_submit",
  ]);
});

test("BrowserSession exposes locator helpers without adding them to the job workflow", async () => {
  const client = new LocatorClient();
  const session = new BrowserSession({ client });
  session.sessionId = "reddit-session";

  const votes = await session.locateVoteControls();
  const comments = await session.locateCommentControls();
  const composer = await session.locatePostComposerControls();

  assert.equal(votes.targets.every((target) => target.kind.includes("vote")), true);
  assert.equal(comments.targets.every((target) => target.kind.startsWith("comment_")), true);
  assert.equal(composer.targets.every((target) => !target.kind.startsWith("comment_")), true);
});

test("locator rejects missing CDP context", async () => {
  await assert.rejects(() => locateRedditInteractionTargets(), /CDP/);
  await assert.rejects(
    () => locateRedditInteractionTargets({ client: new LocatorClient() }),
    /会话 ID/,
  );
});

test("the automatic JobManager never calls interaction locator helpers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/job-manager.js", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(
    source,
    /locateInteractionTargets|locateVoteControls|locateCommentControls|locatePostComposerControls/,
  );
});
