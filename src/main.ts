import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CLAUDE_ICON, CODEX_ICON } from "./icons";

type ProviderId = "claude" | "codex";

interface UsageSnapshot {
  session_5h_pct: number;
  session_5h_reset_at: string;
  weekly_pct: number;
  weekly_reset_at: string;
  fetched_at: string;
  plan: string;
}

interface CodexUsageSnapshot {
  session_5h_pct: number | null;
  session_5h_reset_at: string | null;
  weekly_pct: number | null;
  weekly_reset_at: string | null;
  fetched_at: string;
  plan_type: string | null;
}

interface ProviderUsage {
  sessionPct: number | null;
  weeklyPct: number | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
}

interface StatusSnapshot {
  indicator: string;
  description: string;
  fetched_at: string;
}

interface AgentSession {
  id: string;
  provider: ProviderId;
  project: string;
  cwd: string | null;
  title: string | null;
  state: "working" | "awaiting" | "finished" | "closed";
  event_type: string;
  tool_name: string | null;
  tool_target: string | null;
  tool_input: Record<string, unknown> | null;
  message: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  owner_pid?: number | null;
  active_subagents?: number;
}

interface AgentRequest {
  id: string;
  session_id: string;
  provider: ProviderId;
  kind: "permission" | "question";
  tool_name: string;
  tool_input: Record<string, any>;
  created_at: number;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface AgentQuestion {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const notch = $("notch");
const compactIdle = $("compact-idle");
const compactActivity = $("compact-activity");
const compactSessionCount = $("compact-session-count");
const expandedView = $("expanded-view");
const usageStrip = $("usage-strip");
const sessionsList = $("sessions-list");
const emptySessions = $("empty-sessions");
const sessionSummary = $("session-summary");
const showAllButton = $("show-all") as HTMLButtonElement;
const pinButton = $("btn-pin") as HTMLButtonElement;
const isTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const appWindow = isTauri ? getCurrentWindow() : null;

const COMPACT_HEIGHT = 30;
const COMPACT_WIDTH = 400;
const EXPANDED_WIDTH = 540;
// El HWND conserva siempre el ancho expandido. Solo el notch visible cambia
// de ancho, evitando un reflow horizontal al terminar la minimización.
const SHELL_WIDTH = EXPANDED_WIDTH;
const MAX_EXPANDED_HEIGHT = 320;
const PIN_STORAGE_KEY = "burnclaw:notch-pinned";
const AUTO_TUCK_DELAY = 1_500;

const usage: Record<ProviderId, ProviderUsage | null> = {
  claude: null,
  codex: null,
};
const statuses: Record<ProviderId, StatusSnapshot | null> = {
  claude: null,
  codex: null,
};
const sessions = new Map<string, AgentSession>();
const pendingRequests = new Map<string, AgentRequest>();
const questionSelections = new Map<string, Record<string, string[]>>();
const questionOtherValues = new Map<string, Record<string, string>>();
const OTHER_ANSWER = "__burnclaw_other__";

let shellState: "compact" | "expanding" | "expanded" | "collapsing" = "compact";
let selectedSessionId: string | null = null;
let showingAllSessions = false;
let resizeTimer: number | null = null;
let codexIconInstance = 0;
let isPinned = window.localStorage.getItem(PIN_STORAGE_KEY) === "true";
let isTucked = false;
let tuckTimer: number | null = null;
let clickThroughTimer: number | null = null;
let cursorIgnored = false;
let reentryPoll: number | null = null;
let ignoredWindowPosition: { x: number; y: number } | null = null;
let windowScale = 1;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function iconFor(provider: ProviderId): string {
  if (provider === "claude") return CLAUDE_ICON;
  const gradientId = `burnclaw-codex-gradient-widget-${codexIconInstance++}`;
  return CODEX_ICON.replace(/burnclaw-codex-gradient/g, gradientId);
}

function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function statusClass(provider: ProviderId): string {
  switch (statuses[provider]?.indicator) {
    case "none": return "ok";
    case "minor": return "warn";
    case "major":
    case "critical": return "danger";
    case "maintenance": return "blue";
    default: return "";
  }
}

function providerMark(provider: ProviderId): string {
  return `<span class="provider-mark ${provider}">${iconFor(provider)}</span>`;
}

function resetCountdown(resetAt: string | null): string {
  if (!resetAt) return "";
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return "";
  const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function metricColor(pct: number): string {
  const value = Math.max(0, Math.min(100, pct));
  // Continuous green-to-yellow-to-orange-to-coral scale. Lightness stays
  // deliberately high so every point remains readable on the black notch.
  const hue = 136 - (value * 1.28);
  const saturation = 58 + (value * 0.2);
  const lightness = 67 - (Math.abs(50 - value) * 0.04);
  return `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

function usageMetrics(value: ProviderUsage): string {
  const windows = [
    { label: "5h", pct: value.sessionPct, resetAt: value.sessionResetAt },
    { label: "7d", pct: value.weeklyPct, resetAt: value.weeklyResetAt },
  ].filter((window): window is { label: string; pct: number; resetAt: string | null } => window.pct !== null);
  return windows.map((window) => {
    const reset = resetCountdown(window.resetAt);
    return `<span class="usage-window"><span class="usage-label">${window.label}</span><strong style="color:${metricColor(window.pct)}">${Math.round(window.pct)}%</strong>${reset ? `<span class="metric-reset" data-reset-at="${escapeHtml(window.resetAt)}">${reset}</span>` : ""}</span>`;
  }).join("");
}

function compactProvider(provider: ProviderId): string {
  const value = usage[provider];
  if (!value) return "";
  return `<span class="compact-provider" title="${escapeHtml(statuses[provider]?.description ?? "Status unknown")}">
    ${providerMark(provider)}
    <span class="service-dot ${statusClass(provider)}"></span>
    <span class="compact-metrics">${usageMetrics(value)}</span>
  </span>`;
}

function renderCompact(): void {
  const sorted = sortedSessions();
  const attention = sorted.find((session) => session.state === "awaiting")
    ?? sorted.find((session) => session.state === "working");

  if (attention) {
    const stateLabel = sessionAction(attention);
    compactActivity.className = `compact-activity ${attention.state}`;
    compactActivity.innerHTML = `<span class="compact-activity-main">
      ${providerMark(attention.provider)}
      <span class="activity-pulse"></span>
      <span class="compact-activity-label"><strong>${escapeHtml(providerLabel(attention.provider))}</strong> · ${escapeHtml(attention.project)} · ${escapeHtml(stateLabel)}</span>
    </span>`;
    compactActivity.hidden = false;
    compactIdle.hidden = true;
  } else {
    const providers = (["claude", "codex"] as ProviderId[])
      .map(compactProvider)
      .filter(Boolean);
    compactIdle.innerHTML = providers.length
      ? providers.join('<span class="compact-separator"></span>')
      : '<span class="compact-metrics">Loading usage…</span>';
    compactIdle.hidden = false;
    compactActivity.hidden = true;
  }

  const activeCount = sorted.filter((session) => session.state === "working" || session.state === "awaiting").length;
  compactSessionCount.innerHTML = `<strong>${activeCount}</strong><span>${activeCount === 1 ? "session" : "sessions"}</span>`;
  compactSessionCount.hidden = activeCount === 0;
}

function renderUsageStrip(): void {
  usageStrip.innerHTML = (["claude", "codex"] as ProviderId[])
    .map((provider) => {
      const value = usage[provider];
      if (!value) return "";
      return `<div class="usage-provider" title="${escapeHtml(statuses[provider]?.description ?? "Status unknown")}">
        ${providerMark(provider)}
        <span class="service-dot ${statusClass(provider)}"></span>
        <span class="provider-name">${providerLabel(provider)}</span>
        <span class="usage-values">${usageMetrics(value)}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
}

function sortedSessions(): AgentSession[] {
  const rank = (state: AgentSession["state"]) =>
    state === "awaiting" ? 0 : state === "working" ? 1 : state === "finished" ? 2 : 3;
  return [...sessions.values()].filter((session) => session.state !== "closed").sort(
    (a, b) => rank(a.state) - rank(b.state) || b.updated_at - a.updated_at,
  );
}

function ageLabel(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function sessionAction(session: AgentSession): string {
  if (session.state === "awaiting") {
    if (session.event_type === "AskUserQuestion" || session.event_type === "CodexQuestion") {
      return "Waiting for your answer…";
    }
    if (session.event_type === "PermissionRequest") return "Waiting for approval…";
    return "Needs you";
  }
  if (session.state === "finished") return "Ready";
  if ((session.active_subagents ?? 0) > 0 || session.event_type === "SubagentStart") {
    return "Working with subagents…";
  }
  if (session.event_type === "PreCompact" || session.event_type === "PostCompact") {
    return "Optimizing context…";
  }
  if (session.event_type === "PostToolUseFailure" || session.event_type === "PermissionDenied") {
    return "Trying another approach…";
  }

  const tool = (session.tool_name ?? "").toLowerCase();
  if (/edit|write|patch|notebook/.test(tool)) return "Editing…";
  if (/read|glob|grep|search|fetch|browse|web/.test(tool)) return "Exploring…";
  return "Working…";
}

function requestForSession(sessionId: string): AgentRequest | undefined {
  return [...pendingRequests.values()].find((request) => request.session_id === sessionId);
}

function stateLabel(session: AgentSession): string {
  if (session.state === "awaiting") return "Needs you";
  if (session.state === "working") return "Working";
  if (session.state === "finished") return "Done";
  return "Closed";
}

function renderQuestion(request: AgentRequest): string {
  const questions = (request.tool_input.questions ?? []) as AgentQuestion[];
  const selected = questionSelections.get(request.id) ?? {};
  const otherValues = questionOtherValues.get(request.id) ?? {};
  if (!questions.length) {
    return `<div class="request-title">${escapeHtml(request.tool_name)}</div>
      <div class="request-actions"><button class="request-btn primary" data-request-action="allow" data-request-id="${escapeHtml(request.id)}">Continue</button></div>`;
  }

  const content = questions.map((question) => {
    const answers = selected[question.question] ?? [];
    const options = (question.options ?? []).filter((option) => option.label.toLowerCase() !== "other").map((option, index) => {
      const active = answers.includes(option.label);
      return `<button class="request-btn request-option ${active ? "primary" : ""}" aria-pressed="${active}" data-question-option data-request-id="${escapeHtml(request.id)}" data-question="${escapeHtml(question.question)}" data-answer="${escapeHtml(option.label)}" data-multi="${Boolean(question.multiSelect)}">
        <span class="option-number">${index + 1}</span><span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span>
      </button>`;
    }).join("");
    const otherActive = answers.includes(OTHER_ANSWER);
    const other = `<button class="request-btn request-option ${otherActive ? "primary" : ""}" aria-pressed="${otherActive}" data-question-option data-request-id="${escapeHtml(request.id)}" data-question="${escapeHtml(question.question)}" data-answer="${OTHER_ANSWER}" data-multi="${Boolean(question.multiSelect)}">
      <span class="option-number">${(question.options ?? []).length + 1}</span><span><strong>Other</strong><small>Type your own answer</small></span>
    </button>${otherActive ? `<input class="request-other-input" data-question-other data-request-id="${escapeHtml(request.id)}" data-question="${escapeHtml(question.question)}" value="${escapeHtml(otherValues[question.question] ?? "")}" placeholder="Your answer…" autocomplete="off">` : ""}`;
    const hint = question.multiSelect ? `<span class="request-hint">Choose one or more</span>` : "";
    return `<div class="request-question"><div class="request-title">${escapeHtml(question.question)}</div>${hint}<div class="request-actions">${options}${other}</div></div>`;
  }).join("");

  const complete = isQuestionComplete(request);
  return `${content}<div class="request-actions request-footer"><button class="request-btn" data-request-action="deny" data-request-id="${escapeHtml(request.id)}">Dismiss</button><button class="request-btn primary" data-submit-answers data-request-id="${escapeHtml(request.id)}" ${complete ? "" : "disabled"}>Send answer</button></div>`;
}

function isQuestionComplete(request: AgentRequest): boolean {
  const questions = (request.tool_input.questions ?? []) as AgentQuestion[];
  const selected = questionSelections.get(request.id) ?? {};
  const otherValues = questionOtherValues.get(request.id) ?? {};
  return questions.every((question) => {
    const answers = selected[question.question] ?? [];
    if (!answers.length) return false;
    return !answers.includes(OTHER_ANSWER) || Boolean(otherValues[question.question]?.trim());
  });
}

function serializedQuestionAnswers(request: AgentRequest): Record<string, string> {
  const questions = (request.tool_input.questions ?? []) as AgentQuestion[];
  const selected = questionSelections.get(request.id) ?? {};
  const otherValues = questionOtherValues.get(request.id) ?? {};
  return Object.fromEntries(questions.map((question) => {
    const answers = (selected[question.question] ?? []).map((answer) =>
      answer === OTHER_ANSWER ? otherValues[question.question]?.trim() ?? "" : answer,
    );
    return [question.question, answers.filter(Boolean).join(", ")];
  }));
}

function renderPermission(request: AgentRequest): string {
  const input = request.tool_input;
  const detail = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input, null, 2);
  const sessionGrant = request.provider === "codex"
    ? ""
    : `<button class="request-btn primary" data-request-action="allow_session" data-request-id="${escapeHtml(request.id)}">Allow for session</button>`;
  return `<div class="request-title">${escapeHtml(request.tool_name)} requires approval</div>
    <div class="request-detail">${escapeHtml(detail)}</div>
    <div class="request-actions">
      <button class="request-btn danger" data-request-action="deny" data-request-id="${escapeHtml(request.id)}">Deny</button>
      <button class="request-btn" data-request-action="allow" data-request-id="${escapeHtml(request.id)}">Allow once</button>
      ${sessionGrant}
    </div>`;
}

function renderSessions(): void {
  const all = sortedSessions();
  const visible = showingAllSessions ? all : all.slice(0, 3);
  const activeCount = all.filter((session) => session.state === "working").length;
  const waitingCount = all.filter((session) => session.state === "awaiting").length;
  sessionSummary.textContent = waitingCount ? `${waitingCount} need attention` : `${activeCount} active`;

  sessionsList.innerHTML = visible.map((session) => {
    const request = requestForSession(session.id);
    const selected = selectedSessionId === session.id || Boolean(request);
    const requestHtml = selected && request
      ? `<div class="request-panel">${request.kind === "question" ? renderQuestion(request) : renderPermission(request)}</div>`
      : "";
    return `<article class="session-card ${selected ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}">
      <button class="session-row" type="button" data-select-session="${escapeHtml(session.id)}">
        ${providerMark(session.provider)}
        <span class="session-main">
          <span class="session-title-line"><span class="session-project">${escapeHtml(session.project)}</span><span class="session-title">${escapeHtml(session.title ?? session.message ?? "Agent session")}</span></span>
          <span class="session-meta">${escapeHtml(sessionAction(session))}</span>
        </span>
        <span class="session-side"><span class="session-state ${session.state}">${stateLabel(session)}</span><span class="session-age" data-updated-at="${session.updated_at}">${ageLabel(session.updated_at)}</span></span>
      </button>
      ${requestHtml}
    </article>`;
  }).join("");

  emptySessions.hidden = all.length > 0;
  showAllButton.hidden = all.length <= 3;
  showAllButton.textContent = showingAllSessions ? "Show recent sessions" : `Show all ${all.length} sessions`;
  renderCompact();
  scheduleExpandedFit();
}

function renderAll(): void {
  renderUsageStrip();
  renderSessions();
}

function expandedHeight(): number {
  return Math.min(MAX_EXPANDED_HEIGHT, Math.max(92, Math.ceil(expandedView.scrollHeight)));
}

async function resizeWindow(width: number, height: number): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("resize_shell_window", { width, height });
  } catch (error) {
    console.error("resize_shell_window failed", error);
  }
}

function clearTuckTimers(): void {
  if (tuckTimer !== null) window.clearTimeout(tuckTimer);
  if (clickThroughTimer !== null) window.clearTimeout(clickThroughTimer);
  tuckTimer = null;
  clickThroughTimer = null;
}

function stopReentryPoll(): void {
  if (reentryPoll !== null) window.clearInterval(reentryPoll);
  reentryPoll = null;
}

function startReentryPoll(): void {
  if (!isTauri || reentryPoll !== null) return;
  reentryPoll = window.setInterval(async () => {
    if (!isTucked || !ignoredWindowPosition) return;
    try {
      const [cursorX, cursorY] = await invoke<[number, number]>("cursor_position");
      const inset = ((SHELL_WIDTH - COMPACT_WIDTH) * 0.5) * windowScale;
      const extraWidth = 24 * windowScale;
      const left = ignoredWindowPosition.x + inset - extraWidth;
      const right = ignoredWindowPosition.x + SHELL_WIDTH * windowScale - inset + extraWidth;
      const top = ignoredWindowPosition.y;
      const bottom = top + 14 * windowScale;
      if (cursorX >= left && cursorX <= right && cursorY >= top && cursorY <= bottom) {
        revealCompactNotch();
      }
    } catch {
      // Never leave BurnClaw unreachable if global cursor polling fails.
      revealCompactNotch();
    }
  }, 120);
}

async function setCursorIgnored(ignore: boolean): Promise<void> {
  if (!appWindow || cursorIgnored === ignore) return;
  cursorIgnored = ignore;
  try {
    if (ignore) {
      ignoredWindowPosition = await appWindow.outerPosition();
      await appWindow.setIgnoreCursorEvents(true);
      startReentryPoll();
    } else {
      stopReentryPoll();
      ignoredWindowPosition = null;
      await appWindow.setIgnoreCursorEvents(false);
    }
  } catch (error) {
    console.error("setIgnoreCursorEvents failed", error);
    cursorIgnored = false;
    stopReentryPoll();
    ignoredWindowPosition = null;
  }
}

function revealCompactNotch(): void {
  clearTuckTimers();
  if (isTucked) {
    isTucked = false;
    notch.classList.remove("tucked");
  }
  if (cursorIgnored) void setCursorIgnored(false);
}

function tuckCompactNotch(): void {
  clearTuckTimers();
  if (isPinned || shellState !== "compact" || notch.matches(":hover")) return;
  isTucked = true;
  notch.classList.add("tucked");
  clickThroughTimer = window.setTimeout(() => {
    clickThroughTimer = null;
    if (isTucked) void setCursorIgnored(true);
  }, 270);
}

function scheduleCompactTuck(delay = AUTO_TUCK_DELAY): void {
  if (isPinned || shellState !== "compact") return;
  if (tuckTimer !== null) window.clearTimeout(tuckTimer);
  tuckTimer = window.setTimeout(() => {
    tuckTimer = null;
    tuckCompactNotch();
  }, delay);
}

function renderPinState(): void {
  notch.classList.toggle("pinned", isPinned);
  pinButton.setAttribute("aria-pressed", String(isPinned));
  pinButton.setAttribute("aria-label", isPinned ? "Allow BurnClaw to auto-hide" : "Keep BurnClaw visible");
  pinButton.title = isPinned ? "Allow auto-hide" : "Keep visible";
  if (isPinned) revealCompactNotch();
}

async function expand(): Promise<void> {
  if (shellState !== "compact") return;
  revealCompactNotch();
  shellState = "expanding";
  expandedView.setAttribute("aria-hidden", "false");
  renderAll();
  const targetHeight = expandedHeight();
  await resizeWindow(EXPANDED_WIDTH, targetHeight);
  requestAnimationFrame(() => {
    notch.classList.remove("closing", "compact");
    notch.classList.add("expanded");
    notch.style.height = `${targetHeight}px`;
  });
  window.setTimeout(() => {
    if (shellState === "expanding") shellState = "expanded";
  }, 310);
}

function collapse(instant = false): void {
  if (shellState === "compact") return;
  if (instant) {
    shellState = "compact";
    notch.className = "notch compact";
    renderPinState();
    notch.style.height = `${COMPACT_HEIGHT}px`;
    expandedView.setAttribute("aria-hidden", "true");
    void resizeWindow(SHELL_WIDTH, COMPACT_HEIGHT);
    scheduleCompactTuck();
    return;
  }

  shellState = "collapsing";
  notch.classList.add("closing");
  notch.style.height = `${COMPACT_HEIGHT}px`;
  window.setTimeout(() => {
    shellState = "compact";
    notch.className = "notch compact";
    renderPinState();
    notch.style.height = `${COMPACT_HEIGHT}px`;
    expandedView.setAttribute("aria-hidden", "true");
    void resizeWindow(SHELL_WIDTH, COMPACT_HEIGHT);
    scheduleCompactTuck();
  }, 310);
}

function scheduleExpandedFit(): void {
  if (shellState !== "expanded" && shellState !== "expanding") return;
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(async () => {
    const height = expandedHeight();
    const current = Math.round(notch.getBoundingClientRect().height);
    if (height > current) await resizeWindow(EXPANDED_WIDTH, height);
    notch.style.height = `${height}px`;
    if (height < current) window.setTimeout(() => void resizeWindow(EXPANDED_WIDTH, height), 310);
  }, 0);
}

async function respondToRequest(id: string, action: string, answers?: Record<string, string>): Promise<void> {
  try {
    if (isTauri) {
      await invoke("respond_to_agent_request", { requestId: id, action, answers: answers ?? null });
    }
    const request = pendingRequests.get(id);
    pendingRequests.delete(id);
    questionSelections.delete(id);
    questionOtherValues.delete(id);
    if (request) {
      const session = sessions.get(request.session_id);
      if (session) session.state = "working";
    }
    renderSessions();
  } catch (error) {
    console.error("respond_to_agent_request failed", error);
  }
}

$("compact-view").addEventListener("click", () => void expand());
pinButton.addEventListener("click", (event) => {
  event.stopPropagation();
  isPinned = !isPinned;
  window.localStorage.setItem(PIN_STORAGE_KEY, String(isPinned));
  renderPinState();
  if (!isPinned) scheduleCompactTuck(700);
});
notch.addEventListener("mouseenter", () => revealCompactNotch());
notch.addEventListener("mouseleave", () => scheduleCompactTuck(700));
$("btn-collapse").addEventListener("click", () => collapse());
$("btn-settings").addEventListener("click", () => {
  if (isTauri) void invoke("show_settings");
});
$("btn-refresh").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLElement;
  button.classList.remove("spinning");
  void button.offsetWidth;
  button.classList.add("spinning");
  if (isTauri) void invoke("force_refresh");
});

