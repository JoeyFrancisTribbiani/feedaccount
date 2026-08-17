const ACTIVE_STATES = new Set([
  "connecting",
  "scrolling",
  "waiting",
  "pausing",
  "paused",
  "stopping",
]);

const FALLBACK_OPTIONS = Object.freeze({
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

const OPTIONS_STORAGE_KEY = "reddit-flow-options-v3";
const LEGACY_OPTIONS_STORAGE_KEY = "reddit-flow-options-v2";

const state = {
  config: null,
  profiles: [],
  jobs: [],
  tiktokJobs: [],
  scheduler: null,
  stats: null,
  history: [],
  databaseLogs: [],
  activeDataTab: "history",
  selected: new Set(),
  toastTimer: null,
  dataRefreshTimer: null,
  settingsSaveTimer: null,
  pendingJobActions: new Set(),
  pendingManualUpvotes: new Set(),
  pendingManualCommentUpvotes: new Set(),
};

const elements = {
  apiStatus: document.querySelector("#api-status"),
  dbStatus: document.querySelector("#db-status"),
  streamStatus: document.querySelector("#stream-status"),
  apiEndpoint: document.querySelector("#api-endpoint"),
  databaseFile: document.querySelector("#database-file"),
  targetUrl: document.querySelector("#target-url"),
  profilesLoading: document.querySelector("#profiles-loading"),
  profilesGrid: document.querySelector("#profiles-grid"),
  jobsEmpty: document.querySelector("#jobs-empty"),
  jobsList: document.querySelector("#jobs-list"),
  activityList: document.querySelector("#activity-list"),
  selectionCount: document.querySelector("#selection-count"),
  startSelected: document.querySelector("#start-selected"),
  stopSelected: document.querySelector("#stop-selected"),
  stopAll: document.querySelector("#stop-all"),
  refreshProfiles: document.querySelector("#refresh-profiles"),
  selectAll: document.querySelector("#select-all"),
  resetOptions: document.querySelector("#reset-options"),
  optionsForm: document.querySelector("#options-form"),
  waitMin: document.querySelector("#wait-min"),
  waitMax: document.querySelector("#wait-max"),
  maxPosts: document.querySelector("#max-posts"),
  stopAtBottom: document.querySelector("#stop-at-bottom"),
  detailLoopEnabled: document.querySelector("#detail-loop-enabled"),
  detailAfterMinPosts: document.querySelector("#detail-after-min-posts"),
  detailAfterMaxPosts: document.querySelector("#detail-after-max-posts"),
  detailWaitMin: document.querySelector("#detail-wait-min"),
  detailWaitMax: document.querySelector("#detail-wait-max"),
  commentScrollMin: document.querySelector("#comment-scroll-min"),
  commentScrollMax: document.querySelector("#comment-scroll-max"),
  returnWaitMin: document.querySelector("#return-wait-min"),
  returnWaitMax: document.querySelector("#return-wait-max"),
  autoUpvoteEnabled: document.querySelector("#auto-upvote-enabled"),
  autoUpvoteProbability: document.querySelector("#auto-upvote-probability"),
  autoCommentUpvoteEnabled: document.querySelector("#auto-comment-upvote-enabled"),
  autoCommentUpvoteProbability: document.querySelector("#auto-comment-upvote-probability"),
  autoJoinEnabled: document.querySelector("#auto-join-enabled"),
  autoJoinIntervalMin: document.querySelector("#auto-join-interval-min"),
  autoJoinIntervalMax: document.querySelector("#auto-join-interval-max"),
  autoJoinMaxPerRun: document.querySelector("#auto-join-max-per-run"),
  joinTargetsText: document.querySelector("#join-targets-text"),
  joinTargetsSave: document.querySelector("#join-targets-save"),
  joinTargetsStatus: document.querySelector("#join-targets-status"),
  autoCommentEnabled: document.querySelector("#auto-comment-enabled"),
  autoCommentProbability: document.querySelector("#auto-comment-probability"),
  autoCommentMinInterval: document.querySelector("#auto-comment-min-interval"),
  autoCommentMaxInterval: document.querySelector("#auto-comment-max-interval"),
  autoCommentMaxPerRun: document.querySelector("#auto-comment-max-per-run"),
  autoCommentTexts: document.querySelector("#auto-comment-texts"),
  aiCommentUse: document.querySelector("#ai-comment-use"),
  aiCommentBaseUrl: document.querySelector("#ai-comment-base-url"),
  aiCommentApiKey: document.querySelector("#ai-comment-api-key"),
  aiCommentModel: document.querySelector("#ai-comment-model"),
  aiCommentPrompt: document.querySelector("#ai-comment-prompt"),
  aiCommentMaxTokens: document.querySelector("#ai-comment-max-tokens"),
  aiCommentTemperature: document.querySelector("#ai-comment-temperature"),
  aiCommentSave: document.querySelector("#ai-comment-save"),
  aiCommentStatus: document.querySelector("#ai-comment-status"),
  optionsPanelBody: document.querySelector("#options-panel-body"),
  optionsPanelToggle: document.querySelector("#options-panel-toggle"),
  optionsCollapseIcon: document.querySelector("#options-collapse-icon"),
  optionsScopeBadge: document.querySelector("#options-scope-badge"),
  optionsScopeSelect: document.querySelector("#options-scope-select"),
  optionsProfileSelect: document.querySelector("#options-profile-select"),
  optionsScopeHint: document.querySelector("#options-scope-hint"),
  metricProfiles: document.querySelector("#metric-profiles"),
  metricActive: document.querySelector("#metric-active"),
  metricPosts: document.querySelector("#metric-posts"),
  metricDetailVisits: document.querySelector("#metric-detail-visits"),
  dbRuns: document.querySelector("#db-runs"),
  dbCompleted: document.querySelector("#db-completed"),
  dbPosts: document.querySelector("#db-posts"),
  dbDetailVisits: document.querySelector("#db-detail-visits"),
  dbEvents: document.querySelector("#db-events"),
  refreshData: document.querySelector("#refresh-data"),
  clearLogs: document.querySelector("#clear-logs"),
  exportHistory: document.querySelector("#export-history"),
  exportLogs: document.querySelector("#export-logs"),
  dataProfileFilter: document.querySelector("#data-profile-filter"),
  historyStatusFilter: document.querySelector("#history-status-filter"),
  logLevelFilter: document.querySelector("#log-level-filter"),
  statusFilterWrap: document.querySelector("#status-filter-wrap"),
  levelFilterWrap: document.querySelector("#level-filter-wrap"),
  historyView: document.querySelector("#history-view"),
  logsView: document.querySelector("#logs-view"),
  historyBody: document.querySelector("#history-body"),
  historyEmpty: document.querySelector("#history-empty"),
  databaseLogList: document.querySelector("#database-log-list"),
  logsEmpty: document.querySelector("#logs-empty"),
  runDialog: document.querySelector("#run-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogContent: document.querySelector("#dialog-content"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(payload.errors)
      ? payload.errors.map((item) => item.error).filter(Boolean).join("；")
      : "";
    throw new Error(payload.error || details || "请求执行失败");
  }
  return payload;
}

function setApiStatus(online, message) {
  elements.apiStatus.classList.remove("status-loading", "status-online", "status-offline");
  elements.apiStatus.classList.add(online ? "status-online" : "status-offline");
  elements.apiStatus.innerHTML = `<span class="status-dot"></span>${escapeHtml(message)}`;
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusLabel(status, fallback = "") {
  const labels = {
    connecting: "正在连接",
    scrolling: "定位下一帖",
    waiting: "正在阅读",
    pausing: "正在暂停",
    paused: "已暂停",
    stopping: "正在停止",
    stopped: "已停止",
    completed: "已完成",
    interrupted: "意外中断",
    error: "运行出错",
  };
  return labels[status] || fallback || status;
}

function workflowPhaseLabel(job) {
  if (job.workflowPhaseText) return job.workflowPhaseText;
  const labels = {
    connecting: "正在连接",
    feed: "浏览 Feed",
    feed_align: "定位 Feed 帖子",
    feed_wait: "阅读 Feed 帖子",
    opening_detail: "打开帖子详情",
    detail_wait: "阅读帖子详情",
    locating_comments: "定位评论区",
    comment_scrolling: "浏览评论区",
    return_wait: "返回前停留",
    returning_feed: "返回 Feed",
    feed_restore: "恢复 Feed 位置",
  };
  return labels[job.workflowPhase] || statusLabel(job.status, job.statusText);
}

function shortId(id) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function getActiveJobs() {
  return state.jobs.filter((job) => ACTIVE_STATES.has(job.status));
}

function jobForProfile(profileId) {
  return state.jobs.find((job) => job.profileId === profileId);
}

function renderMetrics() {
  const active = getActiveJobs();
  const posts = state.jobs.reduce((sum, job) => sum + Number(job.postCount || 0), 0);
  const detailVisits = state.jobs.reduce(
    (sum, job) => sum + Number(job.detailVisitCount || 0),
    0,
  );
  elements.metricProfiles.textContent = state.profiles.length || "0";
  elements.metricActive.textContent = active.length;
  elements.metricPosts.textContent = formatNumber(posts);
  elements.metricDetailVisits.textContent = formatNumber(detailVisits);
  elements.stopAll.disabled = active.length === 0;
}

function renderProfiles() {
  elements.profilesLoading.classList.add("hidden");
  if (!state.profiles.length) {
    elements.profilesGrid.innerHTML = `
      <div class="empty-state compact" style="grid-column: 1 / -1">
        没有发现可用实例。请确认 BitBrowser 已登录并开启 Local API。
      </div>`;
    updateSelectionUi();
    renderProfileFilter();
    return;
  }

  elements.profilesGrid.innerHTML = state.profiles
    .map((profile) => {
      const selected = state.selected.has(profile.id);
      const job = jobForProfile(profile.id);
      const active = job && ACTIVE_STATES.has(job.status);
      const stateClass = active ? "active" : profile.running ? "open" : "";
      const stateText = active
        ? ["paused", "pausing", "stopping"].includes(job.status)
          ? statusLabel(job.status, job.statusText)
          : workflowPhaseLabel(job)
        : profile.running
          ? "窗口已打开"
          : "待启动";
      return `
        <button
          class="profile-card ${selected ? "selected" : ""}"
          type="button"
          data-profile-id="${escapeHtml(profile.id)}"
          aria-pressed="${selected}"
        >
          <span class="profile-check" aria-hidden="true"></span>
          <span class="profile-main">
            <span class="profile-title">
              <span class="sequence">#${escapeHtml(profile.seq ?? "—")}</span>
              <strong>${escapeHtml(profile.name)}</strong>
            </span>
            <span class="profile-meta">
              <span title="${escapeHtml(profile.id)}">ID ${escapeHtml(shortId(profile.id))}</span>
              ${profile.pid ? `<span>PID ${escapeHtml(profile.pid)}</span>` : ""}
            </span>
          </span>
          <span class="profile-state ${stateClass}">${escapeHtml(stateText)}</span>
        </button>`;
    })
    .join("");

  for (const card of elements.profilesGrid.querySelectorAll("[data-profile-id]")) {
    card.addEventListener("click", () => {
      const profileId = card.dataset.profileId;
      if (state.selected.has(profileId)) state.selected.delete(profileId);
      else state.selected.add(profileId);
      renderProfiles();
    });
  }
  updateSelectionUi();
  renderProfileFilter();
}

function updateSelectionUi() {
  const selectedCount = state.selected.size;
  const startableCount = [...state.selected].filter((profileId) => {
    const job = jobForProfile(profileId);
    return !job || !ACTIVE_STATES.has(job.status);
  }).length;
  elements.selectionCount.textContent = selectedCount
    ? startableCount === selectedCount
      ? `已选择 ${selectedCount} 个实例`
      : `已选择 ${selectedCount} 个实例，其中 ${startableCount} 个可启动`
    : "尚未选择实例";
  elements.startSelected.disabled = startableCount === 0;
  const selectedHasActive = [...state.selected].some((profileId) => {
    const job = jobForProfile(profileId);
    return job && ACTIVE_STATES.has(job.status);
  });
  elements.stopSelected.disabled = !selectedHasActive;
  elements.selectAll.textContent =
    state.profiles.length > 0 && selectedCount === state.profiles.length ? "取消全选" : "全选";
}

function remainingText(job) {
  if (job.alignmentPending) {
    if (job.nextActionAt) {
      const remaining = Math.max(0, new Date(job.nextActionAt).getTime() - Date.now());
      return `<strong data-countdown="${escapeHtml(job.nextActionAt)}">${(remaining / 1000).toFixed(1)} 秒</strong> 后继续校正`;
    }
    return "正在验证帖子是否完整入镜";
  }
  if (job.status === "waiting" && job.nextActionAt) {
    const remaining = Math.max(0, new Date(job.nextActionAt).getTime() - Date.now());
    const nextCopy = {
      detail_wait: "后开始查看评论",
      return_wait: "后返回 Feed",
      feed_wait: "后继续浏览 Feed",
      comment_scrolling: "后继续浏览评论",
    }[job.workflowPhase] || "后继续下一步";
    return `<strong data-countdown="${escapeHtml(job.nextActionAt)}">${(remaining / 1000).toFixed(1)} 秒</strong> ${nextCopy}`;
  }
  if (job.workflowPhase === "opening_detail") return "正在打开普通帖子详情";
  if (job.workflowPhase === "locating_comments") return "正在定位评论区";
  if (job.workflowPhase === "comment_scrolling") {
    return `评论区第 ${formatNumber(job.commentScrollProgress)}/${formatNumber(job.commentScrollTarget)} 次移动`;
  }
  if (job.workflowPhase === "returning_feed") return "正在返回 Feed";
  if (job.workflowPhase === "feed_restore") return "正在恢复上次 Feed 阅读位置";
  if (job.status === "scrolling") return "正在分析帖子并定位";
  if (job.status === "connecting") return "正在连接 Reddit 首页";
  if (job.status === "pausing") return "当前浏览动作完成后暂停";
  if (job.status === "paused") return "任务连接保持中";
  if (job.status === "error") return escapeHtml(job.error || "任务出现错误");
  return escapeHtml(job.statusText);
}

function isOrdinaryCurrentPost(post) {
  return Boolean(post?.postId) &&
    post.isPromoted !== true &&
    post.promoted !== true &&
    post.ineligibleReason !== "promoted";
}

function canManuallyUpvote(job) {
  return job?.status === "waiting" &&
    job.workflowPhase === "feed_wait" &&
    isOrdinaryCurrentPost(job.currentPost) &&
    job.manualUpvoteAvailable !== false &&
    job.manualActionPending !== true &&
    job.manualCommentActionPending !== true;
}

function isCommentReadingWait(job) {
  return ["waiting", "paused"].includes(job?.status) &&
    ["comment_scrolling", "return_wait"].includes(job.workflowPhase);
}

function canManuallyUpvoteCurrentComment(job) {
  return isCommentReadingWait(job) &&
    Boolean(job.currentComment?.commentId) &&
    job.manualCommentUpvoteAvailable === true &&
    job.manualCommentActionPending !== true &&
    job.manualActionPending !== true;
}

function manualCommentUpvoteControlHtml(
  job,
  actionPending,
  manualCommentUpvotePending,
) {
  if (!isCommentReadingWait(job) || !job.currentComment?.commentId) return "";

  const manualCommentUpvoteEnabled =
    canManuallyUpvoteCurrentComment(job) && !actionPending;
  const commentUpvoteDisabled = manualCommentUpvoteEnabled ? "" : " disabled";
  const commentUpvoteTitle = manualCommentUpvotePending
    ? "正在确认当前评论的点赞状态"
    : job.manualCommentUpvoteState === "upvoted"
      ? "当前评论已点赞"
      : job.manualCommentUpvoteState === "attempted-unknown"
        ? job.manualCommentUpvoteBlockedReason ||
          "此前结果未确认，为避免取消点赞已禁止重试"
        : job.manualCommentUpvoteAvailable === false
          ? job.manualCommentUpvoteBlockedReason || "当前评论暂不可点赞"
          : "确认后仅点赞当前显示的这一条评论";
  const commentUpvoteLabel = manualCommentUpvotePending
    ? "点赞中…"
    : job.manualCommentUpvoteState === "upvoted"
      ? "已点赞"
      : "确认赞评论";
  return `<button class="manual-comment-upvote-job${manualCommentUpvotePending ? " pending" : ""}" type="button" data-job-action="manual-comment-upvote" data-job-id="${escapeHtml(job.profileId)}" data-comment-id="${escapeHtml(job.currentComment.commentId)}" title="${escapeHtml(commentUpvoteTitle)}" aria-busy="${manualCommentUpvotePending}"${commentUpvoteDisabled}>${commentUpvoteLabel}</button>`;
}

function jobControlHtml(job) {
  if (!ACTIVE_STATES.has(job.status)) return "";
  if (job.status === "stopping") return '<span class="job-control-state">正在停止…</span>';
  const manualUpvotePending =
    state.pendingManualUpvotes.has(job.profileId) || job.manualActionPending === true;
  const manualCommentUpvotePending =
    state.pendingManualCommentUpvotes.has(job.profileId) ||
    job.manualCommentActionPending === true;
  const actionPending =
    state.pendingJobActions.has(job.profileId) ||
    manualUpvotePending ||
    manualCommentUpvotePending;
  const disabled = actionPending ? " disabled" : "";
  const stopDisabled = state.pendingJobActions.has(job.profileId) ? " disabled" : "";
  const controls = [];
  if (job.status === "waiting") {
    controls.push(
      `<button class="trigger-job" type="button" data-job-action="trigger" data-job-id="${escapeHtml(job.profileId)}"${disabled}>立即继续</button>`,
    );
    if (job.workflowPhase === "feed_wait") {
      const manualUpvoteEnabled = canManuallyUpvote(job) && !actionPending;
      const upvoteDisabled = manualUpvoteEnabled ? "" : " disabled";
      const upvoteTitle = isOrdinaryCurrentPost(job.currentPost)
        ? manualUpvotePending
          ? "正在确认当前帖的点赞状态"
          : job.manualUpvoteState === "upvoted"
            ? "当前帖子已点赞"
            : job.manualUpvoteState === "attempted-unknown"
              ? job.manualUpvoteBlockedReason || "此前结果未确认，为避免取消点赞已禁止重试"
          : job.manualUpvoteAvailable === false
            ? "当前帖子暂不可点赞"
            : "确认后仅点赞当前这一帖"
        : "当前不是可点赞的普通帖子";
      const upvoteLabel = manualUpvotePending
        ? "点赞中…"
        : job.manualUpvoteState === "upvoted"
          ? "已点赞"
          : "确认点赞";
      controls.push(
        `<button class="manual-upvote-job${manualUpvotePending ? " pending" : ""}" type="button" data-job-action="manual-upvote" data-job-id="${escapeHtml(job.profileId)}" data-post-id="${escapeHtml(job.currentPost?.postId || "")}" title="${escapeHtml(upvoteTitle)}" aria-busy="${manualUpvotePending}"${upvoteDisabled}>${upvoteLabel}</button>`,
      );
    }
    const commentUpvoteControl = manualCommentUpvoteControlHtml(
      job,
      actionPending,
      manualCommentUpvotePending,
    );
    if (commentUpvoteControl) controls.push(commentUpvoteControl);
  }
  if (["connecting", "scrolling", "waiting"].includes(job.status)) {
    controls.push(
      `<button class="pause-job" type="button" data-job-action="pause" data-job-id="${escapeHtml(job.profileId)}"${disabled}>暂停</button>`,
    );
  }
  if (job.status === "paused") {
    controls.push(
      `<button class="resume-job" type="button" data-job-action="resume" data-job-id="${escapeHtml(job.profileId)}"${disabled}>继续</button>`,
    );
    const commentUpvoteControl = manualCommentUpvoteControlHtml(
      job,
      actionPending,
      manualCommentUpvotePending,
    );
    if (commentUpvoteControl) controls.push(commentUpvoteControl);
  }
  controls.push(
    `<button class="stop-job" type="button" data-job-action="stop" data-job-id="${escapeHtml(job.profileId)}"${stopDisabled}>停止</button>`,
  );
  return `<span class="job-controls">${controls.join("")}</span>`;
}

function renderJobs() {
  const sorted = [...state.jobs].sort((left, right) => {
    const leftActive = ACTIVE_STATES.has(left.status) ? 1 : 0;
    const rightActive = ACTIVE_STATES.has(right.status) ? 1 : 0;
    return rightActive - leftActive || new Date(right.updatedAt) - new Date(left.updatedAt);
  });

  elements.jobsEmpty.classList.toggle("hidden", sorted.length > 0);
  elements.jobsList.innerHTML = sorted
    .map((job) => {
      const post = job.currentPost || null;
      const detailPhases = new Set([
        "opening_detail",
        "detail_wait",
        "locating_comments",
        "comment_scrolling",
        "return_wait",
        "returning_feed",
      ]);
      const inDetail = detailPhases.has(job.workflowPhase);
      const displayPost = inDetail && job.currentDetailPost ? job.currentDetailPost : post;
      const visibleRatio = post
        ? Math.max(0, Math.min(1, Number(post.visibleRatio || 0)))
        : 0;
      const visibility = Math.round(visibleRatio * 100);
      const commentPhase = ["locating_comments", "comment_scrolling", "return_wait"].includes(
        job.workflowPhase,
      );
      const progressCurrent = commentPhase
        ? Number(job.commentScrollProgress || 0)
        : Number(job.feedPostsSinceDetail || 0);
      const progressTarget = commentPhase
        ? Number(job.commentScrollTarget || 0)
        : Number(job.feedPostsTarget || 0);
      const progressPercent = progressTarget > 0
        ? Math.max(0, Math.min(100, Math.round((progressCurrent / progressTarget) * 100)))
        : visibility;
      const cycleProgress = job.workflowMode === "feed_detail_readonly"
        ? `${formatNumber(job.feedPostsSinceDetail)}/${job.feedPostsTarget ? formatNumber(job.feedPostsTarget) : "…"}`
        : "仅 Feed";
      const postTitle = displayPost
        ? displayPost.title || "无标题帖子"
        : "正在识别当前帖子";
      const terminalStatus = ["paused", "pausing", "stopping", "stopped", "completed", "error", "interrupted"].includes(job.status);
      const badgeText = job.alignmentPending
        ? "正在校正"
        : terminalStatus
          ? statusLabel(job.status, job.statusText)
          : workflowPhaseLabel(job);
      return `
        <article class="job-card">
          <div class="job-topline">
            <div class="job-title">
              <strong>#${escapeHtml(job.seq ?? "—")} · ${escapeHtml(job.name || "未命名实例")}</strong>
              <small>${escapeHtml(job.pageTitle || "Reddit 首页")} · 数据库任务 #${escapeHtml(job.runId ?? "—")}</small>
              <span class="job-post-title" title="${escapeHtml(postTitle)}">${escapeHtml(postTitle)}</span>
            </div>
            <span class="job-badge ${escapeHtml(job.status)}">${escapeHtml(badgeText)}</span>
          </div>
          <div class="job-stats">
            <div class="job-stat"><span>已展示帖子</span><strong>${formatNumber(job.postCount)}</strong></div>
            <div class="job-stat"><span>本轮 Feed</span><strong>${escapeHtml(cycleProgress)}</strong></div>
            <div class="job-stat"><span>查看详情</span><strong>${formatNumber(job.detailVisitCount)}</strong></div>
            <div class="job-stat"><span>当前阶段</span><strong>${escapeHtml(workflowPhaseLabel(job))}</strong></div>
          </div>
          ${(Number(job.autoUpvoteCount) > 0 || Number(job.autoCommentUpvoteCount) > 0 || Number(job.autoJoinCount) > 0 || Number(job.autoCommentCount) > 0) ? `<div class="job-stats">
            <div class="job-stat"><span>自动点赞</span><strong>${formatNumber(job.autoUpvoteCount)} 帖</strong></div>
            <div class="job-stat"><span>自动赞评</span><strong>${formatNumber(job.autoCommentUpvoteCount)} 条</strong></div>
            ${Number(job.autoCommentCount) > 0 ? `<div class="job-stat"><span>自动评论</span><strong>${formatNumber(job.autoCommentCount)} 条</strong></div>` : ""}
            ${Number(job.autoJoinCount) > 0 ? `<div class="job-stat"><span>自动关注</span><strong>${formatNumber(job.autoJoinCount)} 个</strong></div>` : ""}
            <div class="job-stat"><span>已锁帖</span><strong>${formatNumber(job.upvotedPostCount)}</strong></div>
          </div>` : ""}
          <div class="progress-track" title="${escapeHtml(commentPhase ? "评论浏览进度" : "本轮 Feed 进度")} ${progressPercent}%"><i style="width: ${progressPercent}%"></i></div>
          <div class="job-footer">
            <span class="next-action">${remainingText(job)}</span>
            ${jobControlHtml(job)}
          </div>
        </article>`;
    })
    .join("");

  for (const button of elements.jobsList.querySelectorAll("[data-job-action]")) {
    button.addEventListener("click", () => {
      if (button.dataset.jobAction === "manual-upvote") {
        void manuallyUpvoteCurrentPost(button.dataset.jobId, button.dataset.postId);
        return;
      }
      if (button.dataset.jobAction === "manual-comment-upvote") {
        void manuallyUpvoteCurrentComment(button.dataset.jobId, button.dataset.commentId);
        return;
      }
      void controlJob(button.dataset.jobId, button.dataset.jobAction);
    });
  }
  renderActivity();
  renderMetrics();
  updateSelectionUi();
}

function renderActivity() {
  const entries = state.jobs
    .flatMap((job) =>
      job.logs.map((log) => ({ ...log, seq: job.seq, name: job.name || "未命名实例" })),
    )
    .sort((left, right) => new Date(right.time) - new Date(left.time))
    .slice(0, 18);

  elements.activityList.innerHTML = entries.length
    ? entries
        .map((entry) => `
          <li class="activity-item">
            <span class="activity-time">${new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false })}</span>
            <span class="activity-copy"><strong>#${escapeHtml(entry.seq ?? "—")}</strong> ${escapeHtml(entry.message)}</span>
          </li>`)
        .join("")
    : '<li class="muted-activity">任务启动后会在这里显示记录。</li>';
}

function readOptions({ persistLocal = true } = {}) {
  const options = {
    waitMinSec: Number(elements.waitMin.value),
    waitMaxSec: Number(elements.waitMax.value),
    maxPosts: Number(elements.maxPosts.value),
    autoStopAtBottom: elements.stopAtBottom.checked,
    detailLoopEnabled: elements.detailLoopEnabled.checked,
    detailAfterMinPosts: Number(elements.detailAfterMinPosts.value),
    detailAfterMaxPosts: Number(elements.detailAfterMaxPosts.value),
    detailWaitMinSec: Number(elements.detailWaitMin.value),
    detailWaitMaxSec: Number(elements.detailWaitMax.value),
    commentScrollMin: Number(elements.commentScrollMin.value),
    commentScrollMax: Number(elements.commentScrollMax.value),
    returnWaitMinSec: Number(elements.returnWaitMin.value),
    returnWaitMaxSec: Number(elements.returnWaitMax.value),
    autoUpvoteEnabled: elements.autoUpvoteEnabled.checked,
    autoUpvoteProbability: Number(elements.autoUpvoteProbability.value),
    autoCommentUpvoteEnabled: elements.autoCommentUpvoteEnabled.checked,
    autoCommentUpvoteProbability: Number(elements.autoCommentUpvoteProbability.value),
    autoJoinEnabled: elements.autoJoinEnabled.checked,
    autoJoinIntervalMinSec: Number(elements.autoJoinIntervalMin.value),
    autoJoinIntervalMaxSec: Number(elements.autoJoinIntervalMax.value),
    autoJoinMaxPerRun: Number(elements.autoJoinMaxPerRun.value),
    autoCommentEnabled: elements.autoCommentEnabled.checked,
    autoCommentProbability: Number(elements.autoCommentProbability.value),
    autoCommentMinIntervalSec: Number(elements.autoCommentMinInterval.value),
    autoCommentMaxIntervalSec: Number(elements.autoCommentMaxInterval.value),
    autoCommentMaxPerRun: Number(elements.autoCommentMaxPerRun.value),
    autoCommentTexts: (elements.autoCommentTexts.value || "").split("\n").map((t) => t.trim()).filter(Boolean),
  };
  if (!elements.optionsForm.reportValidity()) throw new Error("请检查任务参数");
  if (options.waitMinSec > options.waitMaxSec) throw new Error("最短等待不能大于最长等待");
  if (options.detailAfterMinPosts > options.detailAfterMaxPosts) {
    throw new Error("进入详情前最少浏览帖子数不能大于最多浏览帖子数");
  }
  if (options.detailWaitMinSec > options.detailWaitMaxSec) {
    throw new Error("详情页最短等待不能大于最长等待");
  }
  if (options.commentScrollMin > options.commentScrollMax) {
    throw new Error("评论区最少移动次数不能大于最多移动次数");
  }
  if (options.returnWaitMinSec > options.returnWaitMaxSec) {
    throw new Error("返回前最短停留不能大于最长停留");
  }
  if (options.autoJoinIntervalMinSec > options.autoJoinIntervalMaxSec) {
    throw new Error("关注群组最短间隔不能大于最长间隔");
  }
  if (options.autoCommentMinIntervalSec > options.autoCommentMaxIntervalSec) {
    throw new Error("评论最短间隔不能大于最长间隔");
  }
  if (persistLocal) localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options));
  return options;
}

function applyOptions(options = {}) {
  elements.waitMin.value = options.waitMinSec ?? FALLBACK_OPTIONS.waitMinSec;
  elements.waitMax.value = options.waitMaxSec ?? FALLBACK_OPTIONS.waitMaxSec;
  elements.maxPosts.value = options.maxPosts ?? options.maxScrolls ?? FALLBACK_OPTIONS.maxPosts;
  elements.stopAtBottom.checked = Boolean(
    options.autoStopAtBottom ?? FALLBACK_OPTIONS.autoStopAtBottom,
  );
  elements.detailLoopEnabled.checked = Boolean(
    options.detailLoopEnabled ?? FALLBACK_OPTIONS.detailLoopEnabled,
  );
  elements.detailAfterMinPosts.value =
    options.detailAfterMinPosts ?? FALLBACK_OPTIONS.detailAfterMinPosts;
  elements.detailAfterMaxPosts.value =
    options.detailAfterMaxPosts ?? FALLBACK_OPTIONS.detailAfterMaxPosts;
  elements.detailWaitMin.value = options.detailWaitMinSec ?? FALLBACK_OPTIONS.detailWaitMinSec;
  elements.detailWaitMax.value = options.detailWaitMaxSec ?? FALLBACK_OPTIONS.detailWaitMaxSec;
  elements.commentScrollMin.value = options.commentScrollMin ?? FALLBACK_OPTIONS.commentScrollMin;
  elements.commentScrollMax.value = options.commentScrollMax ?? FALLBACK_OPTIONS.commentScrollMax;
  elements.returnWaitMin.value = options.returnWaitMinSec ?? FALLBACK_OPTIONS.returnWaitMinSec;
  elements.returnWaitMax.value = options.returnWaitMaxSec ?? FALLBACK_OPTIONS.returnWaitMaxSec;
  elements.autoUpvoteEnabled.checked = Boolean(
    options.autoUpvoteEnabled ?? FALLBACK_OPTIONS.autoUpvoteEnabled,
  );
  elements.autoUpvoteProbability.value =
    options.autoUpvoteProbability ?? FALLBACK_OPTIONS.autoUpvoteProbability;
  elements.autoCommentUpvoteEnabled.checked = Boolean(
    options.autoCommentUpvoteEnabled ?? FALLBACK_OPTIONS.autoCommentUpvoteEnabled,
  );
  elements.autoCommentUpvoteProbability.value =
    options.autoCommentUpvoteProbability ?? FALLBACK_OPTIONS.autoCommentUpvoteProbability;
  elements.autoJoinEnabled.checked = Boolean(
    options.autoJoinEnabled ?? FALLBACK_OPTIONS.autoJoinEnabled,
  );
  elements.autoJoinIntervalMin.value =
    options.autoJoinIntervalMinSec ?? FALLBACK_OPTIONS.autoJoinIntervalMinSec;
  elements.autoJoinIntervalMax.value =
    options.autoJoinIntervalMaxSec ?? FALLBACK_OPTIONS.autoJoinIntervalMaxSec;
  elements.autoJoinMaxPerRun.value =
    options.autoJoinMaxPerRun ?? FALLBACK_OPTIONS.autoJoinMaxPerRun;
  elements.autoCommentEnabled.checked = Boolean(
    options.autoCommentEnabled ?? FALLBACK_OPTIONS.autoCommentEnabled,
  );
  elements.autoCommentProbability.value =
    options.autoCommentProbability ?? FALLBACK_OPTIONS.autoCommentProbability;
  elements.autoCommentMinInterval.value =
    options.autoCommentMinIntervalSec ?? FALLBACK_OPTIONS.autoCommentMinIntervalSec;
  elements.autoCommentMaxInterval.value =
    options.autoCommentMaxIntervalSec ?? FALLBACK_OPTIONS.autoCommentMaxIntervalSec;
  elements.autoCommentMaxPerRun.value =
    options.autoCommentMaxPerRun ?? FALLBACK_OPTIONS.autoCommentMaxPerRun;
  elements.autoCommentTexts.value = Array.isArray(options.autoCommentTexts)
    ? options.autoCommentTexts.join("\n")
    : "";
}

// --- AI 评论配置 ---
async function loadAiCommentConfig() {
  try {
    const res = await request("/api/settings/ai-comment");
    const cfg = res.config || {};
    if (elements.aiCommentUse) elements.aiCommentUse.checked = Boolean(cfg.useAI);
    if (elements.aiCommentBaseUrl) elements.aiCommentBaseUrl.value = cfg.baseURL || "https://api.openai.com/v1";
    if (elements.aiCommentApiKey) elements.aiCommentApiKey.value = cfg.apiKey || "";
    if (elements.aiCommentModel) elements.aiCommentModel.value = cfg.model || "gpt-4o-mini";
    if (elements.aiCommentPrompt) elements.aiCommentPrompt.value = cfg.systemPrompt || "";
    if (elements.aiCommentMaxTokens) elements.aiCommentMaxTokens.value = cfg.maxTokens || 200;
    if (elements.aiCommentTemperature) elements.aiCommentTemperature.value = cfg.temperature ?? 0.8;
  } catch { /* ignore */ }
}

if (elements.aiCommentSave) {
  elements.aiCommentSave.addEventListener("click", async () => {
    try {
      const config = {
        useAI: elements.aiCommentUse?.checked ?? false,
        baseURL: elements.aiCommentBaseUrl?.value.trim() || "https://api.openai.com/v1",
        apiKey: elements.aiCommentApiKey?.value.trim() || "",
        model: elements.aiCommentModel?.value.trim() || "gpt-4o-mini",
        systemPrompt: elements.aiCommentPrompt?.value.trim() || "",
        maxTokens: Number(elements.aiCommentMaxTokens?.value) || 200,
        temperature: Number(elements.aiCommentTemperature?.value) || 0.8,
      };
      await request("/api/settings/ai-comment", { method: "PUT", body: JSON.stringify({ config }) });
      if (elements.aiCommentStatus) elements.aiCommentStatus.textContent = "AI 配置已保存";
      showToast("AI 评论配置已保存");
    } catch (e) {
      if (elements.aiCommentStatus) elements.aiCommentStatus.textContent = `保存失败：${e.message}`;
      showToast(e.message, true);
    }
  });
}

// --- 任务参数面板：折叠 + 作用域切换 ---
const optionsScopeState = { scope: "global", profileId: null };

function toggleOptionsPanel() {
  if (!elements.optionsPanelBody) return;
  const collapsed = elements.optionsPanelBody.classList.toggle("collapsed");
  if (elements.optionsCollapseIcon) {
    elements.optionsCollapseIcon.textContent = collapsed ? "▶" : "▼";
  }
}

function populateOptionsProfileSelect() {
  if (!elements.optionsProfileSelect) return;
  const profiles = (state.profiles || []).filter(p => p.seq != null).sort((a, b) => a.seq - b.seq);
  elements.optionsProfileSelect.innerHTML = profiles.map(p =>
    `<option value="${escapeHtml(p.id)}">#${escapeHtml(p.seq)} ${escapeHtml(p.name)}</option>`
  ).join("");
}

async function loadOptionsForScope() {
  if (optionsScopeState.scope === "global") {
    if (elements.optionsProfileSelect) elements.optionsProfileSelect.classList.add("hidden");
    if (elements.optionsScopeBadge) { elements.optionsScopeBadge.textContent = "全局"; elements.optionsScopeBadge.classList.remove("profile-scope"); }
    if (elements.optionsScopeHint) elements.optionsScopeHint.textContent = "所有未单独配置的实例将使用这些参数";
    try {
      const res = await request("/api/config");
      applyOptions(res.savedOptions || res.defaults || FALLBACK_OPTIONS);
    } catch { /* ignore */ }
  } else {
    if (elements.optionsProfileSelect) elements.optionsProfileSelect.classList.remove("hidden");
    const profileId = elements.optionsProfileSelect?.value;
    if (!profileId) return;
    optionsScopeState.profileId = profileId;
    const profileName = elements.optionsProfileSelect.selectedOptions[0]?.textContent || profileId;
    if (elements.optionsScopeBadge) { elements.optionsScopeBadge.textContent = profileName; elements.optionsScopeBadge.classList.add("profile-scope"); }
    try {
      const res = await request(`/api/settings/profile/${encodeURIComponent(profileId)}`);
      if (res.options) {
        applyOptions(res.options);
        if (elements.optionsScopeHint) elements.optionsScopeHint.textContent = res.hasProfileOverride ? "已加载此实例的独立参数" : "此实例尚未配置独立参数，当前显示全局默认值";
      } else {
        const cfg = await request("/api/config");
        applyOptions(cfg.defaults || FALLBACK_OPTIONS);
        if (elements.optionsScopeHint) elements.optionsScopeHint.textContent = "此实例尚未配置独立参数，当前显示全局默认值";
      }
    } catch { /* ignore */ }
  }
}

if (elements.optionsPanelToggle) {
  elements.optionsPanelToggle.addEventListener("click", (e) => {
    if (e.target.closest("button") && !e.target.closest("#options-collapse-icon") && e.target.id !== "options-panel-toggle") return;
    toggleOptionsPanel();
  });
}
if (elements.optionsScopeSelect) {
  elements.optionsScopeSelect.addEventListener("change", () => {
    optionsScopeState.scope = elements.optionsScopeSelect.value;
    loadOptionsForScope();
  });
}
if (elements.optionsProfileSelect) {
  elements.optionsProfileSelect.addEventListener("change", loadOptionsForScope);
}

async function saveOptionsToDatabase() {
  try {
    const options = readOptions();
    if (optionsScopeState.scope === "profile" && optionsScopeState.profileId) {
      await request(`/api/settings/profile/${encodeURIComponent(optionsScopeState.profileId)}`, {
        method: "PUT",
        body: JSON.stringify({ options }),
      });
      elements.dbStatus.textContent = `DB 参数已保存（实例级：${elements.optionsProfileSelect.selectedOptions[0]?.textContent || ""}）`;
    } else {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ options }),
      });
      elements.dbStatus.textContent = "DB 参数已保存（全局）";
    }
  } catch {
    // Invalid intermediate form values are saved after the user finishes editing.
  }
}

