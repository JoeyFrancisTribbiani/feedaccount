import test from "node:test";
import assert from "node:assert/strict";

import { LocalDatabase } from "../src/database.js";
import { createMonitorServer } from "../src/server.js";

const options = {
  waitMinSec: 1,
  waitMaxSec: 2,
  waitMinMs: 1_000,
  waitMaxMs: 2_000,
  maxPosts: 5,
  autoStopAtBottom: false,
  detailLoopEnabled: true,
  detailAfterMinPosts: 3,
  detailAfterMaxPosts: 8,
  detailWaitMinSec: 2,
  detailWaitMaxSec: 15,
  commentScrollMin: 2,
  commentScrollMax: 7,
  returnWaitMinSec: 2,
  returnWaitMaxSec: 4,
};

async function jsonRequest(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  return { response, body: await response.json() };
}

test("database HTTP endpoints expose settings, profiles, history, logs and stats", async (t) => {
  const database = new LocalDatabase(":memory:");
  const runId = database.createRun(
    { id: "profile-api", seq: 7, name: "API profile" },
    options,
    "https://www.reddit.com/?feed=home",
    "2026-07-15T00:00:00.000Z",
  );
  database.addEvent({
    runId,
    profileId: "profile-api",
    level: "info",
    eventType: "lifecycle",
    message: "Created before HTTP test",
  });

  const bitBrowserApi = {
    async listProfiles() {
      return [
        { id: "profile-api", seq: 7, name: "API profile", status: 1, running: true, pid: 9876 },
      ];
    },
    async openProfile() {
      throw new Error("not used by this test");
    },
  };
  const { server } = createMonitorServer({ bitBrowserApi, database, databasePath: ":memory:" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const config = await jsonRequest(baseUrl, "/api/config");
  assert.equal(config.response.status, 200);
  assert.equal(config.body.databaseFile, ":memory:");
  assert.equal(config.body.defaults.maxPosts, 0);
  assert.equal(config.body.defaults.detailLoopEnabled, true);
  assert.equal(config.body.defaults.detailAfterMinPosts, 3);
  assert.equal(config.body.defaults.detailAfterMaxPosts, 8);
  assert.equal("scrollMinPx" in config.body.defaults, false);

  const profiles = await jsonRequest(baseUrl, "/api/profiles");
  assert.equal(profiles.response.status, 200);
  assert.equal(profiles.body.profiles[0].id, "profile-api");

  const crossSite = await jsonRequest(baseUrl, "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ options }),
  });
  assert.equal(crossSite.response.status, 403);

  const saved = await jsonRequest(baseUrl, "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ options }),
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.body.options, {
    waitMinSec: 1,
    waitMaxSec: 2,
    maxPosts: 5,
    autoStopAtBottom: false,
    detailLoopEnabled: true,
    detailAfterMinPosts: 3,
    detailAfterMaxPosts: 8,
    detailWaitMinSec: 2,
    detailWaitMaxSec: 15,
    commentScrollMin: 2,
    commentScrollMax: 7,
    returnWaitMinSec: 2,
    returnWaitMaxSec: 4,
    autoUpvoteEnabled: false,
    autoUpvoteProbability: 0,
    autoCommentUpvoteEnabled: false,
    autoCommentUpvoteProbability: 0,
    autoJoinEnabled: false,
    autoJoinIntervalMinSec: 60,
    autoJoinIntervalMaxSec: 180,
    autoJoinMaxPerRun: 3,
    autoCommentEnabled: false,
    autoCommentProbability: 0,
    autoCommentMinIntervalSec: 1800,
    autoCommentMaxIntervalSec: 7200,
    autoCommentMaxPerRun: 2,
    autoCommentTexts: [],
  });

  const legacySaved = await jsonRequest(baseUrl, "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      options: { waitMinSec: 3, waitMaxSec: 4, maxScrolls: 8, autoStopAtBottom: true },
    }),
  });
  assert.equal(legacySaved.response.status, 200);
  assert.equal(legacySaved.body.options.maxPosts, 8);
  assert.equal(legacySaved.body.options.detailLoopEnabled, true);
  assert.equal(legacySaved.body.options.commentScrollMax, 7);
  assert.equal("maxScrolls" in legacySaved.body.options, false);

  const history = await jsonRequest(baseUrl, "/api/history?profileId=profile-api");
  assert.equal(history.response.status, 200);
  assert.equal(history.body.runs.length, 1);

  const detail = await jsonRequest(baseUrl, `/api/history/${runId}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.run.events.length, 1);

  const logs = await jsonRequest(baseUrl, "/api/logs?level=info");
  assert.equal(logs.response.status, 200);
  assert.equal(logs.body.logs.length, 1);

  const stats = await jsonRequest(baseUrl, "/api/stats");
  assert.equal(stats.response.status, 200);
  assert.equal(stats.body.stats.profileCount, 1);
  assert.equal(stats.body.stats.runCount, 1);
  assert.equal(stats.body.stats.eventCount, 1);

  const csvResponse = await fetch(`${baseUrl}/api/export/history.csv`);
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /"工作流模式"/);
  assert.match(csv, /"查看详情"/);
  assert.match(csv, /"评论区移动"/);
  assert.match(csv, /"跳过广告"/);

  const missing = await jsonRequest(baseUrl, "/api/history/999999");
  assert.equal(missing.response.status, 404);

  const cleared = await jsonRequest(baseUrl, "/api/logs", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId: "profile-api" }),
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.deleted, 1);
});

test("server close terminates an open event stream before closing the database", async () => {
  const database = new LocalDatabase(":memory:");
  const bitBrowserApi = { listProfiles: async () => [], openProfile: async () => ({}) };
  const { server } = createMonitorServer({ bitBrowserApi, database, databasePath: ":memory:" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(eventResponse.status, 200);

  await Promise.race([
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("server close was blocked by the event stream")), 500),
    ),
  ]);
});