showAllButton.addEventListener("click", () => {
  showingAllSessions = !showingAllSessions;
  renderSessions();
});

sessionsList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const option = target.closest<HTMLElement>("[data-question-option]");
  if (option) {
    const id = option.dataset.requestId!;
    const selection = questionSelections.get(id) ?? {};
    const question = option.dataset.question!;
    const answer = option.dataset.answer!;
    const current = selection[question] ?? [];
    if (option.dataset.multi === "true") {
      selection[question] = current.includes(answer)
        ? current.filter((value) => value !== answer)
        : [...current, answer];
    } else {
      selection[question] = [answer];
    }
    questionSelections.set(id, selection);
    renderSessions();
    return;
  }
  const submit = target.closest<HTMLElement>("[data-submit-answers]");
  if (submit) {
    const id = submit.dataset.requestId!;
    const request = pendingRequests.get(id);
    if (request && isQuestionComplete(request)) {
      void respondToRequest(id, "allow", serializedQuestionAnswers(request));
    }
    return;
  }
  const action = target.closest<HTMLElement>("[data-request-action]");
  if (action) {
    void respondToRequest(action.dataset.requestId!, action.dataset.requestAction!);
    return;
  }
  const row = target.closest<HTMLElement>("[data-select-session]");
  if (row) {
    selectedSessionId = selectedSessionId === row.dataset.selectSession ? null : row.dataset.selectSession!;
    renderSessions();
  }
});