async function refreshProfiles({ quiet = false } = {}) {
  if (!quiet) elements.refreshProfiles.disabled = true;
  try {
    const payload = await request("/api/profiles");
    state.profiles = payload.profiles;
    const visibleIds = new Set(state.profiles.map((profile) => profile.id));
    for (const selectedId of state.selected) {
      if (!visibleIds.has(selectedId)) state.selected.delete(selectedId);
    }
    setApiStatus(true, "BitBrowser 已连接");
    renderProfiles();
    renderSchedProfiles();
    populateRdtProfileSelect();
    populateOptionsProfileSelect();
    populateTkProfileCheckboxes();
    renderMetrics();
  } catch (error) {
    setApiStatus(false, "BitBrowser 未连接");
    if (!quiet) {
      state.profiles = [];
      state.selected.clear();
      renderProfiles();
      showToast(error.message, true);
    }
  } finally {
    elements.refreshProfiles.disabled = false;
  }
}

async function startSelectedJobs() {
  let options;
  try {
    options = readOptions();
  } catch (error) {
    showToast(error.message, true);
    return;
  }

  elements.startSelected.disabled = true;
  try {
    const profileIds = [...state.selected].filter((profileId) => {
      const job = jobForProfile(profileId);
      return !job || !ACTIVE_STATES.has(job.status);
    });
    if (!profileIds.length) throw new Error("所选实例都已有任务在运行");
    const payload = await request("/api/jobs/start", {
      method: "POST",
      body: JSON.stringify({ profileIds, options }),
    });
    if (payload.errors?.length) {
      showToast(`已启动 ${payload.started.length} 个任务，${payload.errors.length} 个未启动`, true);
    } else {
      showToast(`已启动 ${payload.started.length} 个独立任务`);
    }
    await refreshProfiles({ quiet: true });
    scheduleDataRefresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    updateSelectionUi();
  }
}

async function manuallyUpvoteCurrentPost(profileId, expectedPostId) {
  const initialJob = jobForProfile(profileId);
  if (
    state.pendingJobActions.has(profileId) ||
    state.pendingManualUpvotes.has(profileId) ||
    state.pendingManualCommentUpvotes.has(profileId) ||
    initialJob?.manualActionPending === true ||
    initialJob?.manualCommentActionPending === true
  ) {
    showToast("当前帖的点赞操作正在处理中");
    return;
  }
  if (
    !canManuallyUpvote(initialJob) ||
    initialJob.currentPost.postId !== expectedPostId
  ) {
    showToast("当前帖子已变化或暂不可点赞，请等待页面状态更新", true);
    return;
  }

  const postTitle = initialJob.currentPost.title || "当前帖子";
  const confirmed = window.confirm(
    `确定为当前帖子“${postTitle}”点赞吗？\n\n本次只会操作这一帖。`,
  );
  if (!confirmed) return;

  const currentJob = jobForProfile(profileId);
  if (
    !canManuallyUpvote(currentJob) ||
    currentJob.currentPost.postId !== expectedPostId ||
    state.pendingJobActions.has(profileId) ||
    state.pendingManualUpvotes.has(profileId) ||
    state.pendingManualCommentUpvotes.has(profileId)
  ) {
    showToast("当前帖子已变化，请重新确认", true);
    renderJobs();
    return;
  }

  state.pendingManualUpvotes.add(profileId);
  renderJobs();
  showToast("正在确认当前帖的点赞状态…");

  try {
    const payload = await request(
      `/api/jobs/${encodeURIComponent(profileId)}/manual-upvote`,
      {
        method: "POST",
        body: JSON.stringify({ expectedPostId }),
      },
    );
    const result = payload.result || {};
    if (result.ok !== true) {
      throw new Error(result.error || "未能确认点赞状态");
    }
    if (result.postId && result.postId !== expectedPostId) {
      throw new Error("返回的帖子与确认时不一致");
    }

    if (payload.job?.profileId === profileId) {
      state.jobs = state.jobs.map((job) =>
        job.profileId === profileId ? { ...job, ...payload.job } : job,
      );
    }
    if (result.changed === true) {
      showToast("已点赞");
    } else if (result.alreadyUpvoted === true) {
      showToast("该帖已是点赞状态，未重复点击");
    } else {
      showToast("当前帖的点赞状态已确认");
    }
    scheduleDataRefresh();
  } catch (error) {
    showToast(`点赞失败：${error.message}`, true);
  } finally {
    state.pendingManualUpvotes.delete(profileId);
    renderJobs();
  }
}

async function manuallyUpvoteCurrentComment(profileId, expectedCommentId) {
  const initialJob = jobForProfile(profileId);
  if (
    state.pendingJobActions.has(profileId) ||
    state.pendingManualUpvotes.has(profileId) ||
    state.pendingManualCommentUpvotes.has(profileId) ||
    initialJob?.manualActionPending === true ||
    initialJob?.manualCommentActionPending === true
  ) {
    showToast("当前评论的点赞操作正在处理中");
    return;
  }
  if (
    !canManuallyUpvoteCurrentComment(initialJob) ||
    initialJob.currentComment.commentId !== expectedCommentId
  ) {
    showToast("当前评论已变化或暂不可点赞，请等待页面状态更新", true);
    return;
  }

  const confirmed = window.confirm(
    "确定点赞当前显示的这条评论吗？\n\n本次只会操作这一条评论。",
  );
  if (!confirmed) return;

  const currentJob = jobForProfile(profileId);
  if (
    !canManuallyUpvoteCurrentComment(currentJob) ||
    currentJob.currentComment.commentId !== expectedCommentId ||
    state.pendingJobActions.has(profileId) ||
    state.pendingManualUpvotes.has(profileId) ||
    state.pendingManualCommentUpvotes.has(profileId)
  ) {
    showToast("当前评论已变化，请重新确认", true);
    renderJobs();
    return;
  }

  state.pendingManualCommentUpvotes.add(profileId);
  renderJobs();
  showToast("正在确认当前评论的点赞状态…");

  try {
    const payload = await request(
      `/api/jobs/${encodeURIComponent(profileId)}/manual-comment-upvote`,
      {
        method: "POST",
        body: JSON.stringify({ expectedCommentId }),
      },
    );
    const result = payload.result || {};
    if (result.ok !== true) {
      throw new Error(result.error || "未能确认评论点赞状态");
    }
    if (result.commentId && result.commentId !== expectedCommentId) {
      throw new Error("返回的评论与确认时不一致");
    }

    if (payload.job?.profileId === profileId) {
      state.jobs = state.jobs.map((job) =>
        job.profileId === profileId ? { ...job, ...payload.job } : job,
      );
    }
    if (result.changed === true) {
      showToast("已点赞当前评论");
    } else if (result.alreadyUpvoted === true) {
      showToast("该评论已是点赞状态，未重复点击");
    } else {
      showToast("当前评论的点赞状态已确认");
    }
    scheduleDataRefresh();
  } catch (error) {
    showToast(`评论点赞失败：${error.message}`, true);
  } finally {
    state.pendingManualCommentUpvotes.delete(profileId);
    renderJobs();
  }
}

async function controlJob(profileId, action) {
  if (state.pendingJobActions.has(profileId)) return;
  state.pendingJobActions.add(profileId);
  renderJobs();
  try {
    await request(`/api/jobs/${encodeURIComponent(profileId)}/${action}`, {
      method: "POST",
      body: "{}",
    });
    const messages = {
      stop: "任务已停止",
      pause: "暂停请求已发送",
      resume: "任务已继续",
      trigger: "已要求立即继续",
    };
    showToast(messages[action] || "操作已执行");
    scheduleDataRefresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.pendingJobActions.delete(profileId);
    renderJobs();
  }
}

async function stopSelectedJobs() {
  const activeIds = [...state.selected].filter((profileId) => {
    const job = jobForProfile(profileId);
    return job && ACTIVE_STATES.has(job.status);
  });
  if (!activeIds.length) return;
  elements.stopSelected.disabled = true;
  await Promise.all(activeIds.map((profileId) => controlJob(profileId, "stop")));
}

