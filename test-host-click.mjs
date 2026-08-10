import { CdpClient } from "./src/cdp-client.js";

const client = new CdpClient();
const res = await fetch("http://127.0.0.1:54345/browser/open", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: "dbc5c860207843e98c35c303b171a18d" }),
});
const data = await res.json();
await client.connect(data.data.ws);

const targets = await client.call("Target.getTargets", {}, null, 5000);
const page = targets.targetInfos.find((t) => t.type === "page");
const sid = await client.call("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null, 5000);
const sessionId = sid.sessionId;

await client.call("Page.navigate", { url: "https://www.reddit.com/r/cats/comments/1vf38ox/found_this_kitten_at_a_gas_station_and_trying_to/" }, sessionId, 30000);
await new Promise((r) => setTimeout(r, 8000));

// Check COMMENT-COMPOSER-HOST shadow DOM and try clicking it
const expr = `(() => {
  const host = document.querySelector('comment-composer-host');
  if (!host) return JSON.stringify({ error: 'no-host' });
  
  const hostRect = host.getBoundingClientRect();
  const shadow = host.shadowRoot;
  let shadowInfo = null;
  if (shadow) {
    const all = [...shadow.querySelectorAll('*')];
    const visible = all.filter(e => e.getBoundingClientRect().height > 0);
    shadowInfo = {
      hasShadow: true,
      totalElements: all.length,
      visibleElements: visible.length,
      elements: visible.slice(0, 10).map(e => ({
        tag: e.tagName,
        class: (e.className||'').toString().substring(0,50),
        text: (e.textContent||'').trim().substring(0,40),
        aria: e.getAttribute('aria-label'),
        role: e.getAttribute('role'),
        rectTop: Math.round(e.getBoundingClientRect().top),
        rectH: Math.round(e.getBoundingClientRect().height),
        rectW: Math.round(e.getBoundingClientRect().width),
        ce: e.getAttribute('contenteditable'),
      })),
    };
  }
  
  return JSON.stringify({
    hostRect: { top: Math.round(hostRect.top), left: Math.round(hostRect.left), w: Math.round(hostRect.width), h: Math.round(hostRect.height) },
    shadowInfo,
  });
})()`;

let r = await client.call("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId, 10000);
console.log("Host info:", r?.result?.value);

// Get the center of the host element
const rectExpr = `(() => {
  const host = document.querySelector('comment-composer-host');
  const r = host.getBoundingClientRect();
  // Also check shadow DOM for clickable elements
  const shadow = host.shadowRoot;
  let clickTarget = null;
  if (shadow) {
    const clickable = shadow.querySelector('button, [role="button"], [contenteditable], input, [data-testid]');
    if (clickable) {
      const cr = clickable.getBoundingClientRect();
      clickTarget = {
        tag: clickable.tagName,
        class: (clickable.className||'').toString().substring(0,50),
        aria: clickable.getAttribute('aria-label'),
        x: Math.round(cr.x + cr.width/2),
        y: Math.round(cr.y + cr.height/2),
        w: Math.round(cr.width),
        h: Math.round(cr.height),
      };
    }
  }
  return JSON.stringify({
    hostCenter: { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) },
    clickTarget,
  });
})()`;

r = await client.call("Runtime.evaluate", { expression: rectExpr, returnByValue: true }, sessionId, 5000);
const rectInfo = JSON.parse(r?.result?.value || "{}");
console.log("\nClick target:", JSON.stringify(rectInfo));

// Click the host center (or shadow DOM element)
const clickX = rectInfo.clickTarget?.x || rectInfo.hostCenter?.x;
const clickY = rectInfo.clickTarget?.y || rectInfo.hostCenter?.y;
console.log("Clicking at:", clickX, clickY);

if (clickX && clickY && clickY > 0) {
  await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: clickX, y: clickY }, sessionId, 5000);
  await new Promise((r) => setTimeout(r, 200));
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: clickX, y: clickY, button: "left", clickCount: 1 }, sessionId, 5000);
  await new Promise((r) => setTimeout(r, 100));
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: clickX, y: clickY, button: "left", clickCount: 1 }, sessionId, 5000);
  console.log("Clicked!");
  await new Promise((r) => setTimeout(r, 2000));
  
  // Check if composer is now expanded
  const checkExpr = `(() => {
    const composer = document.querySelector('shreddit-composer');
    const ce = document.querySelector('shreddit-composer [contenteditable="true"]');
    const host = document.querySelector('comment-composer-host');
    return JSON.stringify({
      composerRect: composer ? { w: Math.round(composer.getBoundingClientRect().width), h: Math.round(composer.getBoundingClientRect().height), top: Math.round(composer.getBoundingClientRect().top) } : null,
      hasCE: !!ce,
      ceRect: ce ? { w: Math.round(ce.getBoundingClientRect().width), h: Math.round(ce.getBoundingClientRect().height), top: Math.round(ce.getBoundingClientRect().top) } : null,
      hostRect: host ? { w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height) } : null,
    });
  })()`;
  r = await client.call("Runtime.evaluate", { expression: checkExpr, returnByValue: true }, sessionId, 5000);
  console.log("After click:", r?.result?.value);
  
  // If expanded, try inserting text
  const checkInfo = JSON.parse(r?.result?.value || "{}");
  if (checkInfo.hasCE && checkInfo.ceRect?.h > 0) {
    console.log("\nEditor is active! Inserting text...");
    await client.call("Input.insertText", { text: "This is so helpful, thanks for sharing!" }, sessionId, 5000);
    console.log("Text inserted!");
    await new Promise((r) => setTimeout(r, 1000));
    
    // Find and click submit
    const submitExpr = `(() => {
      const buttons = [...document.querySelectorAll('button')];
      for (const b of buttons) {
        const t = (b.textContent||'').trim().toLowerCase();
        if (t === 'comment' && !b.disabled && b.getBoundingClientRect().height > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ found: true, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
        }
      }
      return JSON.stringify({ found: false });
    })()`;
    r = await client.call("Runtime.evaluate", { expression: submitExpr, returnByValue: true }, sessionId, 5000);
    const submitInfo = JSON.parse(r?.result?.value || "{}");
    console.log("Submit button:", JSON.stringify(submitInfo));
    
    if (submitInfo.found) {
      await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: submitInfo.x, y: submitInfo.y }, sessionId, 5000);
      await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: submitInfo.x, y: submitInfo.y, button: "left", clickCount: 1 }, sessionId, 5000);
      await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: submitInfo.x, y: submitInfo.y, button: "left", clickCount: 1 }, sessionId, 5000);
      console.log("Submit clicked!");
      await new Promise((r) => setTimeout(r, 3000));
      console.log("Done! Comment should be posted.");
    }
  }
} else {
  console.log("No valid click target found");
}

await client.close();