sessionsList.addEventListener("input", (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-question-other]");
  if (!input) return;
  const id = input.dataset.requestId!;
  const values = questionOtherValues.get(id) ?? {};
  values[input.dataset.question!] = input.value;
  questionOtherValues.set(id, values);
  const request = pendingRequests.get(id);
  const submit = sessionsList.querySelector<HTMLButtonElement>(`[data-submit-answers][data-request-id="${CSS.escape(id)}"]`);
  if (request && submit) submit.disabled = !isQuestionComplete(request);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") collapse();
});

if (isTauri) {
void listen<UsageSnapshot>("usage-updated", ({ payload }) => {
  usage.claude = {
    sessionPct: payload.session_5h_pct,
    weeklyPct: payload.weekly_pct,
    sessionResetAt: payload.session_5h_reset_at,
    weeklyResetAt: payload.weekly_reset_at,
  };
  renderAll();
});

void listen<CodexUsageSnapshot>("codex-usage-updated", ({ payload }) => {
  usage.codex = {
    sessionPct: payload.session_5h_pct,
    weeklyPct: payload.weekly_pct,
    sessionResetAt: payload.session_5h_reset_at,
    weeklyResetAt: payload.weekly_reset_at,
  };
  renderAll();
});

void listen<StatusSnapshot>("status-updated", ({ payload }) => {
  statuses.claude = payload;
  renderAll();
});

void listen<StatusSnapshot>("codex-status-updated", ({ payload }) => {
  statuses.codex = payload;
  renderAll();
});

void listen<AgentSession>("agent-session-updated", ({ payload }) => {
  sessions.set(payload.id, payload);
  renderSessions();
});

void listen<{ id: string }>("agent-session-removed", ({ payload }) => {
  sessions.delete(payload.id);
  for (const [requestId, request] of pendingRequests) {
    if (request.session_id === payload.id) {
      pendingRequests.delete(requestId);
      questionSelections.delete(requestId);
      questionOtherValues.delete(requestId);
    }
  }
  if (selectedSessionId === payload.id) selectedSessionId = null;
  renderSessions();
});

void listen<AgentRequest>("agent-request-pending", ({ payload }) => {
  pendingRequests.set(payload.id, payload);
  selectedSessionId = payload.session_id;
  renderSessions();
  if (shellState === "compact") void expand();
});

void listen<{ id: string }>("agent-request-resolved", ({ payload }) => {
  pendingRequests.delete(payload.id);
  questionSelections.delete(payload.id);
  questionOtherValues.delete(payload.id);
  renderSessions();
});

void listen("window-shown", () => {
  revealCompactNotch();
  collapse(true);
  scheduleCompactTuck();
});
void listen("setup-completed", () => {
  window.setTimeout(() => void expand(), 140);
});
}