async function stopAllJobs() {
  elements.stopAll.disabled = true;
  try {
    await request("/api/jobs/stop-all", { method: "POST", body: "{}" });
    showToast("所有任务已停止");
    scheduleDataRefresh();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderProfileFilter() {
  const current = elements.dataProfileFilter.value;
  elements.dataProfileFilter.innerHTML = [
    '<option value="">全部实例</option>',
    ...state.profiles.map(
      (profile) =>
        `<option value="${escapeHtml(profile.id)}">#${escapeHtml(profile.seq ?? "—")} · ${escapeHtml(profile.name)}</option>`,
    ),
  ].join("");
  if (state.profiles.some((profile) => profile.id === current)) {
    elements.dataProfileFilter.value = current;
  }
}

function dataQuery(kind) {
  const params = new URLSearchParams({ limit: kind === "history" ? "100" : "200" });
  if (elements.dataProfileFilter.value) params.set("profileId", elements.dataProfileFilter.value);
  if (kind === "history" && elements.historyStatusFilter.value) {
    params.set("status", elements.historyStatusFilter.value);
  }
  if (kind === "logs" && elements.logLevelFilter.value) {
    params.set("level", elements.logLevelFilter.value);
  }
  return params;
}

function updateExportLinks() {
  const history = dataQuery("history");
  const logs = dataQuery("logs");
  history.delete("limit");
  logs.delete("limit");
  elements.exportHistory.href = `/api/export/history.csv?${history}`;
  elements.exportLogs.href = `/api/export/logs.csv?${logs}`;
}

async function refreshData({ quiet = false } = {}) {
  if (!quiet) elements.refreshData.disabled = true;
  try {
    const [statsPayload, historyPayload, logsPayload] = await Promise.all([
      request("/api/stats"),
      request(`/api/history?${dataQuery("history")}`),
      request(`/api/logs?${dataQuery("logs")}`),
    ]);
    state.stats = statsPayload.stats;
    state.history = historyPayload.runs;
    state.databaseLogs = logsPayload.logs;
    elements.dbStatus.textContent = "DB 已同步";
    renderDatabase();
  } catch (error) {
    elements.dbStatus.textContent = "DB 读取失败";
    if (!quiet) showToast(error.message, true);
  } finally {
    elements.refreshData.disabled = false;
  }
}

function scheduleDataRefresh() {
  clearTimeout(state.dataRefreshTimer);
  state.dataRefreshTimer = setTimeout(() => refreshData({ quiet: true }), 600);
}

function renderDatabase() {
  const stats = state.stats || {};
  elements.dbRuns.textContent = formatNumber(stats.runCount);
  elements.dbCompleted.textContent = formatNumber(stats.completedCount);
  elements.dbPosts.textContent = formatNumber(stats.postCount);
  elements.dbDetailVisits.textContent = formatNumber(stats.detailVisitCount);
  elements.dbEvents.textContent = formatNumber(stats.eventCount);
  renderHistory();
  renderDatabaseLogs();
  updateExportLinks();
}

function renderHistory() {
  elements.historyEmpty.classList.toggle("hidden", state.history.length > 0);
  elements.historyBody.innerHTML = state.history
    .map((run) => {
      const isPostTask = run.taskMode === "post";
      const shownPosts = isPostTask
        ? formatNumber(run.postCount)
        : `<span class="legacy-task-value" title="旧版任务按固定像素滚动，不能换算成帖子数">旧版 · ${formatNumber(run.scrollCount)} 次滚动</span>`;
      const detailVisits = !isPostTask
        ? '<span class="legacy-task-value">不适用</span>'
        : run.workflowMode === "feed_detail_readonly"
          ? formatNumber(run.detailVisitCount)
          : '<span class="legacy-task-value">仅 Feed</span>';
      const commentScrolls = !isPostTask
        ? '<span class="legacy-task-value">不适用</span>'
        : run.workflowMode === "feed_detail_readonly"
          ? formatNumber(run.commentScrollCount)
          : '<span class="legacy-task-value">仅 Feed</span>';
      return `
        <tr>
          <td class="history-id">#${escapeHtml(run.id)}</td>
          <td><strong>#${escapeHtml(run.profileSeq ?? "—")}</strong> · ${escapeHtml(run.profileName)}</td>
          <td><span class="history-status ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status, run.statusText))}</span></td>
          <td>${escapeHtml(formatDateTime(run.startedAt))}</td>
          <td>${shownPosts}</td>
          <td>${detailVisits}</td>
          <td>${commentScrolls}</td>
          <td><button class="detail-button" type="button" data-run-detail="${escapeHtml(run.id)}">详情</button></td>
        </tr>`;
    })
    .join("");
  for (const button of elements.historyBody.querySelectorAll("[data-run-detail]")) {
    button.addEventListener("click", () => showRunDetail(button.dataset.runDetail));
  }
}

function renderDatabaseLogs() {
  elements.logsEmpty.classList.toggle("hidden", state.databaseLogs.length > 0);
  elements.databaseLogList.innerHTML = state.databaseLogs
    .map(
      (log) => `
        <li class="database-log-item">
          <time class="database-log-time">${escapeHtml(formatDateTime(log.createdAt))}</time>
          <span class="log-level ${escapeHtml(log.level)}">${escapeHtml(log.level)}</span>
          <span class="database-log-profile">#${escapeHtml(log.profileSeq ?? "—")} ${escapeHtml(log.profileName)}</span>
          <span class="database-log-message">${escapeHtml(log.message)}</span>
        </li>`,
    )
    .join("");
}

async function showRunDetail(runId) {
  try {
    const payload = await request(`/api/history/${encodeURIComponent(runId)}`);
    const run = payload.run;
    const isPostTask = run.taskMode === "post";
    const currentPostTitle = run.currentPost?.title || "—";
    const detailPostTitle = run.currentDetailPost?.title || "—";
    const isDetailWorkflow = isPostTask && run.workflowMode === "feed_detail_readonly";
    const taskMetrics = isPostTask
      ? `
        <div><span>任务模式</span><strong>${isDetailWorkflow ? "Feed 与详情只读循环" : "仅 Feed 逐帖阅读"}</strong></div>
        <div><span>展示帖子</span><strong>${formatNumber(run.postCount)}</strong></div>
        <div><span>完整入镜</span><strong>${formatNumber(run.fullPostCount)}</strong></div>
        <div><span>当前帖子</span><strong title="${escapeHtml(currentPostTitle)}">${escapeHtml(currentPostTitle)}</strong></div>
        <div><span>查看详情</span><strong>${formatNumber(run.detailVisitCount)}</strong></div>
        <div><span>评论区移动</span><strong>${formatNumber(run.commentScrollCount)}</strong></div>
        <div><span>跳过广告</span><strong>${formatNumber(run.skippedPromotedCount)}</strong></div>
        <div><span>自动点赞</span><strong>${formatNumber(run.autoUpvoteCount)} 帖 / ${formatNumber(run.autoCommentUpvoteCount)} 评</strong></div>
        <div><span>最后详情帖</span><strong title="${escapeHtml(detailPostTitle)}">${escapeHtml(detailPostTitle)}</strong></div>
        <div><span>最后阶段</span><strong>${escapeHtml(workflowPhaseLabel(run))}</strong></div>`
      : `
        <div><span>任务模式</span><strong>旧版像素滚动</strong></div>
        <div><span>滚动次数</span><strong>${formatNumber(run.scrollCount)}</strong></div>
        <div><span>累计距离</span><strong>${formatNumber(run.totalPixels)}px</strong></div>
        <div><span>距离范围</span><strong>${formatNumber(run.options?.scrollMinPx)}–${formatNumber(run.options?.scrollMaxPx)}px</strong></div>`;
    elements.dialogTitle.textContent = `任务 #${run.id} · 实例 #${run.profileSeq ?? "—"}`;
    elements.dialogContent.innerHTML = `
      <div class="detail-grid">
        <div><span>状态</span><strong>${escapeHtml(statusLabel(run.status, run.statusText))}</strong></div>
        ${taskMetrics}
        <div><span>开始时间</span><strong>${escapeHtml(formatDateTime(run.startedAt))}</strong></div>
        <div><span>结束时间</span><strong>${escapeHtml(formatDateTime(run.stoppedAt))}</strong></div>
        <div><span>${isPostTask ? "Feed 每帖停留" : "等待范围"}</span><strong>${run.options?.waitMinSec ?? "—"}–${run.options?.waitMaxSec ?? "—"} 秒</strong></div>
        ${isDetailWorkflow ? `
          <div><span>进入详情阈值</span><strong>${run.options?.detailAfterMinPosts ?? "—"}–${run.options?.detailAfterMaxPosts ?? "—"} 篇</strong></div>
          <div><span>详情等待</span><strong>${run.options?.detailWaitMinSec ?? "—"}–${run.options?.detailWaitMaxSec ?? "—"} 秒</strong></div>
          <div><span>评论区移动</span><strong>${run.options?.commentScrollMin ?? "—"}–${run.options?.commentScrollMax ?? "—"} 次</strong></div>
          <div><span>返回前停留</span><strong>${run.options?.returnWaitMinSec ?? "—"}–${run.options?.returnWaitMaxSec ?? "—"} 秒</strong></div>
        ` : ""}
      </div>
      ${run.error ? `<p class="database-log-message">错误：${escapeHtml(run.error)}</p>` : ""}
      <ol class="detail-events">
        ${run.events
          .map(
            (event) => `
              <li>
                <time>${escapeHtml(new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour12: false }))}</time>
                <span>${escapeHtml(event.message)}</span>
              </li>`,
          )
          .join("")}
      </ol>`;
    elements.runDialog.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

function switchDataTab(tab) {
  state.activeDataTab = tab;
  for (const button of document.querySelectorAll("[data-data-tab]")) {
    const active = button.dataset.dataTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  elements.historyView.classList.toggle("hidden", tab !== "history");
  elements.logsView.classList.toggle("hidden", tab !== "logs");
  elements.statusFilterWrap.classList.toggle("hidden", tab !== "history");
  elements.levelFilterWrap.classList.toggle("hidden", tab !== "logs");
}

async function clearDatabaseLogs() {
  const profileId = elements.dataProfileFilter.value;
  const scope = profileId ? "当前筛选实例" : "全部实例";
  if (!window.confirm(`确定清空${scope}的持久化日志吗？任务历史和统计数据会保留。`)) return;
  try {
    const payload = await request("/api/logs", {
      method: "DELETE",
      body: JSON.stringify({ profileId: profileId || null }),
    });
    showToast(`已清理 ${payload.deleted} 条日志`);
    await refreshData({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  }
}

function connectEventStream() {
  const stream = new EventSource("/api/events");
  stream.addEventListener("open", () => {
    elements.streamStatus.textContent = "实时监控已连接";
  });
  stream.addEventListener("jobs", (event) => {
    state.jobs = JSON.parse(event.data);
    renderJobs();
    renderProfiles();
    scheduleDataRefresh();
    if (state.scheduler?.running) renderScheduler();
  });
  stream.addEventListener("tiktok-jobs", (event) => {
    state.tiktokJobs = JSON.parse(event.data);
    renderTiktokJobs();
    if (state.scheduler?.running) renderScheduler();
  });
  stream.addEventListener("scheduler", (event) => {
    state.scheduler = JSON.parse(event.data);
    renderScheduler();
  });
  stream.addEventListener("error", () => {
    elements.streamStatus.textContent = "实时监控正在重连";
  });
}

function updateCountdowns() {
  for (const element of document.querySelectorAll("[data-countdown]")) {
    const remaining = Math.max(0, new Date(element.dataset.countdown).getTime() - Date.now());
    element.textContent = `${(remaining / 1000).toFixed(1)} 秒`;
  }
}

async function fetchJoinTargets() {
  try {
    const res = await request("/api/reddit/join-targets");
    const targets = res.targets || [];
    if (elements.joinTargetsText) {
      elements.joinTargetsText.value = targets.map((t) => t.name).join("\n");
    }
  } catch {}
}

function parseJoinTargetsText(text) {
  const seen = new Set();
  return text
    .split(/[\n\r,;\t]+/)
    .flatMap((segment) => segment.trim().split(/\s+/))
    .map((token) => {
      let name = token.trim();
      if (!name || name.startsWith("#")) return null;
      try {
        const url = new URL(name);
        const match = url.pathname.match(/^\/r\/([^/]+)/i);
        if (match) name = match[1];
      } catch {}
      name = name.replace(/^\/?r\//i, "").replace(/\/.*$/, "").trim();
      return name || null;
    })
    .filter((name) => {
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((name) => ({ name }));
}

if (elements.joinTargetsSave) {
  elements.joinTargetsSave.addEventListener("click", async () => {
    try {
      const targets = parseJoinTargetsText(elements.joinTargetsText.value);
      const res = await request("/api/reddit/join-targets", {
        method: "PUT",
        body: JSON.stringify({ targets }),
      });
      elements.joinTargetsText.value = (res.targets || []).map((t) => t.name).join("\n");
      elements.joinTargetsStatus.textContent = `已保存 ${res.targets.length} 个群组`;
      showToast(`群组列表已保存（${res.targets.length} 个）`);
    } catch (e) {
      elements.joinTargetsStatus.textContent = `保存失败：${e.message}`;
      showToast(e.message, true);
    }
  });
}

async function initialize() {
  try {
    const [config, jobsPayload] = await Promise.all([
      request("/api/config"),
      request("/api/jobs"),
    ]);
    state.config = config;
    state.jobs = jobsPayload.jobs;
    if (elements.targetUrl) elements.targetUrl.textContent = config.targetUrl;
    elements.apiEndpoint.textContent = config.bitBrowserApiUrl;
    elements.databaseFile.textContent = config.databaseFile;
    let localOptions = null;
    try {
      localOptions = JSON.parse(
        localStorage.getItem(OPTIONS_STORAGE_KEY) ||
          localStorage.getItem(LEGACY_OPTIONS_STORAGE_KEY),
      );
    } catch {
      localOptions = null;
    }
    applyOptions(config.savedOptions || localOptions || config.defaults);
    await fetchJoinTargets();
    loadAiCommentConfig();
    renderJobs();
  } catch (error) {
    showToast(error.message, true);
  }

  await refreshProfiles();
  populateRdtProfileSelect();
  populateOptionsProfileSelect();
  renderRdtActionsGroups([]);
  refreshRedditAccounts();
  await refreshData({ quiet: true });
  connectEventStream();
  initTiktok();
  initScheduler();
}

elements.refreshProfiles.addEventListener("click", () => refreshProfiles());
elements.selectAll.addEventListener("click", () => {
  if (state.selected.size === state.profiles.length) state.selected.clear();
  else state.selected = new Set(state.profiles.map((profile) => profile.id));
  renderProfiles();
});
elements.resetOptions.addEventListener("click", async () => {
  applyOptions(state.config?.defaults || FALLBACK_OPTIONS);
  localStorage.removeItem(OPTIONS_STORAGE_KEY);
  localStorage.removeItem(LEGACY_OPTIONS_STORAGE_KEY);
  await saveOptionsToDatabase();
  showToast("已恢复并保存默认参数");
});
elements.optionsForm.addEventListener("input", () => {
  clearTimeout(state.settingsSaveTimer);
  state.settingsSaveTimer = setTimeout(saveOptionsToDatabase, 650);
});
elements.startSelected.addEventListener("click", startSelectedJobs);
elements.stopSelected.addEventListener("click", stopSelectedJobs);
elements.stopAll.addEventListener("click", stopAllJobs);
elements.refreshData.addEventListener("click", () => refreshData());
elements.clearLogs.addEventListener("click", clearDatabaseLogs);
elements.dataProfileFilter.addEventListener("change", () => refreshData({ quiet: true }));
elements.historyStatusFilter.addEventListener("change", () => refreshData({ quiet: true }));
elements.logLevelFilter.addEventListener("change", () => refreshData({ quiet: true }));
for (const button of document.querySelectorAll("[data-data-tab]")) {
  button.addEventListener("click", () => switchDataTab(button.dataset.dataTab));
}

setInterval(updateCountdowns, 200);
setInterval(() => refreshProfiles({ quiet: true }), 15000);
setInterval(() => refreshData({ quiet: true }), 30000);
void initialize();

// ---- TikTok 养号 ----
const TK_FALLBACK = Object.freeze({
  watchMinSec: 8,
  watchMaxSec: 25,
  maxVideos: 0,
  likeEnabled: false,
  likeProbability: 0,
  commentWatchEnabled: false,
  commentWatchProbability: 0,
  commentEnabled: false,
  commentProbability: 0,
  commentTexts: [],
  searchEnabled: false,
  searchKeywords: [],
  searchVideosPerKeyword: 5,
  searchCommentEnabled: false,
  searchCommentProbability: 0,
  searchCommentTexts: [],
});

const tk = {
  scopeSelect: document.querySelector("#tk-scope-select"),
  profileCheckboxes: document.querySelector("#tk-profile-checkboxes"),
  scopeHint: document.querySelector("#tk-scope-hint"),
  startAllBtn: document.querySelector("#tk-start-all"),
  stopAllBtn: document.querySelector("#tk-stop-all"),
  watchMin: document.querySelector("#tk-watch-min"),
  watchMax: document.querySelector("#tk-watch-max"),
  maxVideos: document.querySelector("#tk-max-videos"),
  likeEnabled: document.querySelector("#tk-like-enabled"),
  likeProb: document.querySelector("#tk-like-prob"),
  commentWatchEnabled: document.querySelector("#tk-comment-watch-enabled"),
  commentWatchProb: document.querySelector("#tk-comment-watch-prob"),
  commentEnabled: document.querySelector("#tk-comment-enabled"),
  commentProb: document.querySelector("#tk-comment-prob"),
  commentTexts: document.querySelector("#tk-comment-texts"),
  searchEnabled: document.querySelector("#tk-search-enabled"),
  searchKeywords: document.querySelector("#tk-search-keywords"),
  searchVideos: document.querySelector("#tk-search-videos"),
  searchCommentEnabled: document.querySelector("#tk-search-comment-enabled"),
  searchCommentProb: document.querySelector("#tk-search-comment-prob"),
  searchCommentTexts: document.querySelector("#tk-search-comment-texts"),
  resetBtn: document.querySelector("#tk-reset"),
  startBtn: document.querySelector("#tk-start"),
  stopBtn: document.querySelector("#tk-stop"),
  jobList: document.querySelector("#tk-jobs"),
  refreshData: document.querySelector("#tk-refresh-data"),
  historyBody: document.querySelector("#tk-history-body"),
  historyEmpty: document.querySelector("#tk-history-empty"),
  logList: document.querySelector("#tk-log-list"),
  logsEmpty: document.querySelector("#tk-logs-empty"),
  historyView: document.querySelector("#tk-history-view"),
  logsView: document.querySelector("#tk-logs-view"),
};

const tkState = { history: [], logs: [] };

const tkScopeState = { scope: "global", selectedProfileIds: [] };

function populateTkProfileCheckboxes() {
  if (!tk.profileCheckboxes) return;
  const profiles = (state.profiles || []).filter(p => p.seq != null).sort((a, b) => a.seq - b.seq);
  tk.profileCheckboxes.innerHTML = profiles.map(p =>
    `<label class="tk-profile-check"><input type="checkbox" value="${escapeHtml(p.id)}" /><span>#${escapeHtml(p.seq)}</span><span>${escapeHtml(p.name)}</span></label>`
  ).join("");
  tk.profileCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", () => {
      tkScopeState.selectedProfileIds = [...tk.profileCheckboxes.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
      loadTkOptionsForScope();
    });
  });
}

async function loadTkOptionsForScope() {
  if (tkScopeState.scope === "global") {
    if (tk.scopeHint) { tk.scopeHint.textContent = "所有未单独配置的实例将使用这些参数"; }
    try {
      const cfg = await request("/api/tiktok/config");
      applyTiktokOptions(cfg.saved || cfg.defaults || {});
    } catch {}
  } else {
    const ids = tkScopeState.selectedProfileIds;
    if (ids.length === 0) {
      if (tk.scopeHint) tk.scopeHint.textContent = "请勾选要配置的实例";
      return;
    }
    if (ids.length === 1) {
      if (tk.scopeHint) tk.scopeHint.textContent = `正在编辑实例 ${ids[0].substring(0, 8)}… 的独立参数`;
      try {
        const cfg = await request(`/api/tiktok/config?profileId=${encodeURIComponent(ids[0])}`);
        applyTiktokOptions(cfg.saved || cfg.defaults || {});
      } catch {}
    } else {
      if (tk.scopeHint) tk.scopeHint.textContent = `已选 ${ids.length} 个实例，保存时将批量应用到所有选中实例`;
      try {
        const cfg = await request("/api/tiktok/config");
        applyTiktokOptions(cfg.defaults || {});
      } catch {}
    }
  }
}

if (tk.scopeSelect) {
  tk.scopeSelect.addEventListener("change", () => {
    tkScopeState.scope = tk.scopeSelect.value;
    if (tkScopeState.scope === "global") {
      tk.profileCheckboxes?.classList.add("hidden");
    } else {
      tk.profileCheckboxes?.classList.remove("hidden");
    }
    loadTkOptionsForScope();
  });
}

function applyTiktokOptions(options) {
  const o = { ...TK_FALLBACK, ...options };
  tk.watchMin.value = o.watchMinSec;
  tk.watchMax.value = o.watchMaxSec;
  tk.maxVideos.value = o.maxVideos;
  tk.likeEnabled.checked = Boolean(o.likeEnabled);
  tk.likeProb.value = o.likeProbability;
  tk.commentWatchEnabled.checked = Boolean(o.commentWatchEnabled);
  tk.commentWatchProb.value = o.commentWatchProbability;
  tk.commentEnabled.checked = Boolean(o.commentEnabled);
  tk.commentProb.value = o.commentProbability;
  tk.commentTexts.value = Array.isArray(o.commentTexts) ? o.commentTexts.join("\n") : "";
  tk.searchEnabled.checked = Boolean(o.searchEnabled);
  tk.searchKeywords.value = Array.isArray(o.searchKeywords) ? o.searchKeywords.join("\n") : "";
  tk.searchVideos.value = o.searchVideosPerKeyword || 5;
  tk.searchCommentEnabled.checked = Boolean(o.searchCommentEnabled);
  tk.searchCommentProb.value = o.searchCommentProbability || 0;
  tk.searchCommentTexts.value = Array.isArray(o.searchCommentTexts) ? o.searchCommentTexts.join("\n") : "";
}

function collectTiktokOptions() {
  const texts = tk.commentTexts.value.split("\n").map((s) => s.trim()).filter(Boolean);
  const searchKeywords = tk.searchKeywords.value.split("\n").map((s) => s.trim()).filter(Boolean);
  const searchCommentTexts = tk.searchCommentTexts.value.split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    watchMinSec: Number(tk.watchMin.value),
    watchMaxSec: Number(tk.watchMax.value),
    maxVideos: Number(tk.maxVideos.value),
    likeEnabled: tk.likeEnabled.checked,
    likeProbability: Number(tk.likeProb.value),
    commentWatchEnabled: tk.commentWatchEnabled.checked,
    commentWatchProbability: Number(tk.commentWatchProb.value),
    commentEnabled: tk.commentEnabled.checked,
    commentProbability: Number(tk.commentProb.value),
    commentTexts: texts,
    searchEnabled: tk.searchEnabled.checked,
    searchKeywords,
    searchVideosPerKeyword: Number(tk.searchVideos.value),
    searchCommentEnabled: tk.searchCommentEnabled.checked,
    searchCommentProbability: Number(tk.searchCommentProb.value),
    searchCommentTexts,
  };
}

function renderTiktokJobs() {
  if (!tk.jobList) return;
  const jobs = state.tiktokJobs || [];
  if (jobs.length === 0) {
    tk.jobList.innerHTML = `<div class="empty-state compact">没有运行中的 TikTok 任务。</div>`;
    return;
  }
  tk.jobList.innerHTML = jobs.map((job) => {
    const opts = job.options || {};
    const runningMs = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : 0;
    const runningStr = runningMs > 0 ? formatDuration(runningMs) : "";
    const featTags = [
      opts.likeEnabled ? '<span class="tk-feat on">点赞</span>' : '<span class="tk-feat">点赞</span>',
      opts.commentEnabled ? '<span class="tk-feat on">评论</span>' : '<span class="tk-feat">评论</span>',
      opts.commentWatchEnabled ? '<span class="tk-feat on">看评论</span>' : '<span class="tk-feat">看评论</span>',
      opts.searchEnabled ? '<span class="tk-feat on">搜索</span>' : '<span class="tk-feat">搜索</span>',
    ].join("");
    const cv = job.currentVideo;
    const cvDesc = cv?.desc ? (cv.desc.length > 40 ? cv.desc.substring(0, 40) + "…" : cv.desc) : "";
    const cvLiked = cv?.liked ? '<span class="tk-liked">已赞</span>' : "";
    return `
    <div class="tk-job-card tk-status-${escapeHtml(job.status)}">
      <div class="tk-job-head">
        <strong>${escapeHtml(job.profileName)}</strong>
        <span class="tk-status-badge tk-status-${escapeHtml(job.status)}">${escapeHtml(job.statusText || job.status)}</span>
        ${runningStr ? `<span class="tk-duration">${runningStr}</span>` : ""}
      </div>
      <div class="tk-job-stats">
        <div class="tk-stat"><span>For You</span><strong>${job.videoCount || 0}</strong></div>
        <div class="tk-stat"><span>搜索</span><strong>${job.searchVideoCount || 0}</strong></div>
        <div class="tk-stat"><span>点赞</span><strong>${job.likeCount || 0}</strong></div>
        <div class="tk-stat"><span>评论</span><strong>${job.commentCount || 0}</strong></div>
      </div>
      ${cv ? `<div class="tk-job-current"><span class="tk-author">${escapeHtml(cv.author || "")}</span>${cvDesc ? ` · <span class="tk-desc">${escapeHtml(cvDesc)}</span>` : ""}${cvLiked}</div>` : ""}
      <div class="tk-job-feats">${featTags}</div>
      ${job.error ? `<div class="tk-job-error">${escapeHtml(job.error)}</div>` : ""}
    </div>`;
  }).join("");
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

function renderTiktokHistory() {
  const runs = tkState.history || [];
  tk.historyEmpty.classList.toggle("hidden", runs.length > 0);
  if (runs.length === 0) { tk.historyBody.innerHTML = ""; return; }
  tk.historyBody.innerHTML = `<table class="history-table"><thead><tr><th>实例</th><th>状态</th><th>视频</th><th>点赞</th><th>评论</th><th>开始</th><th>结束</th></tr></thead><tbody>${runs.map((r) => `
    <tr>
      <td>${escapeHtml(r.profileName)}</td>
      <td><span class="tk-status tk-status-${escapeHtml(r.status)}">${escapeHtml(r.statusText || r.status)}</span></td>
      <td>${r.videoCount}</td>
      <td>${r.likeCount}</td>
      <td>${r.commentCount}</td>
      <td>${formatDateTime(r.startedAt)}</td>
      <td>${formatDateTime(r.stoppedAt)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function renderTiktokLogs() {
  const logs = tkState.logs || [];
  tk.logsEmpty.classList.toggle("hidden", logs.length > 0);
  tk.logList.innerHTML = logs.map((l) => `
    <li class="log-item log-${escapeHtml(l.level)}">
      <span class="log-time">${formatDateTime(l.createdAt)}</span>
      <span class="log-level">${escapeHtml(l.level)}</span>
      <span class="log-msg">${escapeHtml(l.message)}</span>
    </li>`).join("");
}

async function refreshTiktokData() {
  try {
    const [h, l] = await Promise.all([
      request("/api/tiktok/history?limit=100"),
      request("/api/tiktok/logs?limit=200"),
    ]);
    tkState.history = h.runs || [];
    tkState.logs = l.logs || [];
    renderTiktokHistory();
    renderTiktokLogs();
  } catch (e) {
    showToast("TikTok 数据加载失败：" + e.message, true);
  }
}

// ---- Reddit 账号管理模块 ----
const rdtExt = {
  bindProfile: document.querySelector("#rdt-bind-profile"),
  username: document.querySelector("#rdt-username"),
  registeredAt: document.querySelector("#rdt-registered-at"),
  nurtureStartedAt: document.querySelector("#rdt-nurture-started-at"),
  stage: document.querySelector("#rdt-stage"),
  karma: document.querySelector("#rdt-karma"),
  notes: document.querySelector("#rdt-notes"),
  btnSave: document.querySelector("#btn-save-reddit-account"),
  btnRefresh: document.querySelector("#rdt-refresh-accounts"),
  tableBody: document.querySelector("#rdt-accounts-table-body"),
  actionsGroups: document.querySelector("#rdt-actions-groups"),
};
const rdtExtState = { accounts: [], editingId: null };
const NURTURE_STAGE_LABELS = {
  week1: "Week 1（仅点赞）",
  week2: "Week 2（开始评论）",
  week3: "Week 3（开始发帖）",
};

const NURTURE_ACTION_GROUPS = [
  {
    group: "week1",
    label: "Week 1：点赞养号",
    items: [
      { key: "w1_feed_upvote", label: "主页 Feed 点赞" },
      { key: "w1_comment_upvote", label: "评论区点赞" },
      { key: "w1_join_subreddit", label: "关注目标社群" },
      { key: "w1_targeted_upvote", label: "浏览目标社群并点赞" },
    ],
  },
  {
    group: "week2",
    label: "Week 2：评论互动",
    items: [
      { key: "w2_post_comment", label: "发评论" },
      { key: "w2_comment_on_new", label: "筛选 new 帖子评论" },
      { key: "w2_check_post_age", label: "帖子发布 >1 小时检查" },
      { key: "w2_check_author", label: "发帖人权重检查" },
      { key: "w2_multi_comment", label: "多条评论（每天 2+）" },
      { key: "w2_hourly_comment", label: "每小时一条评论" },
    ],
  },
  {
    group: "week3",
    label: "Week 3：发帖",
    items: [
      { key: "w3_create_post", label: "发帖" },
      { key: "w3_narrative_post", label: "叙事图文帖（谁在哪里干了什么）" },
      { key: "w3_image_post", label: "带实拍图发帖" },
    ],
  },
];
const NURTURE_ACTION_LABELS = {};
for (const g of NURTURE_ACTION_GROUPS) {
  for (const item of g.items) NURTURE_ACTION_LABELS[item.key] = item.label;
}

const NURTURE_ACTION_CONFIGS = {
  w1_join_subreddit: [{ label: "目标社群列表", type: "textarea", placeholder: "每行一个社群名，如：\nLV\nChanel\nhandbags", key: "targets" }],
  w2_post_comment: [
    { label: "使用 AI 生成评论", type: "checkbox", key: "useAI" },
    { label: "评论文本库（AI 失败时回退）", type: "textarea", placeholder: "每行一条评论，随机选取发布\n如：This is really helpful!\nGreat point, thanks!", key: "texts" },
  ],
  w2_check_post_age: [{ label: "帖子最小发布时间（小时）", type: "number", placeholder: "1", key: "minHours" }],
  w2_check_author: [{ label: "发帖人最低 Karma", type: "number", placeholder: "200", key: "minKarma" }],
  w2_multi_comment: [{ label: "每天评论数上限", type: "number", placeholder: "2", key: "dailyMax" }],
  w3_narrative_post: [{ label: "文案模板", type: "textarea", placeholder: "每行一个文案模板，如：\nBought my first LV bag in LA last week...", key: "templates" }],
  w3_image_post: [{ label: "图片目录路径", type: "text", placeholder: "D:/images/reddit/", key: "imageDir" }],
};

function renderRdtActionsGroups(selectedActions = [], actionConfigs = {}) {
  if (!rdtExt.actionsGroups) return;
  const selectedSet = new Set(selectedActions);
  rdtExt.actionsGroups.innerHTML = NURTURE_ACTION_GROUPS.map(group => {
    const allChecked = group.items.every(i => selectedSet.has(i.key));
    return `<div class="rdt-action-group">
      <div class="rdt-action-group-header">
        <label class="switch-row" style="font-size:12px;">
          <input type="checkbox" class="rdt-group-toggle" data-group="${group.group}" ${allChecked ? "checked" : ""} />
          <strong>${escapeHtml(group.label)}</strong>
        </label>
      </div>
      <div class="rdt-action-items">
        ${group.items.map(item => {
          const configDefs = NURTURE_ACTION_CONFIGS[item.key];
          const isChecked = selectedSet.has(item.key);
          let configHtml = "";
          if (configDefs && Array.isArray(configDefs)) {
            configHtml = configDefs.map(configDef => {
              const savedValue = (actionConfigs[item.key] || {})[configDef.key];
              if (configDef.type === "checkbox") {
                return `<div class="rdt-action-config ${isChecked ? "" : "hidden"}" data-action-key="${escapeHtml(item.key)}">
                  <label class="rdt-config-label" style="flex-direction:row;align-items:center;gap:6px;">
                    <input class="rdt-action-config-input" data-action-key="${escapeHtml(item.key)}" data-config-key="${escapeHtml(configDef.key)}" type="checkbox" ${savedValue ? "checked" : ""} style="width:14px;height:14px;" />
                    <span>${escapeHtml(configDef.label)}</span>
                  </label>
                </div>`;
              }
              const savedStr = savedValue || "";
              const valAttr = configDef.type === "textarea"
                ? `>${escapeHtml(savedStr)}</textarea>`
                : ` value="${escapeHtml(savedStr)}" />`;
              return `<div class="rdt-action-config ${isChecked ? "" : "hidden"}" data-action-key="${escapeHtml(item.key)}">
                <label class="rdt-config-label">
                  <span>${escapeHtml(configDef.label)}</span>
                  ${configDef.type === "textarea"
                    ? `<textarea class="rdt-action-config-input" data-action-key="${escapeHtml(item.key)}" data-config-key="${escapeHtml(configDef.key)}" rows="3" placeholder="${escapeHtml(configDef.placeholder || "")}"${valAttr}`
                    : `<input class="rdt-action-config-input" data-action-key="${escapeHtml(item.key)}" data-config-key="${escapeHtml(configDef.key)}" type="${configDef.type}" style="width:80px;" placeholder="${escapeHtml(configDef.placeholder || "")}"${valAttr}`
                  }
                </label>
              </div>`;
            }).join("");
          }
          return `<label class="rdt-action-item">
            <input type="checkbox" class="rdt-action-checkbox" value="${escapeHtml(item.key)}" ${isChecked ? "checked" : ""} />
            <span>${escapeHtml(item.label)}</span>
          </label>
          ${configHtml}`;
        }).join("")}
      </div>
    </div>`;
  }).join("");

  rdtExt.actionsGroups.querySelectorAll(".rdt-group-toggle").forEach(toggle => {
    toggle.addEventListener("change", () => {
      const group = toggle.dataset.group;
      const groupDef = NURTURE_ACTION_GROUPS.find(g => g.group === group);
      if (!groupDef) return;
      groupDef.items.forEach(item => {
        const cb = rdtExt.actionsGroups.querySelector(`.rdt-action-checkbox[value="${item.key}"]`);
        if (cb) {
          cb.checked = toggle.checked;
          const configEls = rdtExt.actionsGroups.querySelectorAll(`.rdt-action-config[data-action-key="${item.key}"]`);
          configEls.forEach(el => el.classList.toggle("hidden", !cb.checked));
        }
      });
    });
  });

  rdtExt.actionsGroups.querySelectorAll(".rdt-action-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const configEls = rdtExt.actionsGroups.querySelectorAll(`.rdt-action-config[data-action-key="${cb.value}"]`);
      configEls.forEach(el => el.classList.toggle("hidden", !cb.checked));
    });
  });
}

function getSelectedRdtActions() {
  if (!rdtExt.actionsGroups) return [];
  return [...rdtExt.actionsGroups.querySelectorAll(".rdt-action-checkbox:checked")].map(cb => cb.value);
}

function getRdtActionConfigs() {
  if (!rdtExt.actionsGroups) return {};
  const configs = {};
  for (const [actionKey, defList] of Object.entries(NURTURE_ACTION_CONFIGS)) {
    for (const def of defList) {
      const input = rdtExt.actionsGroups.querySelector(`.rdt-action-config-input[data-action-key="${actionKey}"][data-config-key="${def.key}"]`);
      if (!input) continue;
      const value = def.type === "checkbox" ? input.checked : input.value.trim();
      if (def.type === "checkbox" ? true : value !== "") {
        if (!configs[actionKey]) configs[actionKey] = {};
        configs[actionKey][def.key] = value;
      }
    }
  }
  return configs;
}

async function refreshRedditAccounts() {
  try {
    const res = await request("/api/reddit/accounts");
    rdtExtState.accounts = res.accounts || [];
    renderRedditAccounts();
    if (rdtExt.bindProfile?.value) {
      const profileId = rdtExt.bindProfile.value;
      const acc = rdtExtState.accounts.find(a => a.profileId === profileId);
      if (acc) fillRdtFormFromAccount(acc);
      else { fillRdtFormFromAccount(null); if (rdtExt.stage) rdtExt.stage.value = "week1"; if (rdtExt.karma) rdtExt.karma.value = "0"; }
    }
  } catch (e) {
    showToast("Reddit 账号列表加载失败：" + e.message, true);
  }
}

function renderRedditAccounts() {
  if (!rdtExt.tableBody) return;
  const list = rdtExtState.accounts;
  if (!list.length) {
    rdtExt.tableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 24px;">暂无 Reddit 账号记录</td></tr>`;
    return;
  }
  rdtExt.tableBody.innerHTML = list.map(a => {
    const days = a.nurtureStartedAt ? Math.floor((Date.now() - new Date(a.nurtureStartedAt).getTime()) / 86400000) : null;
    const actions = (a.enabledActions || []).map(k => NURTURE_ACTION_LABELS[k]).filter(Boolean);
    const actionsHtml = actions.length
      ? actions.map(label => `<span class="rdt-action-tag">${escapeHtml(label)}</span>`).join("")
      : '<span style="color:var(--text-muted)">未配置</span>';
    return `<tr>
      <td>${escapeHtml(a.profileSeq ?? "—")}</td>
      <td>${escapeHtml(a.profileName)}</td>
      <td>${a.redditUsername ? `<strong>${escapeHtml(a.redditUsername)}</strong>` : '<span style="color:var(--text-muted)">未填写</span>'}</td>
      <td>${a.registeredAt ? escapeHtml(a.registeredAt.substring(0, 10)) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${a.nurtureStartedAt ? `${escapeHtml(a.nurtureStartedAt.substring(0, 10))}${days !== null ? ` <small style="color:var(--text-muted)">(${days}天)</small>` : ""}` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><div class="rdt-action-tags">${actionsHtml}</div></td>
      <td><strong>${a.karmaTotal || 0}</strong>${a.karmaPost || a.karmaComment ? `<br><small style="color:var(--text-muted)">帖${a.karmaPost} 评${a.karmaComment}</small>` : ""}</td>
      <td>${a.notes ? escapeHtml(a.notes) : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>
        <button class="button button-secondary" style="padding:2px 8px;font-size:11px;" onclick="window.editRedditAccount('${escapeHtml(a.id)}')">编辑</button>
        <button class="danger-button data-danger" style="padding:2px 8px;font-size:11px;" onclick="window.deleteRedditAccount('${escapeHtml(a.id)}')">删除</button>
      </td>
    </tr>`;
  }).join("");
}

function fillRdtFormFromAccount(acc) {
  if (!acc) {
    rdtExtState.editingId = null;
    renderRdtActionsGroups([], {});
    return;
  }
  rdtExtState.editingId = acc.id;
  if (rdtExt.bindProfile) rdtExt.bindProfile.value = acc.profileId;
  if (rdtExt.username) rdtExt.username.value = acc.redditUsername || "";
  if (rdtExt.registeredAt) rdtExt.registeredAt.value = acc.registeredAt ? acc.registeredAt.substring(0, 10) : "";
  if (rdtExt.nurtureStartedAt) rdtExt.nurtureStartedAt.value = acc.nurtureStartedAt ? acc.nurtureStartedAt.substring(0, 10) : "";
  if (rdtExt.stage) rdtExt.stage.value = acc.nurtureStage || "week1";
  if (rdtExt.karma) rdtExt.karma.value = acc.karmaTotal || 0;
  if (rdtExt.notes) rdtExt.notes.value = acc.notes || "";
  renderRdtActionsGroups(acc.enabledActions || [], acc.actionConfigs || {});
}

window.editRedditAccount = function(id) {
  const acc = rdtExtState.accounts.find(a => a.id === id);
  if (acc) fillRdtFormFromAccount(acc);
};

window.deleteRedditAccount = async function(id) {
  if (!confirm("确定删除此 Reddit 账号记录吗？")) return;
  try {
    await request(`/api/reddit/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("已删除");
    await refreshRedditAccounts();
  } catch (e) {
    showToast(e.message, true);
  }
};

function populateRdtProfileSelect() {
  if (!rdtExt.bindProfile) return;
  const profiles = (state.profiles || []).filter(p => p.seq != null).sort((a, b) => a.seq - b.seq);
  rdtExt.bindProfile.innerHTML = profiles.map(p =>
    `<option value="${escapeHtml(p.id)}">#${escapeHtml(p.seq)} ${escapeHtml(p.name)}</option>`
  ).join("");
}

if (rdtExt.btnSave) {
  rdtExt.btnSave.addEventListener("click", async () => {
    const profileId = rdtExt.bindProfile?.value;
    if (!profileId) { showToast("请选择实例", true); return; }
    const enabledActions = getSelectedRdtActions();
    try {
      await request("/api/reddit/accounts", {
        method: "POST",
        body: JSON.stringify({
          id: rdtExtState.editingId || undefined,
          profileId,
          redditUsername: rdtExt.username?.value.trim() || "",
          registeredAt: rdtExt.registeredAt?.value || null,
          nurtureStartedAt: rdtExt.nurtureStartedAt?.value || null,
          nurtureStage: rdtExt.stage?.value || "week1",
          karmaTotal: Number(rdtExt.karma?.value) || 0,
          notes: rdtExt.notes?.value.trim() || "",
          enabledActions,
          actionConfigs: getRdtActionConfigs(),
        }),
      });
      showToast("已保存");
      await refreshRedditAccounts();
      const savedProfileId = profileId;
      const acc = rdtExtState.accounts.find(a => a.profileId === savedProfileId);
      if (acc) fillRdtFormFromAccount(acc);
      else fillRdtFormFromAccount(null);
    } catch (e) {
      showToast(e.message, true);
    }
  });
}

if (rdtExt.btnRefresh) {
  rdtExt.btnRefresh.addEventListener("click", refreshRedditAccounts);
}

if (rdtExt.bindProfile) {
  rdtExt.bindProfile.addEventListener("change", () => {
    const profileId = rdtExt.bindProfile.value;
    const acc = rdtExtState.accounts.find(a => a.profileId === profileId);
    if (acc) {
      fillRdtFormFromAccount(acc);
    } else {
      fillRdtFormFromAccount(null);
      if (rdtExt.stage) rdtExt.stage.value = "week1";
      if (rdtExt.karma) rdtExt.karma.value = "0";
    }
  });
}

// ---- TikTok 扩展模块: 账号映射, 素材库, 自动化发布 ----
const tkExt = {
  bindProfileSelect: document.querySelector("#bind-profile-select"),
  bindAccountName: document.querySelector("#bind-account-name"),
  bindRegion: document.querySelector("#bind-region"),
  bindStage: document.querySelector("#bind-stage"),
  btnSaveBind: document.querySelector("#btn-save-account-bind"),
  accountsTableBody: document.querySelector("#tk-accounts-table-body"),
  btnRefreshAccounts: document.querySelector("#tk-refresh-accounts"),

  matTitle: document.querySelector("#mat-title"),
  matFilePath: document.querySelector("#mat-file-path"),
  matHashtags: document.querySelector("#mat-hashtags"),
  matCategory: document.querySelector("#mat-category"),
  btnAddMaterial: document.querySelector("#btn-add-material"),
  materialsList: document.querySelector("#materials-list"),
  btnRefreshMaterials: document.querySelector("#btn-refresh-materials"),

  pubProfileSelect: document.querySelector("#pub-profile-select"),
  pubMaterialSelect: document.querySelector("#pub-material-select"),
  btnCreatePublishJob: document.querySelector("#btn-create-publish-job"),
  publishJobsList: document.querySelector("#publish-jobs-list"),
  btnRefreshPublishJobs: document.querySelector("#btn-refresh-publish-jobs"),
};

const tkExtState = { accounts: [], materials: [], publishJobs: [] };

async function refreshTkAccounts() {
  try {
    const res = await request("/api/tiktok/accounts");
    tkExtState.accounts = res.accounts || [];
    renderTkAccounts();
  } catch (e) {
    showToast("账号映射加载失败：" + e.message, true);
  }
}

function renderTkAccounts() {
  if (!tkExt.accountsTableBody) return;
  const list = tkExtState.accounts;
  if (!list.length) {
    tkExt.accountsTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 20px;">暂无已绑定的 TK 账号映射</td></tr>`;
    return;
  }
  const stageMap = {
    warmup_day1_3: '冷启动 (Day 1-3)',
    interest_building: '兴趣打标 (Day 4-7)',
    high_weight: '权重提升 (Day 8-14)',
    mature: '成熟期账号'
  };
  tkExt.accountsTableBody.innerHTML = list.map(a => `
    <tr>
      <td><strong>${escapeHtml(a.accountName || '未命名')}</strong></td>
      <td>${escapeHtml(a.profileName)}</td>
      <td>${escapeHtml(a.region)}</td>
      <td>${escapeHtml(stageMap[a.nurtureStage] || a.nurtureStage)}</td>
      <td><strong style="color: #4cd964;">${a.healthScore} 分</strong></td>
      <td><span class="status-pill status-${a.status === 'active' ? 'success' : 'loading'}">${escapeHtml(a.status)}</span></td>
      <td>
        <button class="danger-button data-danger" style="padding: 2px 8px; font-size: 11px;" onclick="window.deleteTkAccount('${escapeHtml(a.id)}')">解绑</button>
      </td>
    </tr>
  `).join("");
}

window.deleteTkAccount = async function(id) {
  if (!confirm("确定解绑此 TK 账号映射关系吗？")) return;
  try {
    await request(`/api/tiktok/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("映射记录已删除");
    await refreshTkAccounts();
  } catch (e) {
    showToast(e.message, true);
  }
};

async function refreshTkMaterials() {
  try {
    const res = await request("/api/tiktok/materials");
    tkExtState.materials = res.materials || [];
    renderTkMaterials();
    updatePublishMaterialSelect();
  } catch (e) {
    showToast("素材库加载失败：" + e.message, true);
  }
}

function renderTkMaterials() {
  if (!tkExt.materialsList) return;
  const list = tkExtState.materials;
  if (!list.length) {
    tkExt.materialsList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 15px;">素材库为空</div>`;
    return;
  }
  tkExt.materialsList.innerHTML = list.map(m => `
    <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong style="font-size: 13px;">${escapeHtml(m.title)}</strong>
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">
          <span>路径: ${escapeHtml(m.filePath)}</span>
          ${m.hashtags && m.hashtags.length ? `<span style="margin-left: 8px; color: #58a6ff;">${escapeHtml(m.hashtags.join(' '))}</span>` : ''}
        </div>
      </div>
      <button class="danger-button data-danger" style="padding: 2px 6px; font-size: 11px;" onclick="window.deleteTkMaterial('${escapeHtml(m.id)}')">删除</button>
    </div>
  `).join("");
}

window.deleteTkMaterial = async function(id) {
  try {
    await request(`/api/tiktok/materials/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("素材已删除");
    await refreshTkMaterials();
  } catch (e) {
    showToast(e.message, true);
  }
};

function updatePublishMaterialSelect() {
  if (!tkExt.pubMaterialSelect) return;
  tkExt.pubMaterialSelect.innerHTML = tkExtState.materials.length
    ? tkExtState.materials.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.title)} (${escapeHtml(m.filePath.split(/[/\\]/).pop())})</option>`).join("")
    : `<option value="">请先添加素材</option>`;
}

async function refreshTkPublishJobs() {
  try {
    const res = await request("/api/tiktok/publish/jobs");
    tkExtState.publishJobs = res.jobs || [];
    renderTkPublishJobs();
  } catch (e) {
    showToast("发布任务队列加载失败：" + e.message, true);
  }
}

function renderTkPublishJobs() {
  if (!tkExt.publishJobsList) return;
  const list = tkExtState.publishJobs;
  if (!list.length) {
    tkExt.publishJobsList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 15px;">无待执行的发布任务</div>`;
    return;
  }
  const statusColor = { pending: '#e3b341', running: '#58a6ff', success: '#3fb950', failed: '#f85149' };
  const statusText = { pending: '等待发布', running: '正在上传发布...', success: '发布成功', failed: '发布失败' };

  tkExt.publishJobsList.innerHTML = list.map(j => `
    <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <strong style="font-size: 13px;">${escapeHtml(j.materialTitle || '素材 #' + j.materialId)}</strong>
          <span style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.1); color: ${statusColor[j.status] || '#fff'}; font-weight: bold;">${statusText[j.status] || j.status}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">
          发布目标: <strong>${escapeHtml(j.accountName)}</strong> (${escapeHtml(j.profileName)})
          ${j.errorMessage ? `<span style="color: #f85149; margin-left: 8px;">错误: ${escapeHtml(j.errorMessage)}</span>` : ''}
          ${j.publishedVideoUrl ? `<a href="${escapeHtml(j.publishedVideoUrl)}" target="_blank" style="color: #58a6ff; margin-left: 8px;">查看视频</a>` : ''}
        </div>
      </div>
      <div style="display: flex; gap: 6px;">
        ${j.status !== 'running' ? `<button class="button button-primary" style="padding: 2px 8px; font-size: 11px;" onclick="window.triggerExecutePublishJob('${escapeHtml(j.id)}')">立即发布</button>` : ''}
        <button class="danger-button data-danger" style="padding: 2px 6px; font-size: 11px;" onclick="window.deleteTkPublishJob('${escapeHtml(j.id)}')">删除</button>
      </div>
    </div>
  `).join("");
}

window.triggerExecutePublishJob = async function(id) {
  try {
    await request(`/api/tiktok/publish/jobs/${encodeURIComponent(id)}/execute`, { method: "POST" });
    showToast("已启动全自动视频发布过程");
    setTimeout(refreshTkPublishJobs, 1500);
  } catch (e) {
    showToast(e.message, true);
  }
};

window.deleteTkPublishJob = async function(id) {
  try {
    await request(`/api/tiktok/publish/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("发布任务已删除");
    await refreshTkPublishJobs();
  } catch (e) {
    showToast(e.message, true);
  }
};

async function initTiktokExt() {
  await Promise.all([
    refreshTkAccounts(),
    refreshTkMaterials(),
    refreshTkPublishJobs()
  ]);

  if (tkExt.bindProfileSelect && state.profiles) {
    const optionsHtml = state.profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.seq ?? '?'})</option>`).join('');
    tkExt.bindProfileSelect.innerHTML = optionsHtml;
    if (tkExt.pubProfileSelect) tkExt.pubProfileSelect.innerHTML = optionsHtml;
  }
}

// 绑定保存账号映射事件
tkExt.btnSaveBind?.addEventListener("click", async () => {
  const profileId = tkExt.bindProfileSelect.value;
  const accountName = tkExt.bindAccountName.value.trim();
  const region = tkExt.bindRegion.value;
  const nurtureStage = tkExt.bindStage.value;

  if (!profileId) { showToast("请选择目标实例", true); return; }
  try {
    await request("/api/tiktok/accounts", {
      method: "POST",
      body: JSON.stringify({ profileId, accountName, region, nurtureStage })
    });
    showToast("TK 账号与实例绑定已保存");
    tkExt.bindAccountName.value = "";
    await refreshTkAccounts();
  } catch (e) {
    showToast(e.message, true);
  }
});

// 存入素材库事件
tkExt.btnAddMaterial?.addEventListener("click", async () => {
  const title = tkExt.matTitle.value.trim();
  const filePath = tkExt.matFilePath.value.trim();
  const rawTags = tkExt.matHashtags.value.trim();
  const category = tkExt.matCategory.value.trim();

  if (!title || !filePath) { showToast("标题和文件路径为必填项", true); return; }
  const hashtags = rawTags ? rawTags.split(/\s+/).filter(Boolean) : [];

  try {
    await request("/api/tiktok/materials", {
      method: "POST",
      body: JSON.stringify({ title, filePath, hashtags, category })
    });
    showToast("已存入视频素材库");
    tkExt.matTitle.value = "";
    tkExt.matFilePath.value = "";
    tkExt.matHashtags.value = "";
    await refreshTkMaterials();
  } catch (e) {
    showToast(e.message, true);
  }
});

// 创建发布任务事件
tkExt.btnCreatePublishJob?.addEventListener("click", async () => {
  const profileId = tkExt.pubProfileSelect.value;
  const materialId = tkExt.pubMaterialSelect.value;

  if (!profileId || !materialId) { showToast("必须选择实例和对应的视频素材", true); return; }
  try {
    await request("/api/tiktok/publish/jobs", {
      method: "POST",
      body: JSON.stringify({ profileId, materialId })
    });
    showToast("自动发布任务已加入队列");
    await refreshTkPublishJobs();
  } catch (e) {
    showToast(e.message, true);
  }
});

tkExt.btnRefreshAccounts?.addEventListener("click", refreshTkAccounts);
tkExt.btnRefreshMaterials?.addEventListener("click", refreshTkMaterials);
tkExt.btnRefreshPublishJobs?.addEventListener("click", refreshTkPublishJobs);

async function initTiktok() {
  try {
    const [cfg, profilesPayload] = await Promise.all([
      request("/api/tiktok/config"),
      request("/api/profiles"),
    ]);
    state.tiktokJobs = cfg.jobs || [];
    state.tiktokConfig = cfg.saved || cfg.defaults;
    if (profilesPayload.profiles && profilesPayload.profiles.length > 0) {
      state.profiles = profilesPayload.profiles;
    }
    applyTiktokOptions(cfg.saved || cfg.defaults || {});
    populateTkProfileCheckboxes();
    loadTkOptionsForScope();
    renderTiktokJobs();
    await refreshTiktokData();
    await initTiktokExt();
  } catch (e) {
    showToast("TikTok 初始化失败：" + e.message, true);
    populateTkProfileCheckboxes();
  }
}

tk.resetBtn.addEventListener("click", () => {
  applyTiktokOptions(TK_FALLBACK);
  scheduleTiktokSave();
  showToast("已恢复 TikTok 默认参数");
});

let tkSaveTimer = null;
function scheduleTiktokSave() {
  clearTimeout(tkSaveTimer);
  tkSaveTimer = setTimeout(async () => {
    try {
      const options = collectTiktokOptions();
      if (tkScopeState.scope === "global") {
        await request("/api/tiktok/settings", { method: "PUT", body: JSON.stringify({ profileId: null, options }) });
      } else {
        const ids = tkScopeState.selectedProfileIds;
        if (ids.length === 0) return;
        if (ids.length === 1) {
          await request("/api/tiktok/settings", { method: "PUT", body: JSON.stringify({ profileId: ids[0], options }) });
        } else {
          await request("/api/tiktok/settings/batch", { method: "PUT", body: JSON.stringify({ profileIds: ids, options }) });
        }
      }
    } catch {}
  }, 800);
}
document.querySelector("#tk-options-form")?.addEventListener("input", scheduleTiktokSave);

function getTkTargetProfileIds() {
  if (tkScopeState.scope === "global") {
    return (state.profiles || []).filter(p => p.seq != null).map(p => p.id);
  }
  return tkScopeState.selectedProfileIds;
}

tk.startBtn.addEventListener("click", async () => {
  const ids = getTkTargetProfileIds();
  if (ids.length === 0) { showToast("请先选择实例或切换到全局模式", true); return; }
  const options = collectTiktokOptions();
  let ok = 0, fail = 0;
  for (const profileId of ids) {
    try {
      await request(`/api/tiktok/jobs/${encodeURIComponent(profileId)}/start`, { method: "POST", body: JSON.stringify({ options }) });
      ok++;
    } catch { fail++; }
  }
  showToast(`已启动 ${ok} 个实例${fail ? `，${fail} 个失败` : ""}`, fail > 0);
});

tk.startAllBtn.addEventListener("click", async () => {
  const allIds = (state.profiles || []).filter(p => p.seq != null).map(p => p.id);
  if (allIds.length === 0) { showToast("没有可用实例", true); return; }
  const options = collectTiktokOptions();
  let ok = 0, fail = 0;
  for (const profileId of allIds) {
    try {
      await request(`/api/tiktok/jobs/${encodeURIComponent(profileId)}/start`, { method: "POST", body: JSON.stringify({ options }) });
      ok++;
    } catch { fail++; }
  }
  showToast(`已启动 ${ok} 个实例${fail ? `，${fail} 个失败` : ""}`, fail > 0);
});

tk.stopBtn.addEventListener("click", async () => {
  const ids = getTkTargetProfileIds();
  if (ids.length === 0) { showToast("请先选择实例或切换到全局模式", true); return; }
  let ok = 0;
  for (const profileId of ids) {
    try {
      await request(`/api/tiktok/jobs/${encodeURIComponent(profileId)}/stop`, { method: "POST", body: "{}" });
      ok++;
    } catch {}
  }
  showToast(`已停止 ${ok} 个实例`);
});

tk.stopAllBtn.addEventListener("click", async () => {
  try {
    await request("/api/tiktok/jobs/stop-all", { method: "POST", body: "{}" });
    showToast("已停止全部 TikTok 任务");
  } catch (e) {
    showToast(e.message, true);
  }
});

tk.refreshData.addEventListener("click", () => refreshTiktokData());

for (const btn of document.querySelectorAll("[data-tk-tab]")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll("[data-tk-tab]")) {
      b.classList.toggle("active", b === btn);
    }
    const tab = btn.dataset.tkTab;
    tk.historyView.classList.toggle("hidden", tab !== "history");
    tk.logsView.classList.toggle("hidden", tab !== "logs");
  });
}

for (const btn of document.querySelectorAll(".platform-tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".platform-tab")) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    }
    const platform = btn.dataset.platform;
    document.querySelectorAll(".reddit-tab").forEach((el) => el.classList.toggle("hidden", platform !== "reddit"));
    document.querySelectorAll(".tiktok-tab").forEach((el) => el.classList.toggle("hidden", platform !== "tiktok"));
    document.querySelectorAll(".remix-tab").forEach((el) => el.classList.toggle("hidden", platform !== "remix"));
    document.querySelectorAll(".cdp-tab").forEach((el) => el.classList.toggle("hidden", platform !== "cdp"));
    document.querySelectorAll(".matrix-tab").forEach((el) => el.classList.toggle("hidden", platform !== "matrix"));
    document.querySelectorAll(".scheduler-tab").forEach((el) => el.classList.toggle("hidden", platform !== "scheduler"));
    if (platform === "cdp") { refreshCdpInstances(); refreshNgrokStatus(); }
    if (platform === "matrix") { fetchMatrices(); }
  });
}

// ---- 轮换调度 ----
const sched = {
  startBtn: document.querySelector("#sched-start"),
  stopBtn: document.querySelector("#sched-stop"),
  status: document.querySelector("#sched-status"),
};

function formatRemaining(ms) {
  if (!ms || ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const PHASE_LABELS = {
  idle: "空闲", starting: "启动中", switching: "切换实例", opening: "打开浏览器",
  running: "养号中", stopping: "停止任务", finishing: "收尾", completed: "已完成", stopped: "已停止", error: "出错",
};

function schedPlatformHint() {
  const r = document.querySelector("#sched-enable-reddit")?.checked ?? true;
  const t = document.querySelector("#sched-enable-tiktok")?.checked ?? true;
  if (r && t) return "Reddit 与 TikTok 任务并发调度";
  if (r) return "仅 Reddit 任务";
  if (t) return "仅 TikTok 任务";
  return "未选择任何平台";
}

function saveSchedToggles() {
  const r = document.querySelector("#sched-enable-reddit");
  const t = document.querySelector("#sched-enable-tiktok");
  const g = document.querySelector("#sched-geo-priority");
  if (r) localStorage.setItem("sched-enable-reddit", r.checked ? "1" : "0");
  if (t) localStorage.setItem("sched-enable-tiktok", t.checked ? "1" : "0");
  if (g) localStorage.setItem("sched-geo-priority", g.checked ? "1" : "0");
}

function getSchedProfileIds() {
  try { return JSON.parse(localStorage.getItem("sched-profile-ids") || "[]"); } catch { return []; }
}

function saveSchedProfileIds(ids) {
  localStorage.setItem("sched-profile-ids", JSON.stringify(ids));
}

function renderSchedProfiles() {
  const container = document.querySelector("#sched-profile-list");
  if (!container) return;
  const profiles = state.profiles
    .filter((p) => p.seq != null)
    .sort((a, b) => a.seq - b.seq);
  if (!profiles.length) {
    container.innerHTML = '<div class="empty-state compact">未获取到实例列表，请确认 BitBrowser 已连接</div>';
    return;
  }
  const saved = new Set(getSchedProfileIds());
  const allChecked = saved.size === 0;
  container.innerHTML = profiles
    .map((p) => {
      const checked = allChecked || saved.has(p.id);
      return `<label class="sched-profile-check">
        <input type="checkbox" value="${escapeHtml(p.id)}" ${checked ? "checked" : ""} />
        <span class="sched-seq">#${escapeHtml(p.seq)}</span>
        <span class="sched-name">${escapeHtml(p.name)}</span>
        ${p.remark ? `<span class="sched-remark" title="BitBrowser备注：目标城市/邮编">${escapeHtml(p.remark)}</span>` : ""}
      </label>`;
    })
    .join("");
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const ids = [...container.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
      saveSchedProfileIds(ids);
      updateSchedSelectAllBtn();
    });
  });
  updateSchedSelectAllBtn();

  const checkSelect = document.querySelector("#sched-check-profile");
  if (checkSelect) {
    const prev = checkSelect.value;
    checkSelect.innerHTML = profiles
      .map((p) => `<option value="${escapeHtml(p.id)}">#${escapeHtml(p.seq)} ${escapeHtml(p.name)}</option>`)
      .join("");
    if (prev && profiles.some((p) => p.id === prev)) checkSelect.value = prev;
  }
}

function updateSchedSelectAllBtn() {
  const container = document.querySelector("#sched-profile-list");
  const btn = document.querySelector("#sched-select-all");
  if (!container || !btn) return;
  const checks = container.querySelectorAll('input[type="checkbox"]');
  const checked = container.querySelectorAll('input[type="checkbox"]:checked');
  btn.textContent = checks.length > 0 && checked.length === checks.length ? "取消全选" : "全选";
}

function restoreSchedToggles() {
  const r = document.querySelector("#sched-enable-reddit");
  const t = document.querySelector("#sched-enable-tiktok");
  const g = document.querySelector("#sched-geo-priority");
  if (r) r.checked = localStorage.getItem("sched-enable-reddit") !== "0";
  if (t) t.checked = localStorage.getItem("sched-enable-tiktok") !== "0";
  if (g) g.checked = localStorage.getItem("sched-geo-priority") === "1";
}

function renderScheduler() {
  const s = state.scheduler;
  if (!s) return;
  sched.startBtn.disabled = s.running;
  sched.stopBtn.disabled = !s.running;
  if (!s.running && (s.phase === "idle" || !s.phase)) {
    sched.status.innerHTML = `<div class="empty-state compact">未启动轮换调度。点击「启动轮换」按序号 1→10 依次养号，每个实例随机 23-35 分钟，${schedPlatformHint()}。</div>`;
    return;
  }
  const progress = s.totalProfiles > 0 ? `${s.profileIndex + 1} / ${s.totalProfiles}` : "-";
  const current = s.currentSeq ? `#${s.currentSeq} ${escapeHtml(s.currentName || "")}` : "-";
  const remaining = s.running && s.remainingMs > 0 ? formatRemaining(s.remainingMs) : "—";
  const logs = (s.log || []).slice(-50).reverse().map((l) => `<li class="log-item log-${escapeHtml(l.level)}"><span class="log-time">${formatDateTime(l.at)}</span><span class="log-level">${escapeHtml(l.level)}</span><span class="log-msg">${escapeHtml(l.message)}</span></li>`).join("");
  const ipChange = s.ipChange
    ? `<div class="sched-ip-change"><span>代理IP</span><strong><span class="ip-old">${escapeHtml(s.ipChange.old || "—")}</span><span class="ip-arrow">→</span><span class="ip-new">${escapeHtml(s.ipChange.new || "未知")}</span></strong>${s.ipChange.city ? `<span class="ip-geo">📍 ${escapeHtml(s.ipChange.city)}（${escapeHtml(s.ipChange.zip)}）${s.ipChange.region ? ` ${escapeHtml(s.ipChange.region)}` : ""}</span>` : ""}</div>`
    : "";

  const pid = s.currentProfileId;
  const redditJob = pid ? state.jobs.find((j) => j.profileId === pid) : null;
  const tiktokJob = pid ? (state.tiktokJobs || []).find((j) => j.profileId === pid) : null;
  let jobDetails = "";
  if (redditJob || tiktokJob) {
    const sections = [];
    if (redditJob) {
      const rLogs = (redditJob.logs || []).slice(-15).map((l) =>
        `<li class="log-item log-${escapeHtml(l.level || "info")}"><span class="log-time">${formatDateTime(l.time)}</span><span class="log-msg">${escapeHtml(l.message)}</span></li>`,
      ).join("");
      sections.push(`<div class="sched-job-section">
        <div class="sched-job-head"><span class="sched-job-tag tag-reddit">Reddit</span>${escapeHtml(workflowPhaseLabel(redditJob))} · 帖子 ${formatNumber(redditJob.postCount)} · 详情 ${formatNumber(redditJob.detailVisitCount)}${Number(redditJob.autoUpvoteCount) > 0 ? ` · 自动赞 ${formatNumber(redditJob.autoUpvoteCount)}` : ""}${Number(redditJob.autoJoinCount) > 0 ? ` · 关注 ${formatNumber(redditJob.autoJoinCount)}` : ""}</div>
        ${rLogs ? `<ol class="database-log-list sched-job-log">${rLogs}</ol>` : ""}
      </div>`);
    }
    if (tiktokJob) {
      const tkInfo = `${escapeHtml(tiktokJob.statusText || tiktokJob.status)} · 视频 ${tiktokJob.videoCount} · 点赞 ${tiktokJob.likeCount} · 评论 ${tiktokJob.commentCount}`;
      const tkLogs = (tiktokJob.logs || []).slice(-15).map((l) =>
        `<li class="log-item log-${escapeHtml(l.level || "info")}"><span class="log-time">${formatDateTime(l.at)}</span><span class="log-msg">${escapeHtml(l.message)}</span></li>`,
      ).join("");
      sections.push(`<div class="sched-job-section">
        <div class="sched-job-head"><span class="sched-job-tag tag-tiktok">TikTok</span>${tkInfo}</div>
        ${tiktokJob.currentVideo ? `<div class="sched-job-sub">当前：${escapeHtml(tiktokJob.currentVideo.author || "")}${tiktokJob.currentVideo.likeCount ? ` · ${escapeHtml(tiktokJob.currentVideo.likeCount)}` : ""}</div>` : ""}
        ${tiktokJob.error ? `<div class="sched-job-error">${escapeHtml(tiktokJob.error)}</div>` : ""}
        ${tkLogs ? `<ol class="database-log-list sched-job-log">${tkLogs}</ol>` : ""}
      </div>`);
    }
    jobDetails = `<div class="sched-job-details">${sections.join("")}</div>`;
  }

  sched.status.innerHTML = `
    <div class="sched-grid">
      <div class="sched-stat"><span>进度</span><strong>${progress}</strong></div>
      <div class="sched-stat"><span>当前实例</span><strong>${current}</strong></div>
      <div class="sched-stat"><span>阶段</span><strong>${PHASE_LABELS[s.phase] || s.phase}</strong></div>
      <div class="sched-stat"><span>剩余</span><strong>${remaining}</strong></div>
    </div>
    ${ipChange}
    ${logs ? `<ol class="database-log-list sched-log">${logs}</ol>` : ""}
    ${jobDetails}`;
}

async function initScheduler() {
  try {
    restoreSchedToggles();
    const res = await request("/api/scheduler/status");
    state.scheduler = res.status;
    const proxyInput = document.querySelector("#sched-proxy-url");
    if (proxyInput) {
      const saved = localStorage.getItem("sched-proxy-url");
      proxyInput.value = saved ?? res.proxyRotateUrl ?? "";
    }
    renderScheduler();
  } catch (e) {
    showToast("调度器初始化失败：" + e.message, true);
  }
}

document.querySelector("#sched-enable-reddit")?.addEventListener("change", () => { saveSchedToggles(); renderScheduler(); });
document.querySelector("#sched-enable-tiktok")?.addEventListener("change", () => { saveSchedToggles(); renderScheduler(); });
document.querySelector("#sched-geo-priority")?.addEventListener("change", () => { saveSchedToggles(); renderScheduler(); });
document.querySelector("#sched-proxy-url")?.addEventListener("input", () => {
  localStorage.setItem("sched-proxy-url", document.querySelector("#sched-proxy-url").value);
});

document.querySelector("#sched-check-ip")?.addEventListener("click", async () => {
  const resultEl = document.querySelector("#sched-check-ip-result");
  const btn = document.querySelector("#sched-check-ip");
  const profileSelect = document.querySelector("#sched-check-profile");
  const profileId = profileSelect?.value;
  if (!profileId) {
    resultEl.textContent = "请先选择实例";
    resultEl.className = "sched-check-result sched-check-error";
    return;
  }
  btn.disabled = true;
  resultEl.textContent = "正在检测…";
  resultEl.className = "sched-check-result muted-activity";
  try {
    const res = await request("/api/scheduler/check-ip", {
      method: "POST",
      body: JSON.stringify({ profileId }),
    });
    if (res.error && !res.host) {
      resultEl.textContent = res.error;
      resultEl.className = "sched-check-result sched-check-error";
    } else if (res.ip) {
      const changed = res.lastIp && res.ip !== res.lastIp;
      const geoInfo = res.city ? ` | 📍 ${escapeHtml(res.city)}（${escapeHtml(res.zip)}）${res.region ? `，${escapeHtml(res.region)}` : ""}` : "";
      const remarkInfo = res.remark ? ` | 备注：${escapeHtml(res.remark)}` : "";
      resultEl.innerHTML = `IP：<strong>${escapeHtml(res.ip)}</strong>${geoInfo}${remarkInfo}（${res.durationMs}ms）${res.lastIp ? ` | 上次：${escapeHtml(res.lastIp)} ${changed ? "→ 已变化" : "→ 未变化"}` : ""} | ${escapeHtml(res.proxyType)} ${escapeHtml(res.host)}:${res.port}`;
      resultEl.className = `sched-check-result sched-check-${changed ? "ok" : "warn"}`;
    } else {
      resultEl.innerHTML = `检测失败：${escapeHtml(res.error || "未知错误")}（${res.durationMs}ms）| ${escapeHtml(res.proxyType || "?")} ${escapeHtml(res.host || "?")}:${res.port || "?"}`;
      resultEl.className = "sched-check-result sched-check-error";
    }
  } catch (e) {
    resultEl.textContent = `请求失败：${e.message}`;
    resultEl.className = "sched-check-result sched-check-error";
  } finally {
    btn.disabled = false;
  }
});

document.querySelector("#sched-select-all")?.addEventListener("click", () => {
  const container = document.querySelector("#sched-profile-list");
  const checks = container.querySelectorAll('input[type="checkbox"]');
  if (!checks.length) return;
  const allChecked = [...checks].every((cb) => cb.checked);
  checks.forEach((cb) => (cb.checked = !allChecked));
  const ids = [...container.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
  saveSchedProfileIds(ids);
  updateSchedSelectAllBtn();
});

sched.startBtn.addEventListener("click", async () => {
  try {
    const proxyRotateUrl = document.querySelector("#sched-proxy-url")?.value.trim() || "";
    const enableReddit = document.querySelector("#sched-enable-reddit")?.checked ?? true;
    const enableTiktok = document.querySelector("#sched-enable-tiktok")?.checked ?? true;
    const profileIds = [...document.querySelectorAll("#sched-profile-list input[type=checkbox]:checked")].map((cb) => cb.value);
    const ipMatchMode = document.querySelector("#sched-geo-priority")?.checked ? "geo_priority" : "sequential";
    const options = { enableReddit, enableTiktok, profileIds, ipMatchMode };
    if (proxyRotateUrl) options.proxyRotateUrl = proxyRotateUrl;
    const res = await request("/api/scheduler/start", { method: "POST", body: JSON.stringify({ options }) });
    state.scheduler = res.status;
    renderScheduler();
    showToast("轮换调度已启动");
  } catch (e) {
    showToast(e.message, true);
  }
});

sched.stopBtn.addEventListener("click", async () => {
  try {
    const res = await request("/api/scheduler/stop", { method: "POST", body: "{}" });
    state.scheduler = res.status;
    renderScheduler();
    showToast("已请求停止轮换调度");
  } catch (e) {
    showToast(e.message, true);
  }
});

// ==========================================================================
// 视频素材库模块 - 拖拽上传 / 自动解析 / 多账号快速发布
// ==========================================================================

const mat = {
  dropZone: document.querySelector("#material-drop-zone"),
  fileInput: document.querySelector("#mat-file-input"),
  titleInput: document.querySelector("#mat-title"),
  filePathInput: document.querySelector("#mat-file-path"),
  hashtagsInput: document.querySelector("#mat-hashtags"),
  categoryInput: document.querySelector("#mat-category"),
  addBtn: document.querySelector("#btn-add-material"),
  refreshBtn: document.querySelector("#btn-refresh-materials"),
  list: document.querySelector("#materials-list"),
};

const pubDialog = {
  el: document.querySelector("#quick-publish-dialog"),
  matTitle: document.querySelector("#quick-pub-mat-title"),
  matPath: document.querySelector("#quick-pub-mat-path"),
  matTags: document.querySelector("#quick-pub-mat-tags"),
  accountList: document.querySelector("#pub-account-list"),
  selectAllBtn: document.querySelector("#pub-select-all"),
  deselectAllBtn: document.querySelector("#pub-deselect-all"),
  privacySelect: document.querySelector("#pub-privacy"),
  scheduledAtInput: document.querySelector("#pub-scheduled-at"),
  confirmBtn: document.querySelector("#btn-confirm-publish"),
};

let currentPubMaterialId = null;
let tkAccountsCache = [];

function parseFileNameMeta(filename) {
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "").trim();
  const hashtagMatches = nameWithoutExt.match(/#[\w\u4e00-\u9fa5]+/g) || [];
  const hashtags = hashtagMatches.map((t) => t.trim());
  let title = nameWithoutExt.replace(/#[\w\u4e00-\u9fa5]+/g, "").trim();
  title = title.replace(/[-_]+$/, "").replace(/^[-_]+/, "").replace(/\s+/g, " ").trim();
  if (!title) title = nameWithoutExt;
  return { title, hashtags };
}

async function handleFilesDrop(files) {
  if (!files || files.length === 0) return;
  if (files.length === 1) {
    const file = files[0];
    const { title, hashtags } = parseFileNameMeta(file.name);
    if (mat.titleInput) mat.titleInput.value = title;
    if (mat.hashtagsInput) mat.hashtagsInput.value = hashtags.join(" ");
    if (mat.filePathInput) mat.filePathInput.value = file.name;
    showToast("已自动解析文件名：" + title);
  } else {
    let successCount = 0;
    for (const file of files) {
      const { title, hashtags } = parseFileNameMeta(file.name);
      try {
        await request("/api/tiktok/materials", {
          method: "POST",
          body: JSON.stringify({ title, filePath: file.name, hashtags, category: "general" }),
        });
        successCount++;
      } catch { /* 单个失败不阻断 */ }
    }
    showToast("批量导入 " + successCount + " 个素材，请逐一补全绝对路径");
    await loadMaterials();
  }
}

function renderMaterials(materials) {
  if (!mat.list) return;
  if (!materials || materials.length === 0) {
    mat.list.innerHTML = "<div class=\"empty-state compact\">素材库尚无内容，请上传视频文件或手动录入</div>";
    return;
  }
  mat.list.innerHTML = materials.map((m) => {
    const tags = (m.hashtags || []).map((t) => `<span class="material-tag">${escapeHtml(t)}</span>`).join("");
    const shortPath = m.filePath ? m.filePath.replace(/^.*[\\\/]/, "") : "—";
    const safeTagsJson = escapeHtml(JSON.stringify(m.hashtags || []));
    return `<div class="material-card">
      <div class="material-info">
        <span class="material-title">${escapeHtml(m.title)}</span>
        <div class="material-meta"><span>📂 ${escapeHtml(shortPath)}</span>${m.category ? `<span>· ${escapeHtml(m.category)}</span>` : ""}</div>
        ${tags ? `<div class="material-tags" style="margin-top:5px;">${tags}</div>` : ""}
      </div>
      <div class="material-actions">
        <button class="button button-primary btn-qp"
          data-mid="${escapeHtml(m.id)}" data-mtitle="${escapeHtml(m.title)}"
          data-mpath="${escapeHtml(m.filePath || "")}" data-mtags="${safeTagsJson}"
          style="font-size:12px;padding:0 12px;min-height:32px;white-space:nowrap;">🚀 发布</button>
        <button class="danger-button btn-del-mat" data-mid="${escapeHtml(m.id)}"
          style="font-size:11px;padding:5px 10px;">删除</button>
      </div>
    </div>`;
  }).join("");

  mat.list.querySelectorAll(".btn-qp").forEach((btn) => {
    btn.addEventListener("click", () => openQuickPublishDialog(btn.dataset));
  });
  mat.list.querySelectorAll(".btn-del-mat").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("确认删除此素材？")) return;
      try {
        await request("/api/tiktok/materials/" + encodeURIComponent(btn.dataset.mid), { method: "DELETE" });
        showToast("素材已删除");
        await loadMaterials();
      } catch (e) { showToast(e.message, true); }
    });
  });
}

