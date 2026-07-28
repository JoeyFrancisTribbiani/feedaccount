import { BitBrowserApi } from "../src/bitbrowser-api.js";
import { CdpClient } from "../src/cdp-client.js";
import { TARGET_URL } from "../src/config.js";

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
  const detail = targetInfos.find(
    (target) =>
      target.type === "page" &&
      /^https:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(target.url),
  );
  if (!detail) {
    console.log(JSON.stringify({ restored: false, reason: "detail-target-not-found" }));
    process.exitCode = 0;
  } else {
    const attached = await client.call("Target.attachToTarget", {
      targetId: detail.targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;
    await client.call("Page.enable", {}, sessionId);
    await client.call(
      "Runtime.evaluate",
      { expression: "history.back(); true", returnByValue: true },
      sessionId,
    );

    let url = detail.url;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(250);
      const state = await client.call(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        sessionId,
      ).catch(() => null);
      url = state?.result?.value || url;
      if (url === TARGET_URL) break;
    }
    if (url !== TARGET_URL) {
      await client.call("Page.navigate", { url: TARGET_URL }, sessionId, 30000);
      url = TARGET_URL;
    }
    console.log(JSON.stringify({ restored: true, url }));
  }
} finally {
  if (sessionId) {
    await client.call("Target.detachFromTarget", { sessionId }, null, 3000).catch(() => {});
  }
  client.close();
}
