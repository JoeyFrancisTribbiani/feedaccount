import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { BrowserSession } from "../src/browser-session.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const session = new BrowserSession({ settleMs: 0 });

try {
  const page = await session.connect(connection.wsUrl);
  const votes = await session.locateVoteControls();
  const postUpvotes = votes.targets.filter((target) => target.kind === "post_upvote");
  const visible = postUpvotes.filter((target) => target.visible && target.inViewport);
  const safeNeutral = visible.filter(
    (target) =>
      target.confidence === "high" &&
      !target.blockedReason &&
      target.disabled === false &&
      target.occluded === false &&
      target.voteState === "neutral",
  );

  process.stdout.write(
    JSON.stringify(
      {
        profileSeq: profile.seq,
        pageKind: votes.pageKind,
        currentPostDetected: Boolean(page.currentPost?.postId),
        currentPostOrdinary: Boolean(page.currentPost?.postId && !page.currentPost?.isPromoted),
        postUpvoteTargets: postUpvotes.length,
        visiblePostUpvoteTargets: visible.length,
        safeNeutralTargets: safeNeutral.length,
        alreadyUpvotedTargets: visible.filter((target) => target.voteState === "upvoted").length,
        unknownOrConflictingTargets: visible.filter((target) =>
          ["unknown", "conflict", "downvoted"].includes(target.voteState),
        ).length,
        inputDispatched: false,
      },
      null,
      2,
    ),
  );
} finally {
  await session.close();
}