async function loadMaterials() {
  try {
    const res = await request("/api/tiktok/materials");
    renderMaterials(res.materials || []);
  } catch (e) {
    if (mat.list) mat.list.innerHTML = `<div class="empty-state compact" style="color:var(--red);">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

if (mat.dropZone) {
  mat.dropZone.addEventListener("click", () => mat.fileInput && mat.fileInput.click());
  mat.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); mat.dropZone.classList.add("dragover"); });
  mat.dropZone.addEventListener("dragleave", () => mat.dropZone.classList.remove("dragover"));
  mat.dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    mat.dropZone.classList.remove("dragover");
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)$/i.test(f.name));
    if (!files.length) { showToast("请拖入视频文件", true); return; }
    await handleFilesDrop(files);
  });
}

if (mat.fileInput) {
  mat.fileInput.addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    if (files.length > 0) await handleFilesDrop(files);
    e.target.value = "";
  });
}

if (mat.addBtn) {
  mat.addBtn.addEventListener("click", async () => {
    const title = mat.titleInput && mat.titleInput.value.trim();
    const filePath = mat.filePathInput && mat.filePathInput.value.trim();
    if (!title || !filePath) { showToast("请填写标题与视频路径", true); return; }
    const hashtagsRaw = (mat.hashtagsInput && mat.hashtagsInput.value.trim()) || "";
    const hashtags = hashtagsRaw.split(/\s+/).filter((t) => t.startsWith("#"));
    const category = (mat.categoryInput && mat.categoryInput.value.trim()) || "general";
    try {
      mat.addBtn.disabled = true;
      mat.addBtn.textContent = "保存中...";
      await request("/api/tiktok/materials", {
        method: "POST",
        body: JSON.stringify({ title, filePath, hashtags, category }),
      });
      showToast("素材已保存到素材库");
      if (mat.titleInput) mat.titleInput.value = "";
      if (mat.filePathInput) mat.filePathInput.value = "";
      if (mat.hashtagsInput) mat.hashtagsInput.value = "";
      if (mat.categoryInput) mat.categoryInput.value = "";
      await loadMaterials();
    } catch (e) {
      showToast(e.message, true);
    } finally {
      mat.addBtn.disabled = false;
      mat.addBtn.textContent = "保存素材录入";
    }
  });
}

if (mat.refreshBtn) {
  mat.refreshBtn.addEventListener("click", () => loadMaterials());
}

function openQuickPublishDialog(dataset) {
  currentPubMaterialId = dataset.mid;
  if (pubDialog.matTitle) pubDialog.matTitle.textContent = dataset.mtitle || "";
  if (pubDialog.matPath) pubDialog.matPath.textContent = dataset.mpath || "";
  if (pubDialog.matTags) {
    try {
      const tags = JSON.parse(dataset.mtags || "[]");
      pubDialog.matTags.innerHTML = tags.map((t) => `<span class="material-tag">${escapeHtml(t)}</span>`).join("");
    } catch { pubDialog.matTags.innerHTML = ""; }
  }
  renderPubAccountList();
  if (pubDialog.el) pubDialog.el.showModal();
}

function renderPubAccountList() {
  if (!pubDialog.accountList) return;
  if (!tkAccountsCache.length) {
    pubDialog.accountList.innerHTML = "<div class=\"empty-state compact\">暂无绑定 TikTok 账号，请先在账号矩阵模块绑定账号</div>";
    return;
  }
  pubDialog.accountList.innerHTML = tkAccountsCache.map((acc) => `
    <label class="pub-account-item">
      <input type="checkbox" name="pub-account" value="${escapeHtml(acc.profileId)}" />
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);">${escapeHtml(acc.accountName || acc.profileName || acc.profileId)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
          实例: ${escapeHtml(acc.profileName || acc.profileId)} · 地区: ${escapeHtml(acc.region || "US")}
          · <span style="color:${acc.status === "active" ? "var(--green-dark)" : "var(--amber-dark)"}">
              ${acc.status === "active" ? "✓ 活跃" : "⚠ " + escapeHtml(acc.status || "—")}
            </span>
        </div>
      </div>
    </label>`).join("");

  pubDialog.accountList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const item = cb.closest(".pub-account-item");
      if (item) item.classList.toggle("selected", cb.checked);
    });
  });
}

if (pubDialog.selectAllBtn) {
  pubDialog.selectAllBtn.addEventListener("click", () => {
    if (!pubDialog.accountList) return;
    pubDialog.accountList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = true;
      const item = cb.closest(".pub-account-item");
      if (item) item.classList.add("selected");
    });
  });
}

if (pubDialog.deselectAllBtn) {
  pubDialog.deselectAllBtn.addEventListener("click", () => {
    if (!pubDialog.accountList) return;
    pubDialog.accountList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = false;
      const item = cb.closest(".pub-account-item");
      if (item) item.classList.remove("selected");
    });
  });
}

if (pubDialog.confirmBtn) {
  pubDialog.confirmBtn.addEventListener("click", async () => {
    if (!currentPubMaterialId) return;
    const checked = pubDialog.accountList
      ? [...pubDialog.accountList.querySelectorAll("input[type=checkbox]:checked")]
      : [];
    if (!checked.length) { showToast("请至少选择一个发布账号", true); return; }
    const scheduledAt = pubDialog.scheduledAtInput && pubDialog.scheduledAtInput.value
      ? new Date(pubDialog.scheduledAtInput.value).toISOString()
      : null;
    pubDialog.confirmBtn.disabled = true;
    pubDialog.confirmBtn.textContent = "⏳ 创建发布任务中...";
    let successCount = 0;
    const errors = [];
    for (const inp of checked) {
      const profileId = inp.value;
      const acc = tkAccountsCache.find((a) => a.profileId === profileId);
      try {
        const jobRes = await request("/api/tiktok/publish/jobs", {
          method: "POST",
          body: JSON.stringify({
            profileId,
            accountId: acc ? acc.id : profileId,
            materialId: currentPubMaterialId,
            ...(scheduledAt ? { scheduledAt } : {}),
          }),
        });
        if (!scheduledAt && jobRes.job && jobRes.job.id) {
          await request("/api/tiktok/publish/jobs/" + encodeURIComponent(jobRes.job.id) + "/execute", {
            method: "POST", body: "{}",
          }).catch(() => {});
        }
        successCount++;
      } catch (e) { errors.push(e.message); }
    }
    pubDialog.confirmBtn.disabled = false;
    pubDialog.confirmBtn.textContent = "🚀 确认发布到选中账号";
    if (successCount > 0) {
      showToast("已为 " + successCount + " 个账号创建发布任务");
      if (pubDialog.el) pubDialog.el.close();
    }
    if (errors.length > 0) {
      showToast(errors.length + " 个账号创建失败：" + errors[0], true);
    }
  });
}

async function loadTkAccountsForPub() {
  try {
    const res = await request("/api/tiktok/accounts");
    tkAccountsCache = res.accounts || [];
  } catch { tkAccountsCache = []; }
}

loadMaterials();
loadTkAccountsForPub();

// ==========================================================================
// 视频去重与混剪模块
// ==========================================================================

const remix = {
  creators: [],
  videos: [],
  tasks: [],
  resources: [],
  selectedCreatorId: null,
  selectedVideos: [],
  pollTimer: null,
  page: 1,
  pageSize: 12,
  viewMode: localStorage.getItem("remix-view-mode") || "grid",
};

const remixEl = {
  creatorsList: document.querySelector("#remix-creators-list"),
  addCreatorBtn: document.querySelector("#remix-add-creator-btn"),
  addCreatorForm: document.querySelector("#remix-add-creator-form"),
  creatorName: document.querySelector("#remix-creator-name"),
  creatorPlatform: document.querySelector("#remix-creator-platform"),
  confirmCreator: document.querySelector("#remix-confirm-creator"),
  cancelCreator: document.querySelector("#remix-cancel-creator"),
  currentCreator: document.querySelector("#remix-current-creator"),
  videoCount: document.querySelector("#remix-video-count"),
  videoGrid: document.querySelector("#remix-video-grid"),
  addVideoBtn: document.querySelector("#remix-add-video-btn"),
  addVideoForm: document.querySelector("#remix-add-video-form"),
  videoFile: document.querySelector("#remix-video-file"),
  videoUrl: document.querySelector("#remix-video-url"),
  videoTitle: document.querySelector("#remix-video-title"),
  uploadBtn: document.querySelector("#remix-upload-btn"),
  confirmVideo: document.querySelector("#remix-confirm-video"),
  cancelVideo: document.querySelector("#remix-cancel-video"),
  selectedList: document.querySelector("#remix-selected-list"),
  ratio: document.querySelector("#remix-ratio"),
  dedupBtn: document.querySelector("#remix-dedup-btn"),
  stitchBtn: document.querySelector("#remix-stitch-btn"),
  tasksList: document.querySelector("#remix-tasks-list"),
  refreshTasks: document.querySelector("#remix-refresh-tasks"),
  pagination: document.querySelector("#remix-pagination"),
  viewGridBtn: document.querySelector("#remix-view-grid"),
  viewListBtn: document.querySelector("#remix-view-list"),
  resourcesHint: document.querySelector("#remix-resources-hint"),
  uploadBtns: document.querySelectorAll(".remix-upload-btn"),
  uploadInputs: {
    intro: document.querySelector("#remix-upload-intro"),
    outro: document.querySelector("#remix-upload-outro"),
    music: document.querySelector("#remix-upload-music"),
  },
  resourceLists: {
    intro: document.querySelector("#remix-resource-list-intro"),
    outro: document.querySelector("#remix-resource-list-outro"),
    music: document.querySelector("#remix-resource-list-music"),
  },
};

async function fetchRemixCreators() {
  try {
    const data = await request("/api/remix/creators");
    remix.creators = Array.isArray(data) ? data : [];
    renderRemixCreators();
  } catch { }
}

async function fetchRemixVideos(creatorId) {
  try {
    const data = await request(`/api/remix/creators/${encodeURIComponent(creatorId)}/videos`);
    remix.videos = Array.isArray(data) ? data : [];
    renderRemixVideos();
  } catch { remix.videos = []; renderRemixVideos(); }
}

async function fetchRemixTasks() {
  try {
    const data = await request("/api/remix/tasks");
    remix.tasks = Array.isArray(data) ? data : [];
    renderRemixTasks();
    updateRemixPolling();
  } catch { }
}

async function fetchRemixResources(creatorId) {
  try {
    const data = await request(`/api/remix/creators/${encodeURIComponent(creatorId)}/resources`);
    remix.resources = Array.isArray(data) ? data : [];
    renderRemixResources();
  } catch { remix.resources = []; renderRemixResources(); }
}

function formatFileSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatResourceDuration(sec) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

const RESOURCE_TYPE_LABELS = { intro: "开头片段", outro: "结尾片段", music: "背景音乐" };

function renderRemixResources() {
  const types = ["intro", "outro", "music"];
  for (const type of types) {
    const list = remix.resources.filter((r) => r.type === type);
    const container = remixEl.resourceLists[type];
    if (!container) continue;
    if (!list.length) {
      container.innerHTML = `<div class="remix-resource-empty">暂无${RESOURCE_TYPE_LABELS[type]}</div>`;
      continue;
    }
    container.innerHTML = list.map((r) => {
      const isVideo = type === "intro" || type === "outro";
      const preview = isVideo
        ? `<video src="${escapeHtml(r.filePath)}" muted preload="metadata" class="remix-resource-preview"></video>`
        : `<audio src="${escapeHtml(r.filePath)}" preload="metadata" class="remix-resource-audio"></audio>`;
      const dur = r.duration ? formatResourceDuration(r.duration) : "";
      const size = formatFileSize(r.fileSize);
      return `<div class="remix-resource-item">
        ${isVideo ? preview : ""}
        <div class="remix-resource-info">
          <span class="remix-resource-name">${escapeHtml(r.filename)}</span>
          <span class="remix-resource-meta">${dur ? `${dur} · ` : ""}${size}</span>
        </div>
        ${!isVideo ? `<button class="remix-resource-play" data-play-url="${escapeHtml(r.filePath)}" type="button">▶</button>` : ""}
        <button class="remix-resource-del" data-del-resource="${escapeHtml(r.id)}" type="button">×</button>
      </div>`;
    }).join("");
    container.querySelectorAll("[data-del-resource]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("删除此资源？")) return;
        try {
          await request(`/api/remix/creators/${encodeURIComponent(remix.selectedCreatorId)}/resources/${encodeURIComponent(btn.dataset.delResource)}`, { method: "DELETE" });
          await fetchRemixResources(remix.selectedCreatorId);
          await fetchRemixCreators();
        } catch (e) { showToast(e.message, true); }
      });
    });
    container.querySelectorAll("[data-play-url]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.playUrl;
        const audio = new Audio(url);
        audio.play().catch(() => {});
      });
    });
  }
}

function updateRemixPolling() {
  const hasActive = remix.tasks.some((t) => t.status === "PENDING" || t.status === "PROCESSING");
  if (hasActive && !remix.pollTimer) {
    remix.pollTimer = setInterval(fetchRemixTasks, 3000);
  } else if (!hasActive && remix.pollTimer) {
    clearInterval(remix.pollTimer);
    remix.pollTimer = null;
  }
}

function renderRemixCreators() {
  if (!remix.creators.length) {
    remixEl.creatorsList.innerHTML = '<div class="empty-state compact" style="padding: 16px;">点击 + 添加达人</div>';
    return;
  }
  remixEl.creatorsList.innerHTML = remix.creators.map((c) => `
    <div class="remix-creator-item ${remix.selectedCreatorId === c.id ? "active" : ""}" data-id="${escapeHtml(c.id)}">
      <div class="remix-creator-info">
        <strong>${escapeHtml(c.name)}</strong>
        <span>${escapeHtml(c.platform || "")} ${c._count?.videos || 0}视频 · ${c._count?.resources || 0}资源</span>
      </div>
      <button class="remix-del-btn" data-del-creator="${escapeHtml(c.id)}" title="删除">×</button>
    </div>
  `).join("");
  remixEl.creatorsList.querySelectorAll("[data-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.delCreator) return;
      remix.selectedCreatorId = el.dataset.id;
      remix.selectedVideos = [];
      remix.page = 1;
      fetchRemixVideos(remix.selectedCreatorId);
      fetchRemixResources(remix.selectedCreatorId);
      renderRemixCreators();
      remixEl.addVideoBtn.disabled = false;
      remixEl.uploadBtns.forEach((btn) => { btn.disabled = false; });
      // 打开视频工作台弹窗
      document.querySelector("#remix-workspace-modal")?.classList.remove("hidden");
      remixEl.resourcesHint.textContent = "正在加载资源…";
      const c = remix.creators.find((x) => x.id === remix.selectedCreatorId);
      remixEl.currentCreator.textContent = c ? `${c.name} 的视频` : "";
    });
  });
  remixEl.creatorsList.querySelectorAll("[data-del-creator]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("删除达人将同时删除其所有视频，确认？")) return;
      await request(`/api/remix/creators/${encodeURIComponent(btn.dataset.delCreator)}`, { method: "DELETE" });
      if (remix.selectedCreatorId === btn.dataset.delCreator) {
        remix.selectedCreatorId = null;
        remix.videos = [];
        remix.resources = [];
        remixEl.addVideoBtn.disabled = true;
        remixEl.uploadBtns.forEach((btn) => { btn.disabled = true; });
        remixEl.resourcesHint.textContent = "选择达人后可上传开头/结尾片段和背景音乐";
        remixEl.currentCreator.textContent = "视频去重与混剪工作台";
        remixEl.videoCount.textContent = "在左侧选择达人查看视频";
        renderRemixVideos();
        renderRemixResources();
      }
      await fetchRemixCreators();
    });
  });
}

function remixBadgeHtml(info) {
  if (!info) return "";
  const downloaded = info.status === "DONE" && info.downloaded;
  const dlMark = downloaded ? '<span class="remix-dl-mark" title="已下载"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>' : "";
  const dl = info.status === "DONE" && info.outputUrl
    ? `<a href="${escapeHtml(info.outputUrl)}" download class="remix-video-dl ${downloaded ? "downloaded" : ""}" title="${downloaded ? "再次下载" : "下载"}" data-task-id="${escapeHtml(info.taskId)}" data-out-url="${escapeHtml(info.outputUrl)}" onclick="event.stopPropagation()"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>`
    : "";
  return `<div class="remix-video-badge badge-${escapeHtml(info.status)}">${escapeHtml(info.label)}${dlMark}${dl}</div>`;
}

function bindRemixDownloadLinks(container) {
  container.querySelectorAll("a[data-task-id]").forEach((a) => {
    if (a._bound) return;
    a._bound = true;
    a.addEventListener("click", async () => {
      const taskId = a.dataset.taskId;
      if (!taskId) return;
      try {
        await request(`/api/remix/tasks/${encodeURIComponent(taskId)}/downloaded`, { method: "POST", body: "{}" });
        const task = remix.tasks.find((t) => t.id === taskId);
        if (task) task.downloaded = true;
        const entry = Object.values(remixTaskMap).find((e) => e.taskId === taskId);
        if (entry) entry.downloaded = true;
        updateRemixVideoBadges();
        renderRemixTasks();
      } catch {}
    });
  });
}

function renderRemixVideos() {
  remixEl.videoCount.textContent = remix.videos.length ? `${remix.videos.length} 个视频` : "";
  if (!remix.videos.length) {
    remixEl.videoGrid.innerHTML = '<div class="empty-state compact">暂无视频，点击"添加视频"上传或粘贴链接</div>';
    remixEl.pagination.innerHTML = "";
    remixEl.videoGrid.className = "remix-video-grid";
    return;
  }

  const totalPages = Math.ceil(remix.videos.length / remix.pageSize);
  if (remix.page > totalPages) remix.page = 1;
  const start = (remix.page - 1) * remix.pageSize;
  const pageVideos = remix.videos.slice(start, start + remix.pageSize);

  const isList = remix.viewMode === "list";
  remixEl.videoGrid.className = isList ? "remix-video-list" : "remix-video-grid";

  remixEl.videoGrid.innerHTML = pageVideos.map((v) => {
    const selected = remix.selectedVideos.some((sv) => sv.url === v.url);
    const taskInfo = remixTaskMap[v.url];
    if (isList) {
      return `
        <div class="remix-video-row ${selected ? "selected" : ""}" data-url="${escapeHtml(v.url)}" data-title="${escapeHtml(v.title || "未命名")}">
          <div class="remix-video-row-thumb">
            <video src="${escapeHtml(v.url)}" muted preload="metadata" playsinline></video>
            <button class="remix-play-btn remix-play-sm" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
            <div class="remix-video-check ${selected ? "checked" : ""}">${selected ? "✓" : ""}</div>
          </div>
          <div class="remix-video-row-info">
            <p class="remix-video-title">${escapeHtml(v.title || "未命名")}</p>
            ${taskInfo ? remixBadgeHtml(taskInfo) : ""}
          </div>
          <button class="remix-video-del" data-del-video="${escapeHtml(v.id)}">×</button>
        </div>
      `;
    }
    return `
      <div class="remix-video-card ${selected ? "selected" : ""}" data-url="${escapeHtml(v.url)}" data-title="${escapeHtml(v.title || "未命名")}">
        <div class="remix-video-thumb">
          <video src="${escapeHtml(v.url)}" muted preload="metadata" playsinline></video>
          <button class="remix-play-btn" type="button" aria-label="播放">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="remix-video-check ${selected ? "checked" : ""}">${selected ? "✓" : ""}</div>
          <button class="remix-video-del" data-del-video="${escapeHtml(v.id)}">×</button>
          ${remixBadgeHtml(taskInfo)}
        </div>
        <p class="remix-video-title">${escapeHtml(v.title || "未命名")}</p>
        ${v.matrixLinks?.length ? `<div class="remix-video-matrix-links">${v.matrixLinks.map((ml) => `<span class="remix-matrix-tag" title="${escapeHtml(ml.matrixName)}">${escapeHtml(ml.matrixName)}</span>`).join("")}</div>` : ""}
      </div>
    `;
  }).join("");

  renderRemixPagination(totalPages);

  remixEl.videoGrid.querySelectorAll("[data-url]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.delVideo) return;
      if (e.target.closest(".remix-play-btn")) return;
      const url = el.dataset.url;
      const title = el.dataset.title;
      const exists = remix.selectedVideos.find((sv) => sv.url === url);
      if (exists) remix.selectedVideos = remix.selectedVideos.filter((sv) => sv.url !== url);
      else remix.selectedVideos.push({ url, title, creatorName: remix.creators.find((c) => c.id === remix.selectedCreatorId)?.name || "" });
      el.classList.toggle("selected", !exists);
      const check = el.querySelector(".remix-video-check");
      if (check) {
        check.classList.toggle("checked", !exists);
        check.textContent = !exists ? "✓" : "";
      }
      renderRemixSelected();
    });
  });
  remixEl.videoGrid.querySelectorAll("[data-del-video]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await request(`/api/remix/creators/${encodeURIComponent(remix.selectedCreatorId)}/videos/${encodeURIComponent(btn.dataset.delVideo)}`, { method: "DELETE" });
      await fetchRemixVideos(remix.selectedCreatorId);
      await fetchRemixCreators();
    });
  });
  remixEl.videoGrid.querySelectorAll(".remix-play-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const video = btn.previousElementSibling;
      if (video.tagName !== "VIDEO") return;
      if (video.paused) {
        video.play();
        btn.classList.add("playing");
      } else {
        video.pause();
        btn.classList.remove("playing");
      }
    });
    const video = btn.previousElementSibling;
    if (video.tagName === "VIDEO") {
      video.addEventListener("play", () => btn.classList.add("playing"));
      video.addEventListener("pause", () => btn.classList.remove("playing"));
      video.addEventListener("ended", () => btn.classList.remove("playing"));
    }
  });
  bindRemixDownloadLinks(remixEl.videoGrid);
}

function renderRemixPagination(totalPages) {
  if (totalPages <= 1) {
    remixEl.pagination.innerHTML = remix.videos.length > remix.pageSize
      ? `<span class="muted-activity" style="font-size:11px;">共 ${remix.videos.length} 个</span>`
      : "";
    return;
  }
  const p = remix.page;
  let pages = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages = [1];
    if (p > 3) pages.push("...");
    for (let i = Math.max(2, p - 1); i <= Math.min(totalPages - 1, p + 1); i++) pages.push(i);
    if (p < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }
  const buttons = pages.map((pg) =>
    pg === "..."
      ? '<span class="remix-page-dots">…</span>'
      : `<button class="remix-page-btn ${pg === p ? "active" : ""}" data-page="${pg}" type="button">${pg}</button>`,
  ).join("");
  remixEl.pagination.innerHTML = `
    <button class="remix-page-btn" data-page="${p - 1}" type="button" ${p === 1 ? "disabled" : ""}>‹</button>
    ${buttons}
    <button class="remix-page-btn" data-page="${p + 1}" type="button" ${p === totalPages ? "disabled" : ""}>›</button>
    <span class="muted-activity" style="font-size:11px; margin-left:6px;">${(p - 1) * remix.pageSize + 1}-${Math.min(p * remix.pageSize, remix.videos.length)} / ${remix.videos.length}</span>
  `;
  remixEl.pagination.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pg = Number(btn.dataset.page);
      if (pg >= 1 && pg <= totalPages && pg !== remix.page) {
        remix.page = pg;
        renderRemixVideos();
      }
    });
  });
}

remixEl.viewGridBtn?.addEventListener("click", () => {
  remix.viewMode = "grid";
  localStorage.setItem("remix-view-mode", "grid");
  remixEl.viewGridBtn.classList.add("active");
  remixEl.viewListBtn.classList.remove("active");
  renderRemixVideos();
});
remixEl.viewListBtn?.addEventListener("click", () => {
  remix.viewMode = "list";
  localStorage.setItem("remix-view-mode", "list");
  remixEl.viewListBtn.classList.add("active");
  remixEl.viewGridBtn.classList.remove("active");
  renderRemixVideos();
});

function updateRemixVideoBadges() {
  remixEl.videoGrid.querySelectorAll(".remix-video-card").forEach((card) => {
    const url = card.dataset.url;
    const thumb = card.querySelector(".remix-video-thumb");
    if (!thumb) return;
    const oldBadge = thumb.querySelector(".remix-video-badge");
    const info = remixTaskMap[url];
    if (info) {
      const html = remixBadgeHtml(info);
      if (oldBadge) {
        oldBadge.outerHTML = html;
      } else {
        thumb.insertAdjacentHTML("beforeend", html);
      }
    } else if (oldBadge) {
      oldBadge.remove();
    }
  });
  bindRemixDownloadLinks(remixEl.videoGrid);
}

function renderRemixSelected() {
  remixEl.selectedList.innerHTML = remix.selectedVideos.length
    ? remix.selectedVideos.map((v) => `<span class="remix-chip" data-url="${escapeHtml(v.url)}">${escapeHtml(v.title)} ×</span>`).join("")
    : '<span class="muted-activity" style="font-size: 12px;">勾选视频加入去重或混剪</span>';
  remixEl.dedupBtn.disabled = remix.selectedVideos.length < 1;
  remixEl.stitchBtn.disabled = false;
  remixEl.selectedList.querySelectorAll("[data-url]").forEach((chip) => {
    chip.addEventListener("click", () => {
      remix.selectedVideos = remix.selectedVideos.filter((sv) => sv.url !== chip.dataset.url);
      renderRemixVideos();
      renderRemixSelected();
    });
  });
}

let remixTaskMap = {};
function renderRemixTasks() {
  remixTaskMap = {};
  for (const t of remix.tasks) {
    for (const url of t.videoUrls) {
      const existing = remixTaskMap[url];
      if (!existing || new Date(t.createdAt) > new Date(existing.createdAt)) {
        const label = t.status === "DONE" ? (t.mode === "dedup" ? "已去重" : "已混剪") : t.status === "PROCESSING" ? "处理中" : t.status === "FAILED" ? "失败" : "等待中";
        remixTaskMap[url] = { status: t.status, label, outputUrl: t.outputUrl, downloaded: Boolean(t.downloaded), taskId: t.id, createdAt: t.createdAt };
      }
    }
  }

  updateRemixVideoBadges();

  if (!remix.tasks.length) {
    remixEl.tasksList.innerHTML = '<div class="empty-state compact">暂无记录</div>';
    return;
  }
  remixEl.tasksList.innerHTML = remix.tasks.map((t) => {
    const isDedup = t.mode === "dedup";
    const isMatrixRemix = t.mode === "matrix-remix";
    const isAiRemix = t.mode === "ai-remix";
    const modeLabel = isDedup ? "去重" : isAiRemix ? "AI混剪" : isMatrixRemix ? "矩阵混剪" : "混剪";
    const statusBadge = {
      DONE: '<span class="badge-done">完成</span>',
      PROCESSING: '<span class="badge-processing"><span class="badge-spinner"></span>处理中</span>',
      PENDING: '<span class="badge-pending"><span class="badge-spinner"></span>等待中</span>',
      FAILED: '<span class="badge-failed">失败</span>',
    }[t.status] || "";
    return `
      <div class="remix-task-item">
        <div class="remix-task-info">
          ${t.status === "DONE" && t.outputUrl ? `<input type="checkbox" class="task-select-cb" data-task-id="${escapeHtml(t.id)}" data-out-url="${escapeHtml(t.outputUrl)}" style="margin-right:8px;" />` : ""}
          <span class="remix-task-mode ${isDedup ? "mode-dedup" : "mode-stitch"}">${modeLabel}</span>
          <strong>${escapeHtml(t.title)}</strong>
          ${statusBadge}
          <span class="muted-activity" style="font-size: 11px;">${t.videoCount}视频 · ${escapeHtml(t.ratio)} · ${formatDateTime(t.createdAt)}</span>
        </div>
        <div class="remix-task-actions">
          <button class="button button-secondary task-log-btn" data-task-id="${escapeHtml(t.id)}" style="font-size: 11px; padding:2px 8px;">日志</button>
          ${(t.status === "PENDING" || t.status === "PROCESSING") ? `<button class="danger-button task-abort-btn" data-task-id="${escapeHtml(t.id)}" style="font-size: 11px; padding:2px 8px;">中止</button>` : ""}
          ${(t.status === "FAILED" || t.status === "DONE") ? `<button class="button button-secondary task-retry-btn" data-task-id="${escapeHtml(t.id)}" style="font-size: 11px; padding:2px 8px;">重试</button>` : ""}
          ${t.status === "DONE" && t.outputUrl ? `<a href="${escapeHtml(t.outputUrl)}" target="_blank" class="button button-secondary" style="font-size: 11px;">预览</a>` : ""}
          ${t.status === "DONE" && t.outputUrl ? `<a href="${escapeHtml(t.outputUrl)}" download data-task-id="${escapeHtml(t.id)}" data-out-url="${escapeHtml(t.outputUrl)}" class="button button-primary" style="font-size: 11px;">${t.downloaded ? "已下载 ✓" : "下载"}</a>` : ""}
          <button class="remix-del-task" data-del-task="${escapeHtml(t.id)}" style="color: #dc2626; background: none; border: none; cursor: pointer; font-size: 16px;">×</button>
        </div>
      </div>
    `;
  }).join("");
  remixEl.tasksList.querySelectorAll("[data-del-task]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await request(`/api/remix/tasks/${encodeURIComponent(btn.dataset.delTask)}`, { method: "DELETE" });
      await fetchRemixTasks();
    });
  });
  // 日志按钮
  remixEl.tasksList.querySelectorAll(".task-log-btn").forEach((btn) => {
    btn.addEventListener("click", () => openTaskLogModal(btn.dataset.taskId));
  });
  // 重试按钮
  remixEl.tasksList.querySelectorAll(".task-retry-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        showToast("正在重试任务...");
        await request(`/api/remix/tasks/${encodeURIComponent(btn.dataset.taskId)}/retry`, { method: "POST", body: "{}" });
        showToast("任务已重新提交");
        await fetchRemixTasks();
      } catch (e) { showToast(e.message, true); }
    });
  });
  // 中止按钮
  remixEl.tasksList.querySelectorAll(".task-abort-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await request(`/api/remix/tasks/${encodeURIComponent(btn.dataset.taskId)}/abort`, { method: "POST", body: "{}" });
        showToast("任务已中止");
        await fetchRemixTasks();
      } catch (e) { showToast(e.message, true); }
    });
  });
  bindRemixDownloadLinks(remixEl.tasksList);
}

// 路径配置
async function loadPathConfig() {
  try {
    const cfg = await request("/api/path-config");
    const uploadEl = document.querySelector("#path-config-upload");
    const outputEl = document.querySelector("#path-config-output");
    if (uploadEl) uploadEl.value = cfg.videoUploadPath || "";
    if (outputEl) outputEl.value = cfg.outputPath || "";
  } catch {}
}
loadPathConfig();

document.querySelector("#path-config-save")?.addEventListener("click", async () => {
  const uploadEl = document.querySelector("#path-config-upload");
  const outputEl = document.querySelector("#path-config-output");
  try {
    await request("/api/path-config", {
      method: "POST",
      body: JSON.stringify({ videoUploadPath: uploadEl?.value.trim() || "", outputPath: outputEl?.value.trim() || "" }),
    });
    showToast("路径配置已保存");
  } catch (e) { showToast(e.message, true); }
});

// 关闭视频工作台弹窗
document.querySelector("#remix-workspace-close")?.addEventListener("click", () => {
  document.querySelector("#remix-workspace-modal")?.classList.add("hidden");
});

// 达人添加
remixEl.addCreatorBtn.addEventListener("click", () => remixEl.addCreatorForm.classList.toggle("hidden"));

// 全选
document.querySelector("#remix-select-all")?.addEventListener("change", (e) => {
  document.querySelectorAll(".task-select-cb").forEach((cb) => { cb.checked = e.target.checked; });
});

// 批量下载
document.querySelector("#remix-batch-download")?.addEventListener("click", () => {
  const checked = document.querySelectorAll(".task-select-cb:checked");
  if (!checked.length) { showToast("请先勾选要下载的任务", true); return; }
  checked.forEach((cb, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = cb.dataset.outUrl;
      a.download = "";
      a.click();
    }, i * 500);
  });
  showToast(`开始下载 ${checked.length} 个视频`);
});

// 任务日志弹框
function openTaskLogModal(taskId) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-content" style="max-width: 700px;">
      <div class="modal-header">
        <h3>任务日志</h3>
        <button class="text-button" id="task-log-close">关闭</button>
      </div>
      <div style="padding: 16px 20px; max-height: 60vh; overflow-y: auto;">
        <ol id="task-log-list" class="cdp-logs-list" style="padding:0;">
          <li class="muted-activity">加载中...</li>
        </ol>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#task-log-close").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  // 加载日志
  request(`/api/cdp/logs?taskId=${encodeURIComponent(taskId)}&limit=200`)
    .then((data) => {
      const list = overlay.querySelector("#task-log-list");
      const logs = data.logs || [];
      if (!logs.length) {
        list.innerHTML = '<li class="muted-activity">暂无日志</li>';
        return;
      }
      // 反转为时间正序
      logs.reverse();
      list.innerHTML = logs.map((l) => {
        const color = l.level === "error" ? "#dc2626" : l.level === "warning" ? "#d97706" : "inherit";
        return `<li style="color:${color};"><span class="muted-activity">${toCST(l.createdAt)}</span> ${escapeHtml(l.message)}</li>`;
      }).join("");
    })
    .catch(() => {
      overlay.querySelector("#task-log-list").innerHTML = '<li class="muted-activity">加载失败</li>';
    });
}
remixEl.cancelCreator.addEventListener("click", () => { remixEl.addCreatorForm.classList.add("hidden"); remixEl.creatorName.value = ""; remixEl.creatorPlatform.value = ""; });
remixEl.confirmCreator.addEventListener("click", async () => {
  const name = remixEl.creatorName.value.trim();
  if (!name) return;
  try {
    const data = await request("/api/remix/creators", { method: "POST", body: JSON.stringify({ name, platform: remixEl.creatorPlatform.value.trim() || null }) });
    remixEl.addCreatorForm.classList.add("hidden");
    remixEl.creatorName.value = ""; remixEl.creatorPlatform.value = "";
    await fetchRemixCreators();
    remix.selectedCreatorId = data.id;
    await fetchRemixVideos(data.id);
    fetchRemixResources(data.id);
    renderRemixCreators();
    remixEl.addVideoBtn.disabled = false;
    remixEl.uploadBtns.forEach((btn) => { btn.disabled = false; });
    remixEl.resourcesHint.textContent = `${data.name} 的专属资源`;
    remixEl.currentCreator.textContent = `${data.name} 的视频`;
  } catch (e) { showToast(e.message, true); }
});

// 视频添加
remixEl.addVideoBtn.addEventListener("click", () => remixEl.addVideoForm.classList.toggle("hidden"));
remixEl.cancelVideo.addEventListener("click", () => { remixEl.addVideoForm.classList.add("hidden"); remixEl.videoUrl.value = ""; remixEl.videoTitle.value = ""; });
remixEl.uploadBtn.addEventListener("click", () => remixEl.videoFile.click());
remixEl.videoFile.addEventListener("change", async () => {
  const files = [...remixEl.videoFile.files];
  if (!files.length) return;
  remixEl.videoFile.value = "";

  if (files.length === 1) {
    const file = files[0];
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/remix/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      remixEl.videoUrl.value = data.url;
      if (!remixEl.videoTitle.value) remixEl.videoTitle.value = file.name.replace(/\.[^.]+$/, "");
    } catch (e) { showToast(e.message, true); }
    return;
  }

  const creatorId = remix.selectedCreatorId;
  if (!creatorId) { showToast("请先选择达人", true); return; }
  remixEl.uploadBtn.disabled = true;
  remixEl.uploadBtn.textContent = `上传中 (0/${files.length})...`;
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    remixEl.uploadBtn.textContent = `上传中 (${i + 1}/${files.length})...`;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/remix/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      await request(`/api/remix/creators/${encodeURIComponent(creatorId)}/videos`, {
        method: "POST",
        body: JSON.stringify({ url: data.url, title: file.name.replace(/\.[^.]+$/, "") }),
      });
      ok++;
    } catch { fail++; }
  }
  remixEl.uploadBtn.disabled = false;
  remixEl.uploadBtn.textContent = "批量上传";
  await fetchRemixVideos(creatorId);
  await fetchRemixCreators();
  showToast(`批量上传完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`, fail > 0);
});
remixEl.confirmVideo.addEventListener("click", async () => {
  const url = remixEl.videoUrl.value.trim();
  if (!url || !remix.selectedCreatorId) return;
  try {
    await request(`/api/remix/creators/${encodeURIComponent(remix.selectedCreatorId)}/videos`, {
      method: "POST",
      body: JSON.stringify({ url, title: remixEl.videoTitle.value.trim() || null }),
    });
    remixEl.addVideoForm.classList.add("hidden");
    remixEl.videoUrl.value = ""; remixEl.videoTitle.value = "";
    await fetchRemixVideos(remix.selectedCreatorId);
    await fetchRemixCreators();
  } catch (e) { showToast(e.message, true); }
});

// 去重
remixEl.dedupBtn.addEventListener("click", async () => {
  if (!remix.selectedVideos.length) return;
  const ratio = remixEl.ratio.value;
  for (const v of remix.selectedVideos) {
    try {
      await request("/api/remix/tasks", {
        method: "POST",
        body: JSON.stringify({ videoUrls: [v.url], sourceVideos: [{ url: v.url, title: v.title, creatorName: v.creatorName }], title: `去重 · ${v.creatorName} - ${v.title}`, ratio, mode: "dedup" }),
      });
    } catch (e) { showToast(`${v.title} 创建失败：${e.message}`, true); }
  }
  remix.selectedVideos = [];
  renderRemixVideos();
  renderRemixSelected();
  await fetchRemixTasks();
  showToast("去重任务已创建");
});

// 拼接混剪 — 打开弹框，预设为拼接模式
remixEl.stitchBtn.addEventListener("click", () => {
  openRemixTaskModal("stitch");
});

// AI混剪 — 打开弹框，预设为AI模式
remixEl.aiBtn = document.querySelector("#remix-ai-btn");
remixEl.aiBtn?.addEventListener("click", () => {
  openRemixTaskModal("ai");
});

remixEl.refreshTasks.addEventListener("click", fetchRemixTasks);

// 达人资源上传
remixEl.uploadBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const type = btn.dataset.type;
    remixEl.uploadInputs[type]?.click();
  });
});

Object.entries(remixEl.uploadInputs).forEach(([type, input]) => {
  if (!input) return;
  input.addEventListener("change", async () => {
    const files = [...input.files];
    if (!files.length) return;
    input.value = "";
    const creatorId = remix.selectedCreatorId;
    if (!creatorId) { showToast("请先选择达人", true); return; }

    const btn = document.querySelector(`.remix-upload-btn[data-type="${type}"]`);
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = `上传中 (0/${files.length})...`;
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < files.length; i++) {
      btn.textContent = `上传中 (${i + 1}/${files.length})...`;
      try {
        const formData = new FormData();
        formData.append("file", files[i]);
        formData.append("type", type);
        const res = await fetch(`/api/remix/creators/${encodeURIComponent(creatorId)}/resources`, { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "上传失败");
        ok++;
      } catch { fail++; }
    }
    btn.disabled = false;
    btn.textContent = origText;
    await fetchRemixResources(creatorId);
    await fetchRemixCreators();
    showToast(`上传完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`, fail > 0);
  });
});

// 初始化
if (remix.viewMode === "list") {
  remixEl.viewListBtn?.classList.add("active");
  remixEl.viewGridBtn?.classList.remove("active");
}

// ==========================================================================
// Chrome CDP 管理模块
// ==========================================================================
const cdpEl = {
  refreshBtn: document.querySelector("#cdp-refresh"),
  addBtn: document.querySelector("#cdp-add"),
  scanBtn: document.querySelector("#cdp-scan"),
  scanResults: document.querySelector("#cdp-scan-results"),
  scanHint: document.querySelector("#cdp-scan-hint"),
  scanList: document.querySelector("#cdp-scan-list"),
  ngrokUrl: document.querySelector("#cdp-ngrok-url"),
  ngrokPort: document.querySelector("#cdp-ngrok-port"),
  ngrokAutostart: document.querySelector("#cdp-ngrok-autostart"),
  ngrokSave: document.querySelector("#cdp-ngrok-save"),
  ngrokStart: document.querySelector("#cdp-ngrok-start"),
  ngrokStop: document.querySelector("#cdp-ngrok-stop"),
  ngrokCheck: document.querySelector("#cdp-ngrok-check"),
  ngrokStatus: document.querySelector("#cdp-ngrok-status"),
  ngrokLogs: document.querySelector("#cdp-ngrok-logs"),
  form: document.querySelector("#cdp-form"),
  editId: document.querySelector("#cdp-edit-id"),
  name: document.querySelector("#cdp-name"),
  host: document.querySelector("#cdp-host"),
  port: document.querySelector("#cdp-port"),
  daemonPort: document.querySelector("#cdp-daemon-port"),
  ngrok: document.querySelector("#cdp-ngrok"),
  notes: document.querySelector("#cdp-notes"),
  saveBtn: document.querySelector("#cdp-save"),
  cancelBtn: document.querySelector("#cdp-cancel"),
  tableBody: document.querySelector("#cdp-instances-body"),
  actionPanel: document.querySelector("#cdp-action-panel"),
  actionTitle: document.querySelector("#cdp-action-title"),
  actionClose: document.querySelector("#cdp-action-close"),
  healthBtn: document.querySelector("#cdp-health"),
  statusBtn: document.querySelector("#cdp-status"),
  screenshotBtn: document.querySelector("#cdp-screenshot"),
  message: document.querySelector("#cdp-message"),
  sendBtn: document.querySelector("#cdp-send"),
  filepath: document.querySelector("#cdp-filepath"),
  uploadBtn: document.querySelector("#cdp-upload"),
  analyzePath: document.querySelector("#cdp-analyze-path"),
  analyzePrompt: document.querySelector("#cdp-analyze-prompt"),
  analyzeBtn: document.querySelector("#cdp-analyze"),
  analyzeCheck: document.querySelector("#cdp-analyze-check"),
  result: document.querySelector("#cdp-result"),
  logFilter: document.querySelector("#cdp-log-filter"),
  logsRefresh: document.querySelector("#cdp-logs-refresh"),
  logsClear: document.querySelector("#cdp-logs-clear"),
  logsList: document.querySelector("#cdp-logs-list"),
  launchBtn: document.querySelector("#cdp-launch-btn"),
  launchPath: document.querySelector("#cdp-launch-path"),
  launchPort: document.querySelector("#cdp-launch-port"),
  launchProxy: document.querySelector("#cdp-launch-proxy"),
  launchResult: document.querySelector("#cdp-launch-result"),
};
const cdpState = { instances: [], selectedId: null, analyzeJobId: null };

async function refreshCdpInstances() {
try {
  const res = await request("/api/cdp/instances");
  cdpState.instances = res.instances || [];
  // 检查每个实例的实际 daemon 状态
  for (const inst of cdpState.instances) {
    try {
      const statusRes = await request(`/api/cdp/instances/${encodeURIComponent(inst.id)}/daemon-status`);
      if (!statusRes.running && inst.status === "running") {
        inst.status = "stopped";
      }
    } catch {}
  }
  renderCdpInstances();
  refreshCdpLogs();
} catch (e) { showToast("CDP 实例加载失败：" + e.message, true); }
}

function renderCdpInstances() {
  if (!cdpEl.tableBody) return;
  const list = cdpState.instances;
  if (!list.length) {
    cdpEl.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">暂无 Chrome CDP 实例</td></tr>`;
    return;
  }
  cdpEl.tableBody.innerHTML = list.map(inst => {
    const statusClass = inst.status === "connected" ? "status-success" : inst.status === "error" ? "status-error" : inst.status === "running" ? "status-loading" : "status-loading";
    const daemonRunning = inst.status === "running" || inst.status === "connected";
    return `<tr>
      <td><strong>${escapeHtml(inst.name)}</strong>${inst.notes ? `<br><small style="color:var(--text-muted)">${escapeHtml(inst.notes)}</small>` : ""}</td>
      <td><code>${escapeHtml(inst.cdpHost)}:${inst.cdpPort}</code></td>
      <td>
        ${daemonRunning
          ? `<button class="danger-button" style="padding:2px 8px;font-size:11px;" onclick="window.cdpDaemonStop('${escapeHtml(inst.id)}')">停止守护</button>`
          : `<button class="button button-primary" style="padding:2px 8px;font-size:11px;" onclick="window.cdpDaemonStart('${escapeHtml(inst.id)}')">启动守护</button>`
        }
      </td>
      <td><span class="status-pill ${statusClass}">${escapeHtml(inst.status)}</span></td>
      <td>
        <button class="button button-secondary" style="padding:2px 8px;font-size:11px;" onclick="window.cdpDaemonRestart('${escapeHtml(inst.id)}')">重启</button>
        <button class="danger-button" style="padding:2px 8px;font-size:11px;" onclick="window.cdpDelete('${escapeHtml(inst.id)}')">删除</button>
      </td>
    </tr>`;
  }).join("");
  if (cdpEl.logFilter) {
    const cur = cdpEl.logFilter.value;
    cdpEl.logFilter.innerHTML = `<option value="">全部实例</option>` + list.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join("");
    cdpEl.logFilter.value = cur;
  }
}