window.setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-updated-at]").forEach((element) => {
    element.textContent = ageLabel(Number(element.dataset.updatedAt));
  });
  document.querySelectorAll<HTMLElement>("[data-reset-at]").forEach((element) => {
    element.textContent = resetCountdown(element.dataset.resetAt ?? null);
  });
}, 15_000);

async function bootstrap(): Promise<void> {
  renderPinState();
  if (!isTauri) {
    seedPreviewData();
    renderAll();
    notch.style.height = `${COMPACT_HEIGHT}px`;
    scheduleCompactTuck();
    return;
  }

  windowScale = await appWindow!.scaleFactor().catch(() => 1);

  const [claudeUsage, codexUsage, claudeStatus, codexStatus, initialSessions, requests] = await Promise.all([
    invoke<UsageSnapshot | null>("get_current_usage").catch(() => null),
    invoke<CodexUsageSnapshot | null>("get_current_codex_usage").catch(() => null),
    invoke<StatusSnapshot | null>("get_current_status").catch(() => null),
    invoke<StatusSnapshot | null>("get_current_codex_status").catch(() => null),
    invoke<AgentSession[]>("get_agent_sessions").catch(() => []),
    invoke<AgentRequest[]>("get_pending_agent_requests").catch(() => []),
  ]);

  if (claudeUsage) {
    usage.claude = {
      sessionPct: claudeUsage.session_5h_pct,
      weeklyPct: claudeUsage.weekly_pct,
      sessionResetAt: claudeUsage.session_5h_reset_at,
      weeklyResetAt: claudeUsage.weekly_reset_at,
    };
  }
  if (codexUsage) {
    usage.codex = {
      sessionPct: codexUsage.session_5h_pct,
      weeklyPct: codexUsage.weekly_pct,
      sessionResetAt: codexUsage.session_5h_reset_at,
      weeklyResetAt: codexUsage.weekly_reset_at,
    };
  }
  statuses.claude = claudeStatus;
  statuses.codex = codexStatus;
  initialSessions.forEach((session) => sessions.set(session.id, session));
  requests.forEach((request) => pendingRequests.set(request.id, request));
  selectedSessionId = requests[0]?.session_id ?? null;
  renderAll();
  notch.style.height = `${COMPACT_HEIGHT}px`;
  await resizeWindow(SHELL_WIDTH, COMPACT_HEIGHT);
  scheduleCompactTuck();
}

