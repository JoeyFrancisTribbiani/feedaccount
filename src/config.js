import { randomInt as cryptoRandomInt } from "node:crypto";

export const TARGET_URL = "https://www.reddit.com/?feed=home";
export const DEFAULT_BITBROWSER_API = "http://127.0.0.1:54345";
export const DEFAULT_SERVER_PORT = 39210;

export const DEFAULT_OPTIONS = Object.freeze({
  waitMinSec: 5,
  waitMaxSec: 15,
  maxPosts: 0,
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

function integerInRange(value, fallback, label, min, max) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return candidate;
}

export function normalizeOptions(input = {}) {
  const waitMinSec = integerInRange(
    input.waitMinSec,
    DEFAULT_OPTIONS.waitMinSec,
    "最短等待时间",
    1,
    3600,
  );
  const waitMaxSec = integerInRange(
    input.waitMaxSec,
    DEFAULT_OPTIONS.waitMaxSec,
    "最长等待时间",
    1,
    3600,
  );
  const maxPosts = integerInRange(
    input.maxPosts ?? input.maxScrolls,
    DEFAULT_OPTIONS.maxPosts,
    "最大展示帖子数",
    0,
    100000,
  );
  const detailAfterMinPosts = integerInRange(
    input.detailAfterMinPosts,
    DEFAULT_OPTIONS.detailAfterMinPosts,
    "进入详情前最少浏览帖子数",
    1,
    1000,
  );
  const detailAfterMaxPosts = integerInRange(
    input.detailAfterMaxPosts,
    DEFAULT_OPTIONS.detailAfterMaxPosts,
    "进入详情前最多浏览帖子数",
    1,
    1000,
  );
  const detailWaitMinSec = integerInRange(
    input.detailWaitMinSec,
    DEFAULT_OPTIONS.detailWaitMinSec,
    "详情页最短等待时间",
    1,
    3600,
  );
  const detailWaitMaxSec = integerInRange(
    input.detailWaitMaxSec,
    DEFAULT_OPTIONS.detailWaitMaxSec,
    "详情页最长等待时间",
    1,
    3600,
  );
  const commentScrollMin = integerInRange(
    input.commentScrollMin,
    DEFAULT_OPTIONS.commentScrollMin,
    "评论区最少移动次数",
    1,
    1000,
  );
  const commentScrollMax = integerInRange(
    input.commentScrollMax,
    DEFAULT_OPTIONS.commentScrollMax,
    "评论区最多移动次数",
    1,
    1000,
  );
  const returnWaitMinSec = integerInRange(
    input.returnWaitMinSec,
    DEFAULT_OPTIONS.returnWaitMinSec,
    "返回前最短停留时间",
    1,
    3600,
  );
  const returnWaitMaxSec = integerInRange(
    input.returnWaitMaxSec,
    DEFAULT_OPTIONS.returnWaitMaxSec,
    "返回前最长停留时间",
    1,
    3600,
  );

  const autoUpvoteEnabled =
    input.autoUpvoteEnabled === undefined
      ? DEFAULT_OPTIONS.autoUpvoteEnabled
      : Boolean(input.autoUpvoteEnabled);
  const autoUpvoteProbability = integerInRange(
    input.autoUpvoteProbability,
    DEFAULT_OPTIONS.autoUpvoteProbability,
    "帖子自动点赞概率",
    0,
    100,
  );
  const autoCommentUpvoteEnabled =
    input.autoCommentUpvoteEnabled === undefined
      ? DEFAULT_OPTIONS.autoCommentUpvoteEnabled
      : Boolean(input.autoCommentUpvoteEnabled);
  const autoCommentUpvoteProbability = integerInRange(
    input.autoCommentUpvoteProbability,
    DEFAULT_OPTIONS.autoCommentUpvoteProbability,
    "评论自动点赞概率",
    0,
    100,
  );

  const autoJoinEnabled =
    input.autoJoinEnabled === undefined
      ? DEFAULT_OPTIONS.autoJoinEnabled
      : Boolean(input.autoJoinEnabled);
  const autoJoinIntervalMinSec = integerInRange(
    input.autoJoinIntervalMinSec,
    DEFAULT_OPTIONS.autoJoinIntervalMinSec,
    "关注群组最短间隔",
    10,
    3600,
  );
  const autoJoinIntervalMaxSec = integerInRange(
    input.autoJoinIntervalMaxSec,
    DEFAULT_OPTIONS.autoJoinIntervalMaxSec,
    "关注群组最长间隔",
    10,
    3600,
  );
  const autoJoinMaxPerRun = integerInRange(
    input.autoJoinMaxPerRun,
    DEFAULT_OPTIONS.autoJoinMaxPerRun,
    "每次运行最多关注数",
    1,
    50,
  );

  const autoCommentEnabled =
    input.autoCommentEnabled === undefined
      ? DEFAULT_OPTIONS.autoCommentEnabled
      : Boolean(input.autoCommentEnabled);
  const autoCommentProbability = integerInRange(
    input.autoCommentProbability,
    DEFAULT_OPTIONS.autoCommentProbability,
    "自动评论概率",
    0,
    100,
  );
  const autoCommentMinIntervalSec = integerInRange(
    input.autoCommentMinIntervalSec,
    DEFAULT_OPTIONS.autoCommentMinIntervalSec,
    "评论最短间隔",
    60,
    86400,
  );
  const autoCommentMaxIntervalSec = integerInRange(
    input.autoCommentMaxIntervalSec,
    DEFAULT_OPTIONS.autoCommentMaxIntervalSec,
    "评论最长间隔",
    60,
    86400,
  );
  const autoCommentMaxPerRun = integerInRange(
    input.autoCommentMaxPerRun,
    DEFAULT_OPTIONS.autoCommentMaxPerRun,
    "每次运行最多评论数",
    1,
    20,
  );
  const autoCommentTexts = Array.isArray(input.autoCommentTexts)
    ? input.autoCommentTexts.map((t) => String(t).trim()).filter(Boolean)
    : [];

  if (waitMinSec > waitMaxSec) {
    throw new Error("最短等待时间不能大于最长等待时间");
  }
  if (detailAfterMinPosts > detailAfterMaxPosts) {
    throw new Error("进入详情前最少浏览帖子数不能大于最多浏览帖子数");
  }
  if (detailWaitMinSec > detailWaitMaxSec) {
    throw new Error("详情页最短等待时间不能大于最长等待时间");
  }
  if (commentScrollMin > commentScrollMax) {
    throw new Error("评论区最少移动次数不能大于最多移动次数");
  }
  if (returnWaitMinSec > returnWaitMaxSec) {
    throw new Error("返回前最短停留时间不能大于最长停留时间");
  }
  if (autoJoinIntervalMinSec > autoJoinIntervalMaxSec) {
    throw new Error("关注群组最短间隔不能大于最长间隔");
  }
  if (autoCommentMinIntervalSec > autoCommentMaxIntervalSec) {
    throw new Error("评论最短间隔不能大于最长间隔");
  }
  return {
    waitMinSec,
    waitMaxSec,
    waitMinMs: waitMinSec * 1000,
    waitMaxMs: waitMaxSec * 1000,
    maxPosts,
    autoStopAtBottom:
      input.autoStopAtBottom === undefined
        ? DEFAULT_OPTIONS.autoStopAtBottom
        : Boolean(input.autoStopAtBottom),
    detailLoopEnabled:
      input.detailLoopEnabled === undefined
        ? DEFAULT_OPTIONS.detailLoopEnabled
        : Boolean(input.detailLoopEnabled),
    detailAfterMinPosts,
    detailAfterMaxPosts,
    detailWaitMinSec,
    detailWaitMaxSec,
    detailWaitMinMs: detailWaitMinSec * 1000,
    detailWaitMaxMs: detailWaitMaxSec * 1000,
    commentScrollMin,
    commentScrollMax,
    returnWaitMinSec,
    returnWaitMaxSec,
    returnWaitMinMs: returnWaitMinSec * 1000,
    returnWaitMaxMs: returnWaitMaxSec * 1000,
    autoUpvoteEnabled,
    autoUpvoteProbability,
    autoCommentUpvoteEnabled,
    autoCommentUpvoteProbability,
    autoJoinEnabled,
    autoJoinIntervalMinSec,
    autoJoinIntervalMaxSec,
    autoJoinIntervalMinMs: autoJoinIntervalMinSec * 1000,
    autoJoinIntervalMaxMs: autoJoinIntervalMaxSec * 1000,
    autoJoinMaxPerRun,
    autoCommentEnabled,
    autoCommentProbability,
    autoCommentMinIntervalSec,
    autoCommentMaxIntervalSec,
    autoCommentMinIntervalMs: autoCommentMinIntervalSec * 1000,
    autoCommentMaxIntervalMs: autoCommentMaxIntervalSec * 1000,
    autoCommentMaxPerRun,
    autoCommentTexts,
  };
}

export function randomInteger(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error("随机数范围无效");
  }
  return cryptoRandomInt(min, max + 1);
}