window.cdpDaemonStart = async function(id) {
  try {
    await request(`/api/cdp/instances/${encodeURIComponent(id)}/daemon-start`, { method: "POST", body: "{}" });
    showToast("守护进程已启动");
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
};

window.cdpDaemonStop = async function(id) {
  try {
    await request(`/api/cdp/instances/${encodeURIComponent(id)}/daemon-stop`, { method: "POST", body: "{}" });
    showToast("守护进程已停止");
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
};

window.cdpDaemonRestart = async function(id) {
  try {
    showToast("正在重启守护进程...");
    try { await request(`/api/cdp/instances/${encodeURIComponent(id)}/daemon-stop`, { method: "POST", body: "{}" }); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    await request(`/api/cdp/instances/${encodeURIComponent(id)}/daemon-start`, { method: "POST", body: "{}" });
    showToast("守护进程已重启");
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
};

window.cdpDaemonStatus = async function(id) {
  try {
    const res = await request(`/api/cdp/instances/${encodeURIComponent(id)}/daemon-status`);
    const inst = cdpState.instances.find(i => i.id === id);
    const name = inst?.name || id.substring(0, 8);
    if (res.running) {
      const uptime = Math.round(res.uptime / 1000);
      const min = Math.floor(uptime / 60);
      const sec = uptime % 60;
      showToast(`${name} 守护进程运行中 (PID=${res.pid}, ${min}分${sec}秒)`);
    } else {
      showToast(`${name} 守护进程未运行`);
    }
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
};

window.cdpSelect = function(id) {
  cdpState.selectedId = id;
  const inst = cdpState.instances.find(i => i.id === id);
  if (!inst) return;
  cdpEl.actionPanel.style.display = "";
  cdpEl.actionTitle.textContent = `操作 — ${inst.name}`;
  cdpEl.result.innerHTML = "";
};

window.cdpEdit = function(id) {
  const inst = cdpState.instances.find(i => i.id === id);
  if (!inst) return;
  cdpEl.form.classList.remove("hidden");
  cdpEl.editId.value = inst.id;
  cdpEl.name.value = inst.name;
  cdpEl.host.value = inst.cdpHost;
  cdpEl.port.value = inst.cdpPort;
  cdpEl.daemonPort.value = inst.daemonPort;
  cdpEl.ngrok.value = inst.ngrokUrl || "";
  cdpEl.notes.value = inst.notes || "";
};

window.cdpDelete = async function(id) {
  if (!confirm("确定删除此 Chrome CDP 实例？")) return;
  try {
    await request(`/api/cdp/instances/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("已删除");
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
};

cdpEl.addBtn?.addEventListener("click", () => {
  cdpEl.form.classList.remove("hidden");
  cdpEl.editId.value = "";
  cdpEl.name.value = "";
  cdpEl.host.value = "localhost";
  cdpEl.port.value = "9222";
  cdpEl.daemonPort.value = "9223";
  cdpEl.ngrok.value = "";
  cdpEl.notes.value = "";
});

cdpEl.cancelBtn?.addEventListener("click", () => { cdpEl.form.classList.add("hidden"); });

cdpEl.saveBtn?.addEventListener("click", async () => {
  const data = {
    id: cdpEl.editId.value || undefined,
    name: cdpEl.name.value.trim() || "未命名实例",
    cdpHost: cdpEl.host.value.trim() || "localhost",
    cdpPort: Number(cdpEl.port.value) || 9222,
    daemonPort: Number(cdpEl.daemonPort.value) || 9223,
    ngrokUrl: cdpEl.ngrok.value.trim() || null,
    notes: cdpEl.notes.value.trim(),
  };
  try {
    await request("/api/cdp/instances", { method: "POST", body: JSON.stringify(data) });
    showToast("已保存");
    cdpEl.form.classList.add("hidden");
    await refreshCdpInstances();
  } catch (e) { showToast(e.message, true); }
});

cdpEl.refreshBtn?.addEventListener("click", refreshCdpInstances);
cdpEl.actionClose?.addEventListener("click", () => { cdpEl.actionPanel.style.display = "none"; cdpState.selectedId = null; });

// --- ngrok 管理 ---
async function refreshNgrokStatus() {
  try {
    const res = await request("/api/cdp/ngrok");
    const cfg = res.config || {};
    cdpEl.ngrokUrl.value = cfg.url || "";
    cdpEl.ngrokPort.value = cfg.port || 9223;
    cdpEl.ngrokAutostart.checked = Boolean(cfg.autoStart);
    const st = res.status || {};
    if (st.running) {
      cdpEl.ngrokStatus.textContent = `运行中 (PID=${st.pid})`;
      cdpEl.ngrokStatus.className = "status-pill status-success";
      cdpEl.ngrokStart.disabled = true;
      cdpEl.ngrokStop.disabled = false;
    } else {
      cdpEl.ngrokStatus.textContent = "未运行";
      cdpEl.ngrokStatus.className = "status-pill status-loading";
      cdpEl.ngrokStart.disabled = false;
      cdpEl.ngrokStop.disabled = true;
    }
    const logs = st.recentLogs || [];
    cdpEl.ngrokLogs.innerHTML = logs.length ? logs.map(l => `[${l.at.substring(11, 19)}] ${l.message}`).join("\n") : "暂无日志";
  } catch {}
}

cdpEl.ngrokSave?.addEventListener("click", async () => {
  const config = {
    url: cdpEl.ngrokUrl.value.trim(),
    port: Number(cdpEl.ngrokPort.value) || 9223,
    autoStart: cdpEl.ngrokAutostart.checked,
  };
  try {
    await request("/api/cdp/ngrok", { method: "PUT", body: JSON.stringify(config) });
    showToast("ngrok 配置已保存" + (config.autoStart ? "，下次启动系统将自动启动 ngrok" : ""));
  } catch (e) { showToast(e.message, true); }
});

cdpEl.ngrokStart?.addEventListener("click", async () => {
  try {
    await request("/api/cdp/ngrok/start", { method: "POST", body: "{}" });
    showToast("ngrok 已启动");
    await refreshNgrokStatus();
  } catch (e) { showToast(e.message, true); }
});

cdpEl.ngrokStop?.addEventListener("click", async () => {
  try {
    await request("/api/cdp/ngrok/stop", { method: "POST", body: "{}" });
    showToast("ngrok 已停止");
    await refreshNgrokStatus();
  } catch (e) { showToast(e.message, true); }
});

cdpEl.ngrokCheck?.addEventListener("click", refreshNgrokStatus);

// 恢复上次保存的启动配置
  if (cdpEl.launchPath) {
    const savedPath = localStorage.getItem("cdp-launch-profilePath");
    const savedPort = localStorage.getItem("cdp-launch-port");
    const savedProxy = localStorage.getItem("cdp-launch-proxy");
    const savedProfileDir = localStorage.getItem("cdp-launch-profileDir");
    if (savedPath) cdpEl.launchPath.value = savedPath;
    if (savedPort) cdpEl.launchPort.value = savedPort;
    if (savedProxy) cdpEl.launchProxy.value = savedProxy;
    const profileDirInput = document.querySelector("#cdp-launch-profile-dir");
    if (profileDirInput && savedProfileDir) profileDirInput.value = savedProfileDir;
  }

cdpEl.launchBtn?.addEventListener("click", async () => {
  const profilePath = cdpEl.launchPath.value.trim();
  if (!profilePath) { showToast("请填写 Chrome User Data 路径", true); return; }
  const port = cdpEl.launchPort.value || "9222";
  const proxy = cdpEl.launchProxy.value.trim() || null;
  const profileDirectory = document.querySelector("#cdp-launch-profile-dir")?.value.trim() || null;
  // 保存配置到 localStorage
  localStorage.setItem("cdp-launch-profilePath", profilePath);
  localStorage.setItem("cdp-launch-port", port);
  localStorage.setItem("cdp-launch-proxy", proxy || "");
  localStorage.setItem("cdp-launch-profileDir", profileDirectory || "Default");
  cdpEl.launchBtn.disabled = true;
  cdpEl.launchBtn.textContent = "启动中…";
  cdpEl.launchResult.textContent = "";
  cdpEl.launchResult.className = "cdp-launch-result";
  try {
    const res = await request("/api/cdp/launch-chrome", { method: "POST", body: JSON.stringify({ profilePath, port, proxy, profileDirectory }) });
    cdpEl.launchResult.textContent = `✓ Chrome 已启动 (PID=${res.pid}, CDP 端口 ${res.cdpPort})`;
    cdpEl.launchResult.className = "cdp-launch-result success";
    showToast(`Chrome 调试实例已启动，PID=${res.pid}`);
    // 自动扫描该端口
    setTimeout(() => cdpEl.scanBtn?.click(), 2000);
  } catch (e) {
    cdpEl.launchResult.textContent = `✗ ${e.message}`;
    cdpEl.launchResult.className = "cdp-launch-result error";
    showToast(e.message, true);
  } finally {
    cdpEl.launchBtn.disabled = false;
    cdpEl.launchBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:6px;vertical-align:-2px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>启动调试 Chrome';
  }
});

cdpEl.scanBtn?.addEventListener("click", async () => {
  cdpEl.scanResults.classList.remove("hidden");
  cdpEl.scanHint.textContent = "正在扫描 localhost:9222-9232…";
  cdpEl.scanList.innerHTML = `<div class="muted-activity" style="padding:8px;">扫描中…</div>`;
  try {
    const res = await request("/api/cdp/scan", { method: "POST", body: JSON.stringify({ host: "localhost", portStart: 9222, portEnd: 9232 }) });
    const found = res.instances || [];
    if (found.length === 0) {
      cdpEl.scanHint.textContent = "未发现 Chrome 调试实例";
      cdpEl.scanList.innerHTML = `<div style="padding:8px;color:var(--text-muted);font-size:13px;">
        未扫描到 Chrome 远程调试实例。请确认已用以下命令启动 Chrome：<br/>
        <code style="font-size:11px;">chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\chrome-cdp"</code>
      </div>`;
      return;
    }
    cdpEl.scanHint.textContent = `发现 ${found.length} 个 Chrome 实例`;
    cdpEl.scanList.innerHTML = found.map(item => {
      const info = item.chromeInfo || {};
      const browser = info.Browser || "未知";
      const alreadyAdded = cdpState.instances.some(i => i.cdpHost === item.host && i.cdpPort === item.port);
      return `<div class="cdp-scan-item">
        <div class="cdp-scan-info">
          <strong>${escapeHtml(item.host)}:${item.port}</strong>
          <span>${escapeHtml(browser)}</span>
          ${info["User-Agent"] ? `<small>${escapeHtml(info["User-Agent"].substring(0, 60))}</small>` : ""}
        </div>
        <button class="button ${alreadyAdded ? "button-secondary" : "button-primary"}" style="padding:4px 12px;font-size:12px;"
          ${alreadyAdded ? "disabled" : `onclick="window.cdpAddScanned('${escapeHtml(item.host)}', ${item.port}, '${escapeHtml(browser)}')"`}>
          ${alreadyAdded ? "已添加" : "添加"}
        </button>
      </div>`;
    }).join("");
  } catch (e) {
    cdpEl.scanHint.textContent = "扫描失败：" + e.message;
    cdpEl.scanList.innerHTML = "";
  }
});

window.cdpAddScanned = async function(host, port, browser) {
  const name = `Chrome ${port}`;
  try {
    await request("/api/cdp/instances", { method: "POST", body: JSON.stringify({ name, cdpHost: host, cdpPort: port }) });
    showToast(`已添加 ${name}`);
    await refreshCdpInstances();
    cdpEl.scanBtn.click();
  } catch (e) { showToast(e.message, true); }
};

async function cdpProxy(action, method = "POST", body = null) {
  if (!cdpState.selectedId) { showToast("请先选择实例", true); return null; }
  try {
    const opts = { method };
    if (body) opts.body = JSON.stringify(body);
    const res = await request(`/api/cdp/instances/${encodeURIComponent(cdpState.selectedId)}/${action}`, opts);
    return res;
  } catch (e) { showToast(e.message, true); return null; }
}

cdpEl.healthBtn?.addEventListener("click", async () => {
  const res = await cdpProxy("health", "GET");
  if (res) cdpEl.result.innerHTML = `<pre style="background:var(--bg-subtle);padding:10px;border-radius:var(--radius-sm);font-size:12px;white-space:pre-wrap;">${escapeHtml(JSON.stringify(res, null, 2))}</pre>`;
  await refreshCdpInstances();
});

cdpEl.statusBtn?.addEventListener("click", async () => {
  const res = await cdpProxy("status", "GET");
  if (res) cdpEl.result.innerHTML = `<pre style="background:var(--bg-subtle);padding:10px;border-radius:var(--radius-sm);font-size:12px;white-space:pre-wrap;">${escapeHtml(JSON.stringify(res, null, 2))}</pre>`;
});

cdpEl.screenshotBtn?.addEventListener("click", async () => {
  const res = await cdpProxy("screenshot", "POST", {});
  if (res?.base64) {
    cdpEl.result.innerHTML = `<img src="data:image/png;base64,${res.base64}" style="max-width:100%;border-radius:var(--radius-sm);border:1px solid var(--line);" />`;
  } else { cdpEl.result.innerHTML = `<p style="color:var(--red);">截图失败</p>`; }
});

cdpEl.sendBtn?.addEventListener("click", async () => {
  const text = cdpEl.message.value.trim();
  if (!text) { showToast("请输入消息", true); return; }
  cdpEl.result.innerHTML = `<p style="color:var(--text-muted);">正在发送…</p>`;
  const res = await cdpProxy("send-message", "POST", { text });
  if (res) cdpEl.result.innerHTML = `<p>发送结果：${res.ok ? "成功" : "失败"}</p>`;
});

cdpEl.uploadBtn?.addEventListener("click", async () => {
  const filePath = cdpEl.filepath.value.trim();
  if (!filePath) { showToast("请输入文件路径", true); return; }
  cdpEl.result.innerHTML = `<p style="color:var(--text-muted);">正在上传…</p>`;
  const res = await cdpProxy("upload-file", "POST", { filePath });
  if (res) cdpEl.result.innerHTML = `<p>上传结果：${res.ok ? "成功" : "失败"} ${res.method || ""}</p>`;
});

cdpEl.analyzeBtn?.addEventListener("click", async () => {
  const videoPath = cdpEl.analyzePath.value.trim();
  const prompt = cdpEl.analyzePrompt.value.trim();
  if (!videoPath) { showToast("请输入视频路径", true); return; }
  cdpEl.result.innerHTML = `<p style="color:var(--text-muted);">正在提交分析任务…</p>`;
  const res = await cdpProxy("analyze-video", "POST", { videoPath, prompt });
  if (res?.jobId) {
    cdpState.analyzeJobId = res.jobId;
    cdpEl.result.innerHTML = `<p>分析任务已启动，JobID: ${res.jobId}</p>`;
  }
});

cdpEl.analyzeCheck?.addEventListener("click", async () => {
  if (!cdpState.analyzeJobId) { showToast("没有正在进行的分析任务", true); return; }
  const res = await cdpProxy(`analysis-status?jobId=${cdpState.analyzeJobId}`, "GET");
  if (res) {
    const status = res.status || "unknown";
    const text = res.response ? res.response.substring(0, 500) + (res.response.length > 500 ? "…" : "") : "";
    cdpEl.result.innerHTML = `<pre style="background:var(--bg-subtle);padding:10px;border-radius:var(--radius-sm);font-size:12px;white-space:pre-wrap;">状态: ${status}\n${text}</pre>`;
  }
});

// UTC ISO 时间转东八区 HH:MM:SS
function toCST(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    return new Date(utc + 8 * 3600000).toISOString().substring(11, 19);
  } catch { return isoStr.substring(11, 19) || ""; }
}

async function refreshCdpLogs() {
  try {
    const instanceId = cdpEl.logFilter?.value || null;
    const res = await request(`/api/cdp/logs${instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : ""}`);
    const logs = res.logs || [];
    if (!logs.length) {
      cdpEl.logsList.innerHTML = `<li class="muted-activity">暂无日志</li>`;
      return;
    }
    cdpEl.logsList.innerHTML = logs.map(l => {
      const inst = cdpState.instances.find(i => i.id === l.instanceId);
      const instName = inst?.name || l.instanceId?.substring(0, 8) || "系统";
      return `<li class="cdp-log-item cdp-log-${escapeHtml(l.level)}">
        <span class="cdp-log-time">${toCST(l.createdAt)}</span>
        <span class="cdp-log-inst">${escapeHtml(instName)}</span>
        <span class="cdp-log-level">${escapeHtml(l.level)}</span>
        <span class="cdp-log-msg">${escapeHtml(l.message)}</span>
      </li>`;
    }).join("");
  } catch {}
}

cdpEl.logsRefresh?.addEventListener("click", refreshCdpLogs);
cdpEl.logFilter?.addEventListener("change", refreshCdpLogs);

// CDP Tab 激活时定时刷新日志和实例状态
let cdpAutoRefreshTimer = null;
function startCdpAutoRefresh() {
  if (cdpAutoRefreshTimer) return;
  cdpAutoRefreshTimer = setInterval(() => {
    refreshCdpInstances();
  }, 5000);
}
function stopCdpAutoRefresh() {
  if (cdpAutoRefreshTimer) { clearInterval(cdpAutoRefreshTimer); cdpAutoRefreshTimer = null; }
}
// 在 tab 切换时启动/停止自动刷新
document.querySelectorAll('.platform-tab[data-platform="cdp"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    startCdpAutoRefresh();
  });
});
document.querySelectorAll('.platform-tab:not([data-platform="cdp"])').forEach((btn) => {
  btn.addEventListener("click", () => {
    stopCdpAutoRefresh();
  });
});
cdpEl.logsClear?.addEventListener("click", async () => {
  try {
    await request("/api/cdp/logs", { method: "DELETE" });
    showToast("日志已清空");
    refreshCdpLogs();
  } catch (e) { showToast(e.message, true); }
});

// ==========================================================================
// 社媒矩阵管理模块
// ==========================================================================
const mxState = {
  matrices: [],
  accounts: [],
  videos: [],
  profiles: [],
  selectedId: null,
};

const mxEl = {
  list: document.querySelector("#mx-list"),
  addBtn: document.querySelector("#mx-add-btn"),
  addForm: document.querySelector("#mx-add-form"),
  name: document.querySelector("#mx-name"),
  notes: document.querySelector("#mx-notes"),
  confirm: document.querySelector("#mx-confirm"),
  cancel: document.querySelector("#mx-cancel"),
  currentName: document.querySelector("#mx-current-name"),
  currentInfo: document.querySelector("#mx-current-info"),
  addAccountBtn: document.querySelector("#mx-add-account-btn"),
  addAccountForm: document.querySelector("#mx-add-account-form"),
  accountPlatform: document.querySelector("#mx-account-platform"),
  accountName: document.querySelector("#mx-account-name"),
  confirmAccount: document.querySelector("#mx-confirm-account"),
  cancelAccount: document.querySelector("#mx-cancel-account"),
  accountsList: document.querySelector("#mx-accounts-list"),
  refreshVideos: document.querySelector("#mx-refresh-videos"),
  videosList: document.querySelector("#mx-videos-list"),
  bindProfileBtn: document.querySelector("#mx-bind-profile-btn"),
  bindProfileForm: document.querySelector("#mx-bind-profile-form"),
  profileSelect: document.querySelector("#mx-profile-select"),
  confirmBind: document.querySelector("#mx-confirm-bind"),
  cancelBind: document.querySelector("#mx-cancel-bind"),
  profilesList: document.querySelector("#mx-profiles-list"),
};

const PLATFORM_LABELS = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };

async function fetchMatrices() {
  try {
    const data = await request("/api/matrices");
    mxState.matrices = Array.isArray(data) ? data : [];
    renderMatrices();
  } catch {}
}

function renderMatrices() {
  if (!mxState.matrices.length) {
    mxEl.list.innerHTML = '<div class="empty-state compact" style="padding: 16px;">点击 + 新建矩阵</div>';
    return;
  }
  mxEl.list.innerHTML = mxState.matrices.map((m) => `
    <div class="remix-creator-item ${mxState.selectedId === m.id ? "active" : ""}" data-id="${escapeHtml(m.id)}">
      <div class="remix-creator-info">
        <strong>${escapeHtml(m.name)}</strong>
        <span>${m._count?.profiles || 0}实例 · ${m._count?.accounts || 0}账号 · ${m._count?.videos || 0}视频</span>
      </div>
      <button class="remix-del-btn" data-del-mx="${escapeHtml(m.id)}" title="删除">×</button>
    </div>
  `).join("");
  mxEl.list.querySelectorAll("[data-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.delMx) return;
      mxState.selectedId = el.dataset.id;
      renderMatrices();
      const m = mxState.matrices.find((x) => x.id === mxState.selectedId);
      mxEl.currentName.textContent = m ? m.name : "";
      mxEl.currentInfo.textContent = m ? `${m._count?.profiles || 0}实例 · ${m._count?.accounts || 0}账号 · ${m._count?.videos || 0}视频` : "";
      mxEl.addAccountBtn.disabled = false;
      mxEl.bindProfileBtn.disabled = false;
      fetchMatrixProfiles(mxState.selectedId);
      fetchMatrixAccounts(mxState.selectedId);
      fetchMatrixVideos(mxState.selectedId);
    });
  });
  mxEl.list.querySelectorAll("[data-del-mx]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("删除矩阵将同时删除其所有账号和成品视频，确认？")) return;
      await request(`/api/matrices/${encodeURIComponent(btn.dataset.delMx)}`, { method: "DELETE" });
      if (mxState.selectedId === btn.dataset.delMx) {
        mxState.selectedId = null;
        mxEl.currentName.textContent = "选择左侧矩阵查看详情";
        mxEl.currentInfo.textContent = "";
        mxEl.addAccountBtn.disabled = true;
        mxEl.bindProfileBtn.disabled = true;
        mxEl.accountsList.innerHTML = "";
        mxEl.videosList.innerHTML = "";
        mxEl.profilesList.innerHTML = "";
      }
      await fetchMatrices();
    });
  });
}

async function fetchMatrixProfiles(matrixId) {
  try {
    const data = await request(`/api/matrices/${encodeURIComponent(matrixId)}/profiles`);
    mxState.profiles = Array.isArray(data) ? data : [];
    renderMatrixProfiles();
  } catch { mxState.profiles = []; renderMatrixProfiles(); }
}

function renderMatrixProfiles() {
  if (!mxState.profiles.length) {
    mxEl.profilesList.innerHTML = '<div class="empty-state compact">暂无绑定实例，点击"绑定实例"添加</div>';
    return;
  }
  mxEl.profilesList.innerHTML = mxState.profiles.map((p) => `
    <div class="matrix-profile-item">
      <span class="matrix-profile-seq">#${escapeHtml(String(p.profileSeq ?? "?"))}</span>
      <span class="matrix-profile-name">${escapeHtml(p.profileName || p.profileId)}</span>
      <span class="matrix-profile-status ${p.profileRunning ? "status-running" : "status-stopped"}">${p.profileRunning ? "运行中" : "已停止"}</span>
      <button class="remix-del-btn" data-unbind-profile="${escapeHtml(p.profileId)}" title="解绑">×</button>
    </div>
  `).join("");
  mxEl.profilesList.querySelectorAll("[data-unbind-profile]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/profiles/${encodeURIComponent(btn.dataset.unbindProfile)}`, { method: "DELETE" });
      await fetchMatrixProfiles(mxState.selectedId);
      await fetchMatrices();
      const m = mxState.matrices.find((x) => x.id === mxState.selectedId);
      if (m) mxEl.currentInfo.textContent = `${m._count?.profiles || 0}实例 · ${m._count?.accounts || 0}账号 · ${m._count?.videos || 0}视频`;
    });
  });
}

async function fetchMatrixAccounts(matrixId) {
  try {
    const data = await request(`/api/matrices/${encodeURIComponent(matrixId)}/accounts`);
    mxState.accounts = Array.isArray(data) ? data : [];
    renderMatrixAccounts();
  } catch { mxState.accounts = []; renderMatrixAccounts(); }
}

function renderMatrixAccounts() {
  if (!mxState.accounts.length) {
    mxEl.accountsList.innerHTML = '<div class="empty-state compact">暂无账号，点击"添加账号"</div>';
    return;
  }
  mxEl.accountsList.innerHTML = mxState.accounts.map((a) => `
    <div class="matrix-account-item">
      <span class="matrix-account-platform platform-${escapeHtml(a.platform)}">${escapeHtml(PLATFORM_LABELS[a.platform] || a.platform)}</span>
      <span class="matrix-account-name">${escapeHtml(a.accountName)}</span>
      <button class="remix-del-btn" data-del-acc="${escapeHtml(a.id)}" title="删除">×</button>
    </div>
  `).join("");
  mxEl.accountsList.querySelectorAll("[data-del-acc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/accounts/${encodeURIComponent(btn.dataset.delAcc)}`, { method: "DELETE" });
      await fetchMatrixAccounts(mxState.selectedId);
      await fetchMatrices();
    });
  });
}