function seedPreviewData(): void {
  const now = Date.now();
  usage.claude = {
    sessionPct: 31,
    weeklyPct: 42,
    sessionResetAt: new Date(now + 4 * 3_600_000 + 11 * 60_000).toISOString(),
    weeklyResetAt: new Date(now + 6 * 86_400_000 + 12 * 3_600_000).toISOString(),
  };
  usage.codex = {
    sessionPct: null,
    weeklyPct: 27,
    sessionResetAt: null,
    weeklyResetAt: new Date(now + 3 * 86_400_000 + 8 * 3_600_000).toISOString(),
  };
  statuses.claude = { indicator: "none", description: "All systems operational", fetched_at: new Date().toISOString() };
  statuses.codex = { indicator: "minor", description: "Degraded performance", fetched_at: new Date().toISOString() };

  const previewSessions: AgentSession[] = [
    {
      id: "claude-preview",
      provider: "claude",
      project: "burnclaw",
      cwd: "C:/projects/burnclaw",
      title: "Refine the Windows notch interaction",
      state: "awaiting",
      event_type: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_target: null,
      tool_input: null,
      message: "Waiting for your answer",
      started_at: now - 242_000,
      updated_at: now - 18_000,
      finished_at: null,
    },
    {
      id: "codex-preview",
      provider: "codex",
      project: "api-server",
      cwd: "C:/projects/api-server",
      title: "Repair the authentication flow",
      state: "working",
      event_type: "tool",
      tool_name: "Bash",
      tool_target: "pnpm test",
      tool_input: null,
      message: null,
      started_at: now - 610_000,
      updated_at: now - 31_000,
      finished_at: null,
    },
    {
      id: "claude-done-preview",
      provider: "claude",
      project: "desktop-app",
      cwd: "C:/projects/desktop-app",
      title: "Polish the release panel",
      state: "finished",
      event_type: "Stop",
      tool_name: null,
      tool_target: null,
      tool_input: null,
      message: "Changes ready for review",
      started_at: now - 1_500_000,
      updated_at: now - 320_000,
      finished_at: now - 320_000,
    },
  ];
  previewSessions.forEach((session) => sessions.set(session.id, session));

  const request: AgentRequest = {
    id: "preview-question",
    session_id: "claude-preview",
    provider: "claude",
    kind: "question",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{
        question: "Which density should the expanded panel use?",
        header: "Layout",
        options: [
          { label: "Compact", description: "Keep only the essential context" },
          { label: "Comfortable", description: "Give session details more room" },
        ],
      }],
    },
    created_at: now - 18_000,
  };
  pendingRequests.set(request.id, request);
  selectedSessionId = request.session_id;
}

void bootstrap();
