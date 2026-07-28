import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { BrowserSession } from "../src/browser-session.js";
import { REDDIT_SELECTORS } from "../src/reddit-selectors.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const session = new BrowserSession({ settleMs: 100 });
try {
  await session.connect(connection.wsUrl);
  let alignment = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    alignment = await session.scroll();
    if (alignment.currentPost?.clickEligible && !alignment.currentPost?.isPromoted) break;
  }
  const result = await session.client.call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const posts = [...document.querySelectorAll(${JSON.stringify(REDDIT_SELECTORS.post.primary)})];
        const items = posts.map((post) => {
          const title = post.querySelector('a[slot="title"][href*="/comments/"], [slot="title"] a[href*="/comments/"]');
          if (!title) return null;
          const rect = title.getBoundingClientRect();
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.top + rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          const hitAnchor = hit?.closest?.('a[href]');
          return {
            postId: post.id || post.getAttribute('data-post-id'),
            titleHref: title.href,
            titleTag: title.tagName,
            titleSlot: title.getAttribute('slot'),
            rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
            point: { x, y },
            hitTag: hit?.tagName || null,
            hitId: hit?.id || null,
            hitSlot: hit?.getAttribute?.('slot') || null,
            hitClasses: hit?.className || null,
            hitAnchorHref: hitAnchor?.href || null,
            hitAnchorSlot: hitAnchor?.getAttribute?.('slot') || null,
            hitInsidePost: Boolean(hit && post.contains(hit)),
            hitInsideTitle: Boolean(hit && (hit === title || title.contains(hit))),
          };
        }).filter(Boolean).sort((left, right) => Math.abs(left.rect.top - 65) - Math.abs(right.rect.top - 65)).slice(0, 8);
        return {
          url: location.href,
          scrollY: Math.round(scrollY),
          postCount: posts.length,
          titleLinkCount: document.querySelectorAll('a[slot="title"][href*="/comments/"], [slot="title"] a[href*="/comments/"]').length,
          items,
        };
      })()`,
      returnByValue: true,
    },
    session.sessionId,
  );
  console.log(JSON.stringify({ alignment, hitTest: result.result.value }, null, 2));
} finally {
  await session.close();
}