async function fetchMatrixVideos(matrixId) {
  try {
    const data = await request(`/api/matrices/${encodeURIComponent(matrixId)}/videos`);
    mxState.videos = Array.isArray(data) ? data : [];
    renderMatrixVideos();
  } catch { mxState.videos = []; renderMatrixVideos(); }
}

function renderMatrixVideos() {
  if (!mxState.videos.length) {
    mxEl.videosList.innerHTML = '<div class="empty-state compact">暂无成品视频</div>';
    return;
  }
  mxEl.videosList.innerHTML = mxState.videos.map((v) => `
    <div class="matrix-video-item">
      <div class="matrix-video-thumb">
        <video src="${escapeHtml(v.filePath)}" muted preload="metadata"></video>
      </div>
      <div class="matrix-video-info">
        <span class="matrix-video-title">${escapeHtml(v.title || v.filePath)}</span>
        <span class="matrix-video-meta">${escapeHtml(v.creatorName || "—")} · ${formatDateTime(v.createdAt)}</span>
      </div>
      <div class="matrix-video-actions">
        ${v.filePath ? `<a href="${escapeHtml(v.filePath)}" download class="button ${v.downloaded ? "button-secondary" : "button-primary"}" style="font-size:11px;padding:2px 8px;" data-mv-id="${escapeHtml(v.id)}">${v.downloaded ? "已下载 ✓" : "下载"}</a>` : ""}
        <button class="remix-del-btn" data-del-mv="${escapeHtml(v.id)}" title="删除">×</button>
      </div>
    </div>
  `).join("");
  mxEl.videosList.querySelectorAll("[data-del-mv]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/videos`, { method: "DELETE", body: JSON.stringify({ videoId: btn.dataset.delMv }) });
      await fetchMatrixVideos(mxState.selectedId);
      await fetchMatrices();
    });
  });
  mxEl.videosList.querySelectorAll("a[data-mv-id]").forEach((a) => {
    a.addEventListener("click", async (e) => {
      if (!a.dataset.mvId) return;
      try {
        await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/videos/${encodeURIComponent(a.dataset.mvId)}/downloaded`, { method: "POST", body: "{}" });
        const vid = mxState.videos.find((x) => x.id === a.dataset.mvId);
        if (vid) vid.downloaded = true;
        renderMatrixVideos();
      } catch {}
    });
  });
}

mxEl.addBtn?.addEventListener("click", () => mxEl.addForm.classList.toggle("hidden"));
mxEl.cancel?.addEventListener("click", () => { mxEl.addForm.classList.add("hidden"); mxEl.name.value = ""; mxEl.notes.value = ""; });
mxEl.confirm?.addEventListener("click", async () => {
  const name = mxEl.name.value.trim();
  if (!name) return;
  try {
    const data = await request("/api/matrices", { method: "POST", body: JSON.stringify({ name, notes: mxEl.notes.value.trim() || null }) });
    mxEl.addForm.classList.add("hidden");
    mxEl.name.value = ""; mxEl.notes.value = "";
    await fetchMatrices();
    mxState.selectedId = data.id;
    renderMatrices();
    mxEl.currentName.textContent = data.name;
    mxEl.currentInfo.textContent = "0实例 · 0账号 · 0视频";
    mxEl.addAccountBtn.disabled = false;
    mxEl.bindProfileBtn.disabled = false;
    fetchMatrixProfiles(data.id);
    fetchMatrixAccounts(data.id);
    fetchMatrixVideos(data.id);
  } catch (e) { showToast(e.message, true); }
});

mxEl.addAccountBtn?.addEventListener("click", () => mxEl.addAccountForm.classList.toggle("hidden"));
mxEl.cancelAccount?.addEventListener("click", () => { mxEl.addAccountForm.classList.add("hidden"); mxEl.accountName.value = ""; });
mxEl.confirmAccount?.addEventListener("click", async () => {
  const platform = mxEl.accountPlatform.value;
  const accountName = mxEl.accountName.value.trim();
  if (!accountName || !mxState.selectedId) return;
  try {
    await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/accounts`, {
      method: "POST", body: JSON.stringify({ platform, accountName }),
    });
    mxEl.addAccountForm.classList.add("hidden");
    mxEl.accountName.value = "";
    await fetchMatrixAccounts(mxState.selectedId);
    await fetchMatrices();
    const m = mxState.matrices.find((x) => x.id === mxState.selectedId);
    if (m) mxEl.currentInfo.textContent = `${m._count?.profiles || 0}实例 · ${m._count?.accounts || 0}账号 · ${m._count?.videos || 0}视频`;
  } catch (e) { showToast(e.message, true); }
});

mxEl.refreshVideos?.addEventListener("click", () => {
  if (mxState.selectedId) fetchMatrixVideos(mxState.selectedId);
});

// 实例绑定
mxEl.bindProfileBtn?.addEventListener("click", async () => {
  mxEl.bindProfileForm.classList.toggle("hidden");
  if (!mxEl.bindProfileForm.classList.contains("hidden")) {
    // 加载可用实例列表
    try {
      const res = await request("/api/profiles");
      const allProfiles = res.profiles || [];
      const boundIds = new Set(mxState.profiles.map((p) => p.profileId));
      const available = allProfiles.filter((p) => !boundIds.has(p.id));
      if (!available.length) {
        mxEl.profileSelect.innerHTML = '<option value="">无可用实例</option>';
      } else {
        mxEl.profileSelect.innerHTML = available
          .map((p) => `<option value="${escapeHtml(p.id)}">#${escapeHtml(String(p.seq))} ${escapeHtml(p.name)}</option>`)
          .join("");
      }
    } catch { mxEl.profileSelect.innerHTML = '<option value="">加载失败</option>'; }
  }
});
mxEl.cancelBind?.addEventListener("click", () => mxEl.bindProfileForm.classList.add("hidden"));
mxEl.confirmBind?.addEventListener("click", async () => {
  const profileId = mxEl.profileSelect.value;
  if (!profileId || !mxState.selectedId) return;
  try {
    await request(`/api/matrices/${encodeURIComponent(mxState.selectedId)}/profiles`, {
      method: "POST", body: JSON.stringify({ profileId }),
    });
    mxEl.bindProfileForm.classList.add("hidden");
    await fetchMatrixProfiles(mxState.selectedId);
    await fetchMatrices();
    const m = mxState.matrices.find((x) => x.id === mxState.selectedId);
    if (m) mxEl.currentInfo.textContent = `${m._count?.profiles || 0}实例 · ${m._count?.accounts || 0}账号 · ${m._count?.videos || 0}视频`;
  } catch (e) { showToast(e.message, true); }
});

// ==========================================================================
// 新建混剪任务弹框
// ==========================================================================
const modalState = {
  matrices: [],
  creators: [],
  videos: [],
  selectedMatrixIds: new Set(),
  selectedCreatorId: null,
  selectedVideoIds: new Set(),
  mode: "stitch",
  videoViewMode: "grid",
};

const modalEl = {
  overlay: document.querySelector("#remix-task-modal"),
  close: document.querySelector("#remix-task-modal-close"),
  cancel: document.querySelector("#remix-task-cancel"),
  start: document.querySelector("#remix-task-start"),
  matrixList: document.querySelector("#modal-matrix-list"),
  creatorList: document.querySelector("#modal-creator-list"),
  videoList: document.querySelector("#modal-video-list"),
  ratio: document.querySelector("#modal-ratio"),
  aiConfig: document.querySelector("#modal-ai-config"),
  stitchConfig: document.querySelector("#modal-stitch-config"),
  introSelect: document.querySelector("#modal-intro-select"),
  outroSelect: document.querySelector("#modal-outro-select"),
  musicSelect: document.querySelector("#modal-music-select"),
  cdpInstance: document.querySelector("#modal-cdp-instance"),
  cdpRefresh: document.querySelector("#modal-cdp-refresh"),
  aiPrompt: document.querySelector("#modal-ai-prompt"),
  aiPreset: document.querySelector("#modal-ai-preset"),
  presetSave: document.querySelector("#modal-preset-save"),
  presetManage: document.querySelector("#modal-preset-manage"),
  viewGridBtn: document.querySelector("#modal-view-grid"),
  viewListBtn: document.querySelector("#modal-view-list"),
};

const presetModalEl = {
  overlay: null,
  list: null,
  name: null,
  prompt: null,
  isDefault: null,
  vars: null,
  save: null,
  introStart: null, introCount: null, introDuration: null, introEffect: null, introTransition: null, introEnabled: null, introFile: null, introFileInfo: null,
  outroStart: null, outroCount: null, outroDuration: null, outroEffect: null, outroTransition: null, outroEnabled: null, outroFile: null, outroFileInfo: null,
  musicVolume: null, musicScope: null, musicLoop: null, musicEnabled: null, musicFile: null, musicFileInfo: null,
};

async function openRemixTaskModal(presetMode = "stitch") {
  modalEl.overlay.classList.remove("hidden");
  modalState.selectedMatrixIds.clear();
  modalState.selectedCreatorId = null;
  modalState.selectedVideoIds.clear();
  modalState.mode = presetMode;

  // 根据按钮来源设置标题和 AI 配置区域
  const isAi = presetMode === "ai";
  const titleEl = document.querySelector("#remix-task-modal-title");
  if (titleEl) titleEl.textContent = isAi ? "新建 AI 混剪任务" : "新建拼接混剪任务";
  modalEl.aiConfig?.classList.toggle("hidden", !isAi);
  modalEl.stitchConfig?.classList.toggle("hidden", isAi);

  // 加载矩阵列表
  try {
    const data = await request("/api/matrices");
    modalState.matrices = Array.isArray(data) ? data : [];
  } catch { modalState.matrices = []; }
  renderModalMatrices();

  // 加载达人列表
  try {
    const data = await request("/api/remix/creators");
    modalState.creators = Array.isArray(data) ? data : [];
  } catch { modalState.creators = []; }
  renderModalCreators();

  // 加载 CDP 实例列表（用于 AI 模式）
  await loadModalCdpInstances();

  modalEl.videoList.innerHTML = '<div class="empty-state compact">请先选择达人</div>';
  modalEl.start.disabled = true;

  // 加载 AI 混剪方案列表
  await fetchAiPresets();
}

async function loadModalCdpInstances() {
  try {
    // 先扫描端口发现运行中的 Chrome 实例
    let scanned = [];
    try {
      const scanRes = await request("/api/cdp/scan", { method: "POST", body: JSON.stringify({ host: "localhost", portStart: 9222, portEnd: 9232 }) });
      scanned = scanRes.instances || [];
    } catch {}
    // 获取数据库中已有的实例
    const existingRes = await request("/api/cdp/instances");
    const existing = existingRes.instances || [];
    // 把扫描到但数据库中不存在的实例自动注册
    for (const s of scanned) {
      if (s.chromeInfo?.Browser && !existing.some((e) => e.cdpHost === s.host && e.cdpPort === s.port)) {
        try {
          await request("/api/cdp/instances", {
            method: "POST",
            body: JSON.stringify({ name: `Chrome ${s.port}`, cdpHost: s.host, cdpPort: s.port }),
          });
        } catch {}
      }
    }
    // 重新加载
    const res = await request("/api/cdp/instances");
    const instances = res.instances || [];
    modalEl.cdpInstance.innerHTML = instances.length
      ? instances.map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} (${escapeHtml(i.cdpHost)}:${i.cdpPort})</option>`).join("")
      : '<option value="">无可用实例</option>';
    updateModalStartBtn();
  } catch {
    modalEl.cdpInstance.innerHTML = '<option value="">加载失败</option>';
  }
}

modalEl.cdpRefresh?.addEventListener("click", async () => {
  modalEl.cdpRefresh.textContent = "扫描中…";
  modalEl.cdpRefresh.disabled = true;
  await loadModalCdpInstances();
  modalEl.cdpRefresh.textContent = "刷新";
  modalEl.cdpRefresh.disabled = false;
  showToast("CDP 实例列表已刷新");
});

function renderModalMatrices() {
  if (!modalState.matrices.length) {
    modalEl.matrixList.innerHTML = '<div class="empty-state compact">暂无矩阵，请先创建</div>';
    return;
  }
  modalEl.matrixList.innerHTML = modalState.matrices.map((m) => `
    <label class="modal-check-item ${modalState.selectedMatrixIds.has(m.id) ? "checked" : ""}">
      <input type="checkbox" value="${escapeHtml(m.id)}" ${modalState.selectedMatrixIds.has(m.id) ? "checked" : ""} />
      <span>${escapeHtml(m.name)}</span>
      <span class="muted-activity" style="font-size: 11px;">${m._count?.accounts || 0}账号</span>
    </label>
  `).join("");
  modalEl.matrixList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) modalState.selectedMatrixIds.add(cb.value);
      else modalState.selectedMatrixIds.delete(cb.value);
      cb.closest("label").classList.toggle("checked", cb.checked);
      updateModalStartBtn();
    });
  });
}

function renderModalCreators() {
  if (!modalState.creators.length) {
    modalEl.creatorList.innerHTML = '<div class="empty-state compact">暂无达人</div>';
    return;
  }
  modalEl.creatorList.innerHTML = modalState.creators.map((c) => `
    <label class="modal-radio-item ${modalState.selectedCreatorId === c.id ? "checked" : ""}">
      <input type="radio" name="modal-creator" value="${escapeHtml(c.id)}" ${modalState.selectedCreatorId === c.id ? "checked" : ""} />
      <span>${escapeHtml(c.name)}</span>
      <span class="muted-activity" style="font-size: 11px;">${c._count?.videos || 0}视频 · ${c._count?.resources || 0}资源</span>
    </label>
  `).join("");
  modalEl.creatorList.querySelectorAll("input[type=radio]").forEach((rb) => {
    rb.addEventListener("change", async () => {
      modalState.selectedCreatorId = rb.value;
      modalState.selectedVideoIds.clear();
      rb.closest("label").classList.add("checked");
      modalEl.creatorList.querySelectorAll("label").forEach((l) => {
        if (l !== rb.closest("label")) l.classList.remove("checked");
      });
      // 加载该达人的视频
      try {
        const data = await request(`/api/remix/creators/${encodeURIComponent(rb.value)}/videos`);
        modalState.videos = Array.isArray(data) ? data : [];
      } catch { modalState.videos = []; }
      renderModalVideos();
      // 加载该达人的资源到下拉框
      try {
        const resData = await request(`/api/remix/creators/${encodeURIComponent(rb.value)}/resources`);
        const resources = Array.isArray(resData) ? resData : [];
        const fillSelect = (sel, type, keepNone) => {
          if (!sel) return;
          const oldVal = sel.value;
          const opts = keepNone
            ? `<option value="">随机</option><option value="none">不加</option>`
            : `<option value="">随机</option>`;
          sel.innerHTML = opts + resources.filter(r => r.type === type).map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.filename || r.title || type)}</option>`).join("");
          sel.value = oldVal;
        };
        fillSelect(modalEl.introSelect, "intro");
        fillSelect(modalEl.outroSelect, "outro");
        fillSelect(modalEl.musicSelect, "music", true);
      } catch {}
      updateModalStartBtn();
    });
  });
}

