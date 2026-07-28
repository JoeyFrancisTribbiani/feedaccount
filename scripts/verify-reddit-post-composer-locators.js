import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { CdpClient } from "../src/cdp-client.js";
import { locateRedditPostComposerTargets } from "../src/reddit-interaction-locator.js";

const profileSeq = Number(process.argv[2] || 4);
const api = new BitBrowserApi("http://127.0.0.1:54345");
const profiles = await api.listProfiles({ includeAlive: false });
const profile = profiles.find((item) => Number(item.seq) === profileSeq) || profiles[0];
if (!profile) throw new Error("没有找到 BitBrowser 实例");

const connection = await api.openProfile(profile.id);
const client = new CdpClient();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let sessionId = null;

try {
  await client.connect(connection.wsUrl);
  const { targetInfos = [] } = await client.call("Target.getTargets");
  const feed = targetInfos.find(
    (target) => target.type === "page" && target.url === "https://www.reddit.com/?feed=home",
  );
  if (!feed) throw new Error("未找到 Reddit Feed 标签页");
  const attached = await client.call("Target.attachToTarget", {
    targetId: feed.targetId,
    flatten: true,
  });
  sessionId = attached.sessionId;
  await client.call("Page.enable", {}, sessionId);
  const history = await client.call("Page.getNavigationHistory", {}, sessionId).catch(() => null);
  const originalEntryId = history?.entries?.[history.currentIndex]?.id ?? null;
  await client.call("Page.navigate", { url: "https://www.reddit.com/submit" }, sessionId, 30_000);

  let result = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    result = await locateRedditPostComposerTargets({ client, sessionId }).catch(() => null);
    if (
      result?.pageKind === "submit" &&
      result.targets.some((target) => target.kind !== "create_post_entry")
    ) break;
  }
  const diagnostic = await client.call(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const items = [];
        const visit = (root, hosts = []) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let element = walker.nextNode();
          while (element) {
            const tag = element.tagName.toLowerCase();
            const inMain = Boolean(element.closest?.('main, [role="main"]'));
            if (
              (inMain && element.matches?.('input, textarea, button, [contenteditable="true"], [role="textbox"]')) ||
              (element.tagName.includes('-') && /composer|submit|editor/i.test(tag))
            ) {
              const rect = element.getBoundingClientRect();
              items.push({
                tag,
                id: element.id || null,
                name: element.getAttribute('name'),
                type: element.getAttribute('type'),
                role: element.getAttribute('role'),
                ariaLabel: element.getAttribute('aria-label'),
                placeholder: element.getAttribute('placeholder'),
                testId: element.getAttribute('data-testid'),
                text: (element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
                hosts,
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              });
            }
            if (element.shadowRoot) visit(element.shadowRoot, [...hosts, tag + (element.id ? '#' + element.id : '')]);
            element = walker.nextNode();
          }
        };
        visit(document);
        return { url: location.href, items: items.slice(0, 100) };
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  console.log(JSON.stringify({
    readonly: result?.readonly,
    pageKind: result?.pageKind,
    targets: (result?.targets || []).map(
      ({ kind, selectorHint, shadowHosts, disabled, visible, inViewport, rect }) => ({
        kind,
        selectorHint,
        shadowHosts,
        disabled,
        visible,
        inViewport,
        rect,
      }),
    ),
    diagnostic: diagnostic.result.value,
  }, null, 2));

  if (originalEntryId !== null) {
    await client.call("Page.navigateToHistoryEntry", { entryId: originalEntryId }, sessionId, 10_000);
  } else {
    await client.call(
      "Runtime.evaluate",
      { expression: "history.back(); true", returnByValue: true },
      sessionId,
    );
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    const state = await client.call(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    ).catch(() => null);
    if (state?.result?.value === "https://www.reddit.com/?feed=home") break;
  }
} finally {
  if (sessionId) {
    await client.call("Target.detachFromTarget", { sessionId }, null, 3_000).catch(() => {});
  }
  client.close();
}