export function publicOptions(options) {
  return {
    waitMinSec: options.waitMinSec,
    waitMaxSec: options.waitMaxSec,
    maxPosts: options.maxPosts,
    autoStopAtBottom: options.autoStopAtBottom,
    detailLoopEnabled: options.detailLoopEnabled,
    detailAfterMinPosts: options.detailAfterMinPosts,
    detailAfterMaxPosts: options.detailAfterMaxPosts,
    detailWaitMinSec: options.detailWaitMinSec,
    detailWaitMaxSec: options.detailWaitMaxSec,
    commentScrollMin: options.commentScrollMin,
    commentScrollMax: options.commentScrollMax,
    returnWaitMinSec: options.returnWaitMinSec,
    returnWaitMaxSec: options.returnWaitMaxSec,
    autoUpvoteEnabled: options.autoUpvoteEnabled,
    autoUpvoteProbability: options.autoUpvoteProbability,
    autoCommentUpvoteEnabled: options.autoCommentUpvoteEnabled,
    autoCommentUpvoteProbability: options.autoCommentUpvoteProbability,
    autoJoinEnabled: options.autoJoinEnabled,
    autoJoinIntervalMinSec: options.autoJoinIntervalMinSec,
    autoJoinIntervalMaxSec: options.autoJoinIntervalMaxSec,
    autoJoinMaxPerRun: options.autoJoinMaxPerRun,
    autoCommentEnabled: options.autoCommentEnabled,
    autoCommentProbability: options.autoCommentProbability,
    autoCommentMinIntervalSec: options.autoCommentMinIntervalSec,
    autoCommentMaxIntervalSec: options.autoCommentMaxIntervalSec,
    autoCommentMaxPerRun: options.autoCommentMaxPerRun,
    autoCommentTexts: options.autoCommentTexts,
  };
}