function renderModalVideos() {
  if (!modalState.videos.length) {
    modalEl.videoList.innerHTML = '<div class="empty-state compact">该达人暂无视频</div>';
    modalEl.videoList.className = "modal-video-list";
    return;
  }
  const isList = modalState.videoViewMode === "list";
  modalEl.videoList.className = isList ? "modal-video-list modal-video-list-view" : "modal-video-list modal-video-grid-view";

  modalEl.videoList.innerHTML = modalState.videos.map((v) => {
    const checked = modalState.selectedVideoIds.has(v.id);
    const thumb = `<video src="${escapeHtml(v.url)}#t=0.1" muted preload="metadata" class="modal-video-thumb"></video>`;
    const title = escapeHtml(v.title || "未命名");
    const matrixInfo = v.matrixLinks?.length ? `<span class="muted-activity" style="font-size: 10px;">已链接${v.matrixLinks.length}个矩阵</span>` : "";
    const checkbox = `<input type="checkbox" value="${escapeHtml(v.id)}" ${checked ? "checked" : ""} />`;

    if (isList) {
      return `<label class="modal-check-item modal-video-row ${checked ? "checked" : ""}">
        ${checkbox}
        ${thumb}
        <div class="modal-video-row-info">
          <span class="modal-video-row-title">${title}</span>
          ${matrixInfo}
        </div>
      </label>`;
    }
    return `<label class="modal-check-item modal-video-card ${checked ? "checked" : ""}">
      ${checkbox}
      ${thumb}
      <span class="modal-video-card-title">${title}</span>
      ${matrixInfo}
    </label>`;
  }).join("");

  modalEl.videoList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) modalState.selectedVideoIds.add(cb.value);
      else modalState.selectedVideoIds.delete(cb.value);
      cb.closest("label").classList.toggle("checked", cb.checked);
      updateModalStartBtn();
    });
  });
}

// 视图切换
modalEl.viewGridBtn?.addEventListener("click", () => {
  modalState.videoViewMode = "grid";
  modalEl.viewGridBtn.classList.add("active");
  modalEl.viewListBtn?.classList.remove("active");
  renderModalVideos();
});
modalEl.viewListBtn?.addEventListener("click", () => {
  modalState.videoViewMode = "list";
  modalEl.viewListBtn.classList.add("active");
  modalEl.viewGridBtn?.classList.remove("active");
  renderModalVideos();
});

function updateModalStartBtn() {
  const baseReady = modalState.selectedMatrixIds.size > 0 && modalState.selectedCreatorId && modalState.selectedVideoIds.size > 0;
  let aiReady = true;
  if (modalState.mode === "ai") {
    aiReady = !!modalEl.cdpInstance.value;
  }
  modalEl.start.disabled = !(baseReady && aiReady);
}

modalEl.cdpInstance?.addEventListener("change", updateModalStartBtn);

// AI 混剪方案管理
let aiPresets = [];

async function fetchAiPresets() {
  try {
    const data = await request("/api/ai-presets");
    aiPresets = Array.isArray(data) ? data : [];
    renderAiPresetSelect();
  } catch { aiPresets = []; renderAiPresetSelect(); }
}

