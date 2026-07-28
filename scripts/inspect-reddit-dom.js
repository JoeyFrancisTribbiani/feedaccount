import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { BrowserSession } from "../src/browser-session.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const session = new BrowserSession();
try {
  await session.connect(connection.wsUrl);
  const result = await session.client.call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const selectors = [
          "shreddit-post",
          'article[data-testid="post-container"]',
          'div[data-testid="post-container"]',
          "article",
        ];
        const summary = {
          viewport: {
            width: innerWidth,
            height: innerHeight,
            y: Math.round(scrollY),
            documentHeight: document.documentElement.scrollHeight,
          },
          selectors: {},
          fixedElements: [...document.querySelectorAll("body *")]
            .filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                (style.position === "fixed" || style.position === "sticky") &&
                rect.height > 0 &&
                rect.top <= 80 &&
                rect.bottom > 0
              );
            })
            .slice(0, 12)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                id: element.id,
                className: String(element.className).slice(0, 120),
                position: getComputedStyle(element).position,
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                height: Math.round(rect.height),
              };
            }),
        };
        for (const selector of selectors) {
          const elements = [...document.querySelectorAll(selector)];
          summary.selectors[selector] = {
            count: elements.length,
            heights: [...new Set(elements.map((element) => Math.round(element.getBoundingClientRect().height)))],
            items: elements.slice(0, 8).map((element, index) => {
              const rect = element.getBoundingClientRect();
              const attributes = {};
              for (const name of element.getAttributeNames()) {
                if (/post|id|view|feed|slot/i.test(name)) {
                  attributes[name] = element.getAttribute(name);
                }
              }
              const link = element.querySelector('a[href*="/comments/"]');
              const title = element.querySelector('[slot="title"], h1, h2, h3');
              return {
                index,
                tag: element.tagName.toLowerCase(),
                id: element.id,
                className: String(element.className).slice(0, 180),
                rect: {
                  top: Math.round(rect.top),
                  bottom: Math.round(rect.bottom),
                  height: Math.round(rect.height),
                  width: Math.round(rect.width),
                },
                attributes,
                link: link?.href || null,
                title: (title?.textContent || "").trim().slice(0, 120),
                hasShadowRoot: Boolean(element.shadowRoot),
              };
            }),
          };
        }
        return summary;
      })()`,
      returnByValue: true,
    },
    session.sessionId,
  );
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  await session.close();
}
