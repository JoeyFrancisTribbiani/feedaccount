import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { BrowserSession } from "../src/browser-session.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const session = new BrowserSession({ settleMs: 120 });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  const connected = await session.connect(connection.wsUrl);
  const feedResult = await session.client.call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const posts = [...document.querySelectorAll("main shreddit-post, shreddit-post")];
        const visible = posts
          .map((post) => {
            const rect = post.getBoundingClientRect();
            const promoted =
              post.matches('[promoted], [is-promoted], [data-promoted="true"]') ||
              /promoted|advertisement/i.test(post.getAttribute("post-type") || "");
            const link = post.querySelector('a[href*="/comments/"]');
            return {
              post,
              rect,
              promoted,
              href: link?.href || "",
              score: Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)),
            };
          })
          .filter((item) => !item.promoted && item.href)
          .sort((left, right) => right.score - left.score)[0];
        if (!visible) return null;
        return {
          postId: visible.post.id || visible.post.getAttribute("data-post-id"),
          title: visible.post.getAttribute("post-title") || "",
          href: visible.href,
          feedY: Math.round(scrollY),
          links: [...visible.post.querySelectorAll("a")]
            .map((link) => {
              const rect = link.getBoundingClientRect();
              return {
                id: link.id,
                slot: link.getAttribute("slot"),
                ariaLabel: link.getAttribute("aria-label"),
                href: link.href,
                text: (link.textContent || "").trim().slice(0, 100),
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })
            .filter((link) => link.href)
            .slice(0, 20),
        };
      })()`,
      returnByValue: true,
    },
    session.sessionId,
  );
  const feed = feedResult.result.value;
  if (!feed?.href) throw new Error("当前 Feed 没有可检查的非广告帖子");

  const domReady = session.client
    .waitForEvent("Page.domContentEventFired", { sessionId: session.sessionId, timeoutMs: 30000 })
    .catch(() => null);
  await session.client.call("Page.navigate", { url: feed.href }, session.sessionId, 30000);
  await domReady;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await session.client.call(
      "Runtime.evaluate",
      {
        expression:
          '({ ready: document.readyState, hasPost: Boolean(document.querySelector("shreddit-post")), hasComments: Boolean(document.querySelector("shreddit-comment-tree, shreddit-comment")) })',
        returnByValue: true,
      },
      session.sessionId,
    );
    if (probe.result.value?.hasPost || probe.result.value?.hasComments) break;
    await delay(500);
  }
  const detailResult = await session.client.call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const selectors = [
          "shreddit-comment-tree",
          "shreddit-comment",
          "comment-body-header",
          '[data-testid="comment"]',
          '[id*="comment-tree"]',
          '[aria-label*="comment" i]',
          'a[href*="/comments/"]',
        ];
        const selectorCounts = Object.fromEntries(
          selectors.map((selector) => [selector, document.querySelectorAll(selector).length]),
        );
        const elements = [...document.querySelectorAll(
          'shreddit-comment-tree, shreddit-comment, [data-testid="comment"], [id*="comment-tree"]',
        )]
          .slice(0, 12)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName.toLowerCase(),
              id: element.id,
              slot: element.getAttribute("slot"),
              depth: element.getAttribute("depth"),
              thingId: element.getAttribute("thingid"),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              height: Math.round(rect.height),
              width: Math.round(rect.width),
              display: style.display,
              visibility: style.visibility,
              shadow: Boolean(element.shadowRoot),
            };
          });
        const mainPost = document.querySelector("main shreddit-post, shreddit-post");
        const postRect = mainPost?.getBoundingClientRect();
        return {
          url: location.href,
          title: document.title,
          ready: document.readyState,
          viewport: { width: innerWidth, height: innerHeight, y: Math.round(scrollY) },
          mainPost: mainPost
            ? {
                id: mainPost.id,
                title: mainPost.getAttribute("post-title"),
                top: Math.round(postRect.top),
                bottom: Math.round(postRect.bottom),
                height: Math.round(postRect.height),
              }
            : null,
          selectorCounts,
          elements,
        };
      })()`,
      returnByValue: true,
    },
    session.sessionId,
  );

  console.log(JSON.stringify({ connected, feed, detail: detailResult.result.value }, null, 2));

  await session.client.call(
    "Runtime.evaluate",
    { expression: "history.back(); true", returnByValue: true },
    session.sessionId,
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    const state = await session.inspect();
    if (state.url === "https://www.reddit.com/?feed=home") break;
  }
} finally {
  await session.close();
}