function renderAiPresetSelect() {
  if (!modalEl.aiPreset) return;
  if (!aiPresets.length) {
    modalEl.aiPreset.innerHTML = '<option value="">无方案</option>';
    return;
  }
  modalEl.aiPreset.innerHTML = '<option value="">— 选择方案 —</option>' +
    aiPresets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.isDefault ? " ★" : ""}${p.files?.length ? ` (${p.files.length}文件)` : ""}</option>`).join("");
  // 默认选中 isDefault 方案
  const defaultPreset = aiPresets.find((p) => p.isDefault);
  if (defaultPreset) {
    modalEl.aiPreset.value = defaultPreset.id;
  }
}

// 解析提示词中的 {{变量名}} 占位符
function parseTemplateVars(prompt) {
  const regex = /\{\{(.+?)\}\}/g;
  const vars = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(prompt)) !== null) {
    const name = match[1].trim();
    if (name && !seen.has(name)) { seen.add(name); vars.push(name); }
  }
  return vars;
}

modalEl.aiPreset?.addEventListener("change", () => {
  const presetId = modalEl.aiPreset.value;
  if (!presetId) { modalEl.aiPrompt.value = ""; return; }
  const preset = aiPresets.find((p) => p.id === presetId);
  if (preset) modalEl.aiPrompt.value = preset.prompt;
});

// 另存为方案
modalEl.presetSave?.addEventListener("click", async () => {
  const prompt = modalEl.aiPrompt.value.trim();
  if (!prompt) { showToast("提示词为空，无法保存", true); return; }
  const name = window.prompt("请输入方案名称：");
  if (!name) return;
  try {
    await request("/api/ai-presets", { method: "POST", body: JSON.stringify({ name, prompt, isDefault: false }) });
    showToast("方案已保存");
    await fetchAiPresets();
  } catch (e) { showToast(e.message, true); }
});

// 管理方案弹框 — 列表
modalEl.presetManage?.addEventListener("click", () => openPresetListModal());

let currentEditPresetId = null;
let pendingSegmentFiles = { intro: null, outro: null, music: null };
const pendingVarFiles = new Map();

async function openPresetListModal() {
  let overlay = document.querySelector("#preset-list-modal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "preset-list-modal";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-content" style="max-width: 560px;">
        <div class="modal-header">
          <h3>混剪方案管理</h3>
          <button id="preset-list-close" class="modal-close" type="button">×</button>
        </div>
        <div class="modal-body">
          <div style="margin-bottom: 12px;">
            <button id="preset-list-add-btn" class="button button-primary" type="button">+ 新增方案</button>
          </div>
          <div id="preset-list-container" class="preset-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#preset-list-close").addEventListener("click", () => { overlay.classList.add("hidden"); fetchAiPresets(); });
    overlay.querySelector("#preset-list-add-btn").addEventListener("click", () => openPresetEditModal(null));
    presetModalEl.list = overlay.querySelector("#preset-list-container");
  }
  overlay.classList.remove("hidden");
  await fetchAiPresets();
  renderPresetList();
}

function openPresetEditModal(preset) {
  const isEdit = !!preset;
  const existing = document.querySelector("#preset-edit-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "preset-edit-modal";
  overlay.className = "modal-overlay";

  const EFFECTS = `<option value="none">硬切（无动效）</option><option value="fade">淡入淡出</option><option value="slide_left">左滑入</option><option value="slide_right">右滑入</option><option value="slide_up">上滑入</option><option value="slide_down">下滑入</option><option value="zoom_in">放大（Ken Burns）</option><option value="zoom_out">缩小</option><option value="bounce">弹动</option><option value="rotate">旋转入场</option><option value="blur">模糊到清晰</option><option value="flash">闪白转场</option>`;

  const TRANSITIONS = `<option value="none">无转场（硬切）</option><option value="fade">淡入淡出</option><option value="dissolve">叠化</option><option value="slide_left">左滑</option><option value="slide_right">右滑</option><option value="slide_up">上滑</option><option value="slide_down">下滑</option><option value="zoom_in">放大</option><option value="zoom_out">缩小</option><option value="blur">模糊</option><option value="flash">闪白</option><option value="black">闪黑</option>`;

  overlay.innerHTML = `
    <div class="modal-content" style="max-width: 680px;">
      <div class="modal-header">
        <h3>${isEdit ? "编辑方案" : "新增方案"}</h3>
        <button id="preset-edit-close" class="modal-close" type="button">×</button>
      </div>
      <div class="modal-body">
        <div class="preset-form">
          <input type="text" id="preset-form-name" placeholder="方案名称" />
          <textarea id="preset-form-prompt" rows="5" placeholder="提示词内容，使用 {{变量名}} 定义需要上传的资源变量"></textarea>
          <label class="preset-default-label">
            <input type="checkbox" id="preset-form-default" ${isEdit && preset.isDefault ? "checked" : ""} /> 设为默认方案
          </label>
          <div id="preset-form-vars" class="preset-form-vars"></div>
          <div class="preset-config-section">
            <div class="preset-config-title"><label><input type="checkbox" id="preset-intro-enabled" checked /> 启用片头</label></div>
            <div class="preset-config-row">
              <label>开始插入图片时间 <input type="text" id="preset-intro-start" value="00:00:00:00" placeholder="时:分:秒:帧" /></label>
              <label>插入图片数量 <input type="number" id="preset-intro-count" min="0" value="8" /></label>
              <label>每张图片持续 <input type="text" id="preset-intro-duration" value="00:00:00:12" placeholder="时:分:秒:帧" /></label>
            </div>
            <div class="preset-config-row">
              <label>图片动效 <select id="preset-intro-effect">${EFFECTS}</select></label>
              <label>正片切换转场 <select id="preset-intro-transition">${TRANSITIONS}</select></label>
              <label>片头片段文件 <input type="file" id="preset-intro-file" accept="video/*" /></label>
            </div>
            <span id="preset-intro-file-info" class="preset-file-info"></span>
          </div>
          <div class="preset-config-section">
            <div class="preset-config-title"><label><input type="checkbox" id="preset-outro-enabled" checked /> 启用片尾</label></div>
            <div class="preset-config-row">
              <label>开始插入图片时间 <input type="text" id="preset-outro-start" value="00:00:00:00" placeholder="时:分:秒:帧" /></label>
              <label>插入图片数量 <input type="number" id="preset-outro-count" min="0" value="4" /></label>
              <label>每张图片持续 <input type="text" id="preset-outro-duration" value="00:00:05:00" placeholder="时:分:秒:帧" /></label>
            </div>
            <div class="preset-config-row">
              <label>图片动效 <select id="preset-outro-effect">${EFFECTS}</select></label>
              <label>正片切换转场 <select id="preset-outro-transition">${TRANSITIONS}</select></label>
              <label>片尾片段文件 <input type="file" id="preset-outro-file" accept="video/*" /></label>
            </div>
            <span id="preset-outro-file-info" class="preset-file-info"></span>
          </div>
          <div class="preset-config-section">
            <div class="preset-config-title"><label><input type="checkbox" id="preset-music-enabled" checked /> 启用背景音乐</label></div>
            <div class="preset-config-row">
              <label>音量百分比 <input type="number" id="preset-music-volume" min="1" max="100" value="8" /></label>
              <label>适用范围
                <select id="preset-music-scope">
                  <option value="original">仅原视频部分（默认）</option>
                  <option value="full">整个成品视频</option>
                  <option value="intro">仅片头</option>
                  <option value="outro">仅片尾</option>
                  <option value="intro_outro">片头+片尾</option>
                  <option value="none">不加背景音乐</option>
                </select>
              </label>
              <label>音乐不够长时循环 <input type="checkbox" id="preset-music-loop" checked /></label>
            </div>
            <div class="preset-config-row">
              <label>背景音乐文件 <input type="file" id="preset-music-file" accept="audio/*" /></label>
            </div>
            <span id="preset-music-file-info" class="preset-file-info"></span>
          </div>
          <div class="preset-form-actions">
            <button id="preset-form-save" class="button button-primary" type="button">${isEdit ? "保存修改" : "创建方案"}</button>
            <button id="preset-form-cancel" class="button button-secondary" type="button">取消</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  presetModalEl.overlay = overlay;
  presetModalEl.name = overlay.querySelector("#preset-form-name");
  presetModalEl.prompt = overlay.querySelector("#preset-form-prompt");
  presetModalEl.isDefault = overlay.querySelector("#preset-form-default");
  presetModalEl.vars = overlay.querySelector("#preset-form-vars");
  presetModalEl.save = overlay.querySelector("#preset-form-save");
  presetModalEl.introStart = overlay.querySelector("#preset-intro-start");
  presetModalEl.introCount = overlay.querySelector("#preset-intro-count");
  presetModalEl.introDuration = overlay.querySelector("#preset-intro-duration");
  presetModalEl.introEffect = overlay.querySelector("#preset-intro-effect");
  presetModalEl.introTransition = overlay.querySelector("#preset-intro-transition");
  presetModalEl.introEnabled = overlay.querySelector("#preset-intro-enabled");
  presetModalEl.introFile = overlay.querySelector("#preset-intro-file");
  presetModalEl.introFileInfo = overlay.querySelector("#preset-intro-file-info");
  presetModalEl.outroStart = overlay.querySelector("#preset-outro-start");
  presetModalEl.outroCount = overlay.querySelector("#preset-outro-count");
  presetModalEl.outroDuration = overlay.querySelector("#preset-outro-duration");
  presetModalEl.outroEffect = overlay.querySelector("#preset-outro-effect");
  presetModalEl.outroTransition = overlay.querySelector("#preset-outro-transition");
  presetModalEl.outroEnabled = overlay.querySelector("#preset-outro-enabled");
  presetModalEl.outroFile = overlay.querySelector("#preset-outro-file");
  presetModalEl.outroFileInfo = overlay.querySelector("#preset-outro-file-info");
  presetModalEl.musicVolume = overlay.querySelector("#preset-music-volume");
  presetModalEl.musicScope = overlay.querySelector("#preset-music-scope");
  presetModalEl.musicLoop = overlay.querySelector("#preset-music-loop");
  presetModalEl.musicEnabled = overlay.querySelector("#preset-music-enabled");
  presetModalEl.musicFile = overlay.querySelector("#preset-music-file");
  presetModalEl.musicFileInfo = overlay.querySelector("#preset-music-file-info");

  // 通过 JS 设置编辑值（避免模板字符串被 prompt 中的反引号破坏）
  if (isEdit) {
    presetModalEl.name.value = preset.name;
    presetModalEl.prompt.value = preset.prompt;
  }

  overlay.querySelector("#preset-edit-close").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#preset-form-cancel").addEventListener("click", () => overlay.remove());
  presetModalEl.save.addEventListener("click", () => isEdit ? handlePresetUpdate() : handlePresetAdd());
  presetModalEl.prompt.addEventListener("input", () => renderPresetFormVars(isEdit ? preset : null));
  presetModalEl.introFile.addEventListener("change", (e) => handleSegmentFileUpload(e, "intro"));
  presetModalEl.outroFile.addEventListener("change", (e) => handleSegmentFileUpload(e, "outro"));
  presetModalEl.musicFile.addEventListener("change", (e) => handleSegmentFileUpload(e, "music"));

  currentEditPresetId = isEdit ? preset.id : null;
  pendingSegmentFiles = { intro: null, outro: null, music: null };
  pendingVarFiles.clear();
  if (isEdit) {
    fillPresetConfigForm(preset);
    renderPresetFormVars(preset);
  } else {
    fillPresetConfigForm(null);
    renderPresetFormVars(null);
  }

  overlay.classList.remove("hidden");
}

// 时间码 HH:MM:SS:FF (30fps) → 秒
function timecodeToSeconds(tc) {
  if (typeof tc === "number") return tc;
  if (!tc || typeof tc !== "string") return 0;
  const m = tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) { const n = parseFloat(tc); return isNaN(n) ? 0 : n; }
  const [, h, mi, s, f] = m;
  return (parseInt(h) * 3600 + parseInt(mi) * 60 + parseInt(s) + parseInt(f) / 30);
}

// 秒 → 时间码 HH:MM:SS:FF (30fps)
function secondsToTimecode(sec) {
  if (typeof sec === "string" && /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(sec)) return sec;
  const n = parseFloat(sec) || 0;
  const h = Math.floor(n / 3600);
  const mi = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  const f = Math.round((n - Math.floor(n)) * 30);
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f % 30).padStart(2, "0")}`;
}

function collectPresetConfig() {
  const introConfig = {
    enabled: presetModalEl.introEnabled?.checked ?? true,
    imageInsertStart: timecodeToSeconds(presetModalEl.introStart?.value),
    imageCount: parseInt(presetModalEl.introCount?.value) || 0,
    imageDuration: timecodeToSeconds(presetModalEl.introDuration?.value),
    effect: presetModalEl.introEffect?.value || "none",
    transition: presetModalEl.introTransition?.value || "none",
    segmentFilePath: pendingSegmentFiles.intro ? pendingSegmentFiles.intro.filePath : null,
  };
  const outroConfig = {
    enabled: presetModalEl.outroEnabled?.checked ?? true,
    imageInsertStart: timecodeToSeconds(presetModalEl.outroStart?.value),
    imageCount: parseInt(presetModalEl.outroCount?.value) || 0,
    imageDuration: timecodeToSeconds(presetModalEl.outroDuration?.value),
    effect: presetModalEl.outroEffect?.value || "none",
    transition: presetModalEl.outroTransition?.value || "none",
    segmentFilePath: pendingSegmentFiles.outro ? pendingSegmentFiles.outro.filePath : null,
  };
  const musicConfig = {
    enabled: presetModalEl.musicEnabled?.checked ?? true,
    volumePercent: parseInt(presetModalEl.musicVolume?.value) || 8,
    scope: presetModalEl.musicScope?.value || "original",
    loop: presetModalEl.musicLoop?.checked ?? true,
    segmentFilePath: pendingSegmentFiles.music ? pendingSegmentFiles.music.filePath : null,
  };
  return { introConfig, outroConfig, musicConfig };
}

function fillPresetConfigForm(preset) {
  const ic = preset?.introConfig || {};
  const oc = preset?.outroConfig || {};
  const mc = preset?.musicConfig || {};
  if (presetModalEl.introEnabled) presetModalEl.introEnabled.checked = ic.enabled !== false;
  if (presetModalEl.introStart) presetModalEl.introStart.value = secondsToTimecode(ic.imageInsertStart ?? 0);
  if (presetModalEl.introCount) presetModalEl.introCount.value = ic.imageCount ?? 8;
  if (presetModalEl.introDuration) presetModalEl.introDuration.value = secondsToTimecode(ic.imageDuration ?? 0.4);
  if (presetModalEl.introEffect) presetModalEl.introEffect.value = ic.effect || "none";
  if (presetModalEl.introTransition) presetModalEl.introTransition.value = ic.transition || "none";
  if (presetModalEl.outroStart) presetModalEl.outroStart.value = secondsToTimecode(oc.imageInsertStart ?? 0);
  if (presetModalEl.outroCount) presetModalEl.outroCount.value = oc.imageCount ?? 4;
  if (presetModalEl.outroDuration) presetModalEl.outroDuration.value = secondsToTimecode(oc.imageDuration ?? 5);
  if (presetModalEl.outroEffect) presetModalEl.outroEffect.value = oc.effect || "none";
  if (presetModalEl.outroTransition) presetModalEl.outroTransition.value = oc.transition || "none";
  if (presetModalEl.outroEnabled) presetModalEl.outroEnabled.checked = oc.enabled !== false;
  if (presetModalEl.musicVolume) presetModalEl.musicVolume.value = mc.volumePercent ?? 8;
  if (presetModalEl.musicScope) presetModalEl.musicScope.value = mc.scope || "original";
  if (presetModalEl.musicEnabled) presetModalEl.musicEnabled.checked = mc.enabled !== false;
  if (presetModalEl.musicLoop) presetModalEl.musicLoop.checked = mc.loop ?? true;
  // 显示已绑定的片段文件名
  if (presetModalEl.introFileInfo) {
    const introFile = preset?.files?.find((f) => f.varName === "_intro_segment");
    presetModalEl.introFileInfo.textContent = introFile ? `已绑定: ${introFile.filename}` : (ic.segmentFilePath ? "已上传（待保存）" : "");
  }
  if (presetModalEl.outroFileInfo) {
    const outroFile = preset?.files?.find((f) => f.varName === "_outro_segment");
    presetModalEl.outroFileInfo.textContent = outroFile ? `已绑定: ${outroFile.filename}` : (oc.segmentFilePath ? "已上传（待保存）" : "");
  }
  if (presetModalEl.musicFileInfo) {
    const musicFile = preset?.files?.find((f) => f.varName === "_music_segment");
    presetModalEl.musicFileInfo.textContent = musicFile ? `已绑定: ${musicFile.filename}` : (mc.segmentFilePath ? "已上传（待保存）" : "");
  }
  pendingSegmentFiles = { intro: null, outro: null, music: null };
}

async function handleSegmentFileUpload(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/remix/upload", { method: "POST", body: formData });
    if (!res.ok) throw new Error("上传失败");
    const data = await res.json();
    pendingSegmentFiles[type] = { filePath: data.url, filename: file.name };
    const infoEl = { intro: presetModalEl.introFileInfo, outro: presetModalEl.outroFileInfo, music: presetModalEl.musicFileInfo }[type];
    const label = { intro: "片头", outro: "片尾", music: "背景音乐" }[type];
    if (infoEl) infoEl.textContent = `已上传: ${file.name}（保存方案后绑定）`;
    showToast(`${label}文件已上传`);
  } catch (e) { showToast(e.message, true); }
}

// 在方案编辑表单中渲染变量上传组件
function renderPresetFormVars(preset) {
  if (!presetModalEl.vars) return;
  const prompt = presetModalEl.prompt.value || "";
  const vars = parseTemplateVars(prompt);
  if (!vars.length) {
    presetModalEl.vars.innerHTML = "";
    return;
  }
  const boundFiles = preset?.files || [];
  presetModalEl.vars.innerHTML = vars.map((v) => {
    const bound = boundFiles.find((f) => f.varName === v);
    return `
      <div class="preset-var-item" data-var="${escapeHtml(v)}">
        <span class="preset-var-name">${escapeHtml(v)}</span>
        <input type="file" data-var-file="${escapeHtml(v)}" class="preset-var-input" />
        <span class="preset-var-filename">${bound ? escapeHtml(bound.filename) : "未绑定"}</span>
        ${bound ? `<span class="preset-var-bound" data-bound-var="${escapeHtml(v)}">✓ 已绑定</span>` : ""}
      </div>
    `;
  }).join("");

  presetModalEl.vars.querySelectorAll("input[data-var-file]").forEach((input) => {
    input.addEventListener("change", async () => {
      const varName = input.dataset.varFile;
      const file = input.files[0];
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("type", "intro");
        const res = await fetch("/api/remix/upload", { method: "POST", body: formData });
        if (!res.ok) throw new Error("上传失败");
        const data = await res.json();
        // 如果正在编辑已有方案，直接绑定到方案
        if (currentEditPresetId) {
          await request(`/api/ai-presets/${encodeURIComponent(currentEditPresetId)}/files`, {
            method: "POST",
            body: JSON.stringify({ varName, filePath: data.url, filename: file.name }),
          });
          showToast(`${varName} 已绑定`);
          await refreshPresetData();
        } else {
          // 暂存，等方案创建后绑定
          pendingVarFiles.set(varName, { filePath: data.url, filename: file.name });
          showToast(`${varName} 已上传，保存方案后自动绑定`);
        }
        const filenameEl = input.parentElement.querySelector(".preset-var-filename");
        if (filenameEl) filenameEl.textContent = file.name;
      } catch (e) { showToast(`${varName}: ${e.message}`, true); }
    });
  });
}

async function refreshPresetData() {
  await fetchAiPresets();
  renderPresetList();
}

function renderPresetList() {
  if (!presetModalEl.list) return;
  if (!aiPresets.length) {
    presetModalEl.list.innerHTML = '<div class="empty-state compact">暂无方案</div>';
    return;
  }
  presetModalEl.list.innerHTML = aiPresets.map((p) => `
    <div class="preset-item" data-id="${escapeHtml(p.id)}">
      <div class="preset-item-info">
        <span class="preset-item-name">${escapeHtml(p.name)}${p.isDefault ? ' <span class="preset-default-tag">默认</span>' : ""}</span>
        <span class="preset-item-prompt">${escapeHtml(p.prompt.slice(0, 80))}${p.prompt.length > 80 ? "…" : ""}</span>
      </div>
      <div class="preset-item-actions">
        <button class="button button-secondary" data-edit="${escapeHtml(p.id)}" type="button" style="font-size:11px;padding:2px 8px;">编辑</button>
        <button class="danger-button" data-del="${escapeHtml(p.id)}" type="button" style="font-size:11px;padding:2px 6px;">删除</button>
      </div>
    </div>
  `).join("");

  presetModalEl.list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = aiPresets.find((p) => p.id === btn.dataset.edit);
      if (!preset) return;
      openPresetEditModal(preset);
    });
  });
  presetModalEl.list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("删除此方案？")) return;
      await request(`/api/ai-presets/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
      await fetchAiPresets();
      renderPresetList();
    });
  });
}

// 获取视频/音频文件时长（秒），通过后端 API
async function getVideoDuration(filePath) {
  try {
    const res = await request(`/api/remix/probe?path=${encodeURIComponent(filePath)}`);
    return res.duration || 0;
  } catch { return 0; }
}

async function handlePresetAdd() {
  const name = presetModalEl.name.value.trim();
  const prompt = presetModalEl.prompt.value.trim();
  if (!name || !prompt) { showToast("名称和提示词不能为空", true); return; }
  const { introConfig, outroConfig, musicConfig } = collectPresetConfig();
  // 校验：图片开始时间+总持续时间不能超过片段时长
  const introTotal = (introConfig.imageInsertStart || 0) + (introConfig.imageCount || 0) * (introConfig.imageDuration || 0);
  const outroTotal = (outroConfig.imageInsertStart || 0) + (outroConfig.imageCount || 0) * (outroConfig.imageDuration || 0);
  if (introConfig.segmentFilePath && introTotal <= 0) { showToast("片头图片配置无效：开始时间+图片总时长必须大于0", true); return; }
  if (outroConfig.segmentFilePath && outroTotal <= 0) { showToast("片尾图片配置无效：开始时间+图片总时长必须大于0", true); return; }
  if (introConfig.segmentFilePath) {
    const segDur = await getVideoDuration(introConfig.segmentFilePath);
    if (segDur > 0 && introTotal > segDur) {
      showToast(`片头图片总时长(${introTotal.toFixed(1)}秒)超出片头视频时长(${segDur.toFixed(1)}秒)，请调整图片数量或持续时间`, true);
      return;
    }
  }
  if (outroConfig.segmentFilePath) {
    const segDur = await getVideoDuration(outroConfig.segmentFilePath);
    if (segDur > 0 && outroTotal > segDur) {
      showToast(`片尾图片总时长(${outroTotal.toFixed(1)}秒)超出片尾视频时长(${segDur.toFixed(1)}秒)，请调整图片数量或持续时间`, true);
      return;
    }
  }
  try {
    const created = await request("/api/ai-presets", {
      method: "POST",
      body: JSON.stringify({ name, prompt, isDefault: presetModalEl.isDefault.checked, introConfig, outroConfig, musicConfig }),
    });
    // 绑定暂存的变量文件
    if (pendingVarFiles.size > 0) {
      for (const [varName, { filePath, filename }] of pendingVarFiles) {
        await request(`/api/ai-presets/${encodeURIComponent(created.id)}/files`, {
          method: "POST",
          body: JSON.stringify({ varName, filePath, filename }),
        });
      }
      pendingVarFiles.clear();
    }
    // 绑定片头/片尾片段文件
    if (pendingSegmentFiles.intro) {
      await request(`/api/ai-presets/${encodeURIComponent(created.id)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_intro_segment", filePath: pendingSegmentFiles.intro.filePath, filename: pendingSegmentFiles.intro.filename }),
      });
    }
    if (pendingSegmentFiles.outro) {
      await request(`/api/ai-presets/${encodeURIComponent(created.id)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_outro_segment", filePath: pendingSegmentFiles.outro.filePath, filename: pendingSegmentFiles.outro.filename }),
      });
    }
    if (pendingSegmentFiles.music) {
      await request(`/api/ai-presets/${encodeURIComponent(created.id)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_music_segment", filePath: pendingSegmentFiles.music.filePath, filename: pendingSegmentFiles.music.filename }),
      });
    }
    pendingSegmentFiles = { intro: null, outro: null, music: null };
    showToast("方案已新增");
    // 关闭编辑弹框，刷新列表
    presetModalEl.overlay?.remove();
    await fetchAiPresets();
    renderPresetList();
  } catch (e) { showToast(e.message, true); }
}

async function handlePresetUpdate() {
  const name = presetModalEl.name.value.trim();
  const prompt = presetModalEl.prompt.value.trim();
  if (!currentEditPresetId) { showToast("请先点击方案列表中的「编辑」", true); return; }
  const { introConfig, outroConfig, musicConfig } = collectPresetConfig();
  // 校验：图片开始时间+总持续时间不能超过片段时长
  const introTotal = (introConfig.imageInsertStart || 0) + (introConfig.imageCount || 0) * (introConfig.imageDuration || 0);
  const outroTotal = (outroConfig.imageInsertStart || 0) + (outroConfig.imageCount || 0) * (outroConfig.imageDuration || 0);
  if (introConfig.segmentFilePath && introTotal <= 0) { showToast("片头图片配置无效：开始时间+图片总时长必须大于0", true); return; }
  if (outroConfig.segmentFilePath && outroTotal <= 0) { showToast("片尾图片配置无效：开始时间+图片总时长必须大于0", true); return; }
  if (introConfig.segmentFilePath) {
    const segDur = await getVideoDuration(introConfig.segmentFilePath);
    if (segDur > 0 && introTotal > segDur) {
      showToast(`片头图片总时长(${introTotal.toFixed(1)}秒)超出片头视频时长(${segDur.toFixed(1)}秒)，请调整图片数量或持续时间`, true);
      return;
    }
  }
  if (outroConfig.segmentFilePath) {
    const segDur = await getVideoDuration(outroConfig.segmentFilePath);
    if (segDur > 0 && outroTotal > segDur) {
      showToast(`片尾图片总时长(${outroTotal.toFixed(1)}秒)超出片尾视频时长(${segDur.toFixed(1)}秒)，请调整图片数量或持续时间`, true);
      return;
    }
  }
  try {
    await request(`/api/ai-presets/${encodeURIComponent(currentEditPresetId)}`, {
      method: "PUT",
      body: JSON.stringify({ name, prompt, isDefault: presetModalEl.isDefault.checked, introConfig, outroConfig, musicConfig }),
    });
    // 绑定新上传的片头/片尾片段文件
    if (pendingSegmentFiles.intro) {
      await request(`/api/ai-presets/${encodeURIComponent(currentEditPresetId)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_intro_segment", filePath: pendingSegmentFiles.intro.filePath, filename: pendingSegmentFiles.intro.filename }),
      });
    }
    if (pendingSegmentFiles.outro) {
      await request(`/api/ai-presets/${encodeURIComponent(currentEditPresetId)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_outro_segment", filePath: pendingSegmentFiles.outro.filePath, filename: pendingSegmentFiles.outro.filename }),
      });
    }
    if (pendingSegmentFiles.music) {
      await request(`/api/ai-presets/${encodeURIComponent(currentEditPresetId)}/files`, {
        method: "POST", body: JSON.stringify({ varName: "_music_segment", filePath: pendingSegmentFiles.music.filePath, filename: pendingSegmentFiles.music.filename }),
      });
    }
    pendingSegmentFiles = { intro: null, outro: null, music: null };
    showToast("方案已更新");
    presetModalEl.overlay?.remove();
    await fetchAiPresets();
    renderPresetList();
  } catch (e) { showToast(e.message, true); }
}

modalEl.close?.addEventListener("click", () => modalEl.overlay.classList.add("hidden"));
modalEl.cancel?.addEventListener("click", () => modalEl.overlay.classList.add("hidden"));

modalEl.start?.addEventListener("click", async () => {
  if (modalEl.start.disabled) return;
  const matrixIds = [...modalState.selectedMatrixIds];
  const creatorId = modalState.selectedCreatorId;
  const videoIds = [...modalState.selectedVideoIds];
  const ratio = modalEl.ratio.value;
  const mode = modalState.mode;

  // 进入 loading 状态
  const origText = modalEl.start.textContent;
  modalEl.start.disabled = true;
  modalEl.start.textContent = "提交中…";
  modalEl.start.classList.add("loading");

  try {
    if (mode === "ai") {
      // AI 混剪
      const cdpInstanceId = modalEl.cdpInstance.value;
      const presetId = modalEl.aiPreset.value || null;
      if (!cdpInstanceId) { showToast("请选择 CDP 实例", true); return; }

      // 检查方案变量是否都已绑定文件
      if (presetId) {
        const preset = aiPresets.find((p) => p.id === presetId);
        if (preset) {
          const vars = parseTemplateVars(preset.prompt);
          const boundVars = new Set((preset.files || []).map((f) => f.varName));
          const missingVars = vars.filter((v) => !boundVars.has(v));
          if (missingVars.length) {
            showToast(`方案中以下变量未绑定文件：${missingVars.join("、")}，请到「管理方案」中上传`, true);
            return;
          }
        }
      }

      // 检查 CDP 实例的 daemon 是否在运行
      let daemonRunning = false;
      try {
        const statusRes = await request(`/api/cdp/instances/${encodeURIComponent(cdpInstanceId)}/daemon-status`);
        daemonRunning = statusRes.running === true;
      } catch {}
      if (!daemonRunning) {
        showToast("CDP 守护进程未运行，请先到 CDP Tab 启动守护进程", true);
        return;
      }

      const res = await request("/api/remix/ai-remix-task", {
        method: "POST",
        body: JSON.stringify({ matrixIds, creatorId, videoIds, cdpInstanceId, ratio, presetId }),
      });
      modalEl.overlay.classList.add("hidden");
      const msg = res.count > 1
        ? `已创建 ${res.count} 个 AI 混剪任务，最多同时运行 3 个，每个任务间隔 1 分钟启动`
        : `已创建 1 个 AI 混剪任务，正在处理…`;
      showToast(msg);
    } else {
      // 素材直接拼接
      const introId = modalEl.introSelect?.value || "";
      const outroId = modalEl.outroSelect?.value || "";
      const musicId = modalEl.musicSelect?.value || "";
      const introEnabled = document.querySelector("#modal-intro-enabled")?.checked ?? true;
      const outroEnabled = document.querySelector("#modal-outro-enabled")?.checked ?? true;
      const musicEnabled = document.querySelector("#modal-music-enabled")?.checked ?? true;
      const res = await request("/api/remix/matrix-task", {
        method: "POST",
        body: JSON.stringify({ matrixIds, creatorId, videoIds, ratio, introId, outroId, musicId, introEnabled, outroEnabled, musicEnabled }),
      });
      modalEl.overlay.classList.add("hidden");
      showToast(`已创建 ${res.count} 个混剪任务，正在处理…`);
    }
    await fetchRemixTasks();
    if (remix.selectedCreatorId) {
      await fetchRemixVideos(remix.selectedCreatorId);
      await fetchRemixCreators();
    }
  } catch (e) {
    showToast(e.message, true);
  } finally {
    modalEl.start.disabled = false;
    modalEl.start.textContent = origText;
    modalEl.start.classList.remove("loading");
  }
});
fetchRemixCreators();
fetchRemixTasks();

// 初始化默认显示第一个 tab（视频去重与混剪）
document.querySelector('.platform-tab[data-platform="remix"]')?.click();
