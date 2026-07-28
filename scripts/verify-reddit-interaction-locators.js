import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { BrowserSession } from "../src/browser-session.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const session = new BrowserSession({ settleMs: 100 });

function summarize(result) {
  const counts = {};
  for (const target of result.targets) counts[target.kind] = (counts[target.kind] || 0) + 1;
  return {
    readonly: result.readonly,
    pageKind: result.pageKind,
    counts,
    visible: result.targets
      .filter((target) => target.inViewport)
      .slice(0, 12)
      .map(({ kind, ownerId, selectorHint, shadowHosts, disabled, rect }) => ({
        kind,
        ownerId,
        selectorHint,
        shadowHosts,
        disabled,
        rect,
      })),
  };
}

try {
  await session.connect(connection.wsUrl);
  let aligned = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    aligned = await session.scroll();
    if (aligned.currentPost?.clickEligible && !aligned.currentPost?.isPromoted) break;
  }
  if (!aligned?.currentPost?.clickEligible) throw new Error("没有找到可用于只读核对的普通帖子");

  const feed = summarize(await session.locateInteractionTargets());
  const opened = await session.openCurrentPost({ expectedPostId: aligned.currentPost.postId });
  if (!opened.opened) throw new Error(`无法打开详情用于只读核对：${opened.reason}`);
  const detailTop = summarize(await session.locateInteractionTargets());
  const commentsLocation = await session.locateComments();
  const comments = summarize(await session.locateInteractionTargets());
  console.log(JSON.stringify({
    postId: aligned.currentPost.postId,
    feed,
    detailTop,
    commentsLocation: {
      available: commentsLocation.available,
      commentCount: commentsLocation.commentCount,
    },
    comments,
  }, null, 2));
  await session.returnToFeed();
} finally {
  await session.close();
}
