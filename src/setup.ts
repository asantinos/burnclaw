import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CLAUDE_ICON, CODEX_ICON } from "./icons";

const isTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const STEP_CHECK_ICON = `<svg class="step-check-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12.6111L8.92308 17.5L20 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
const STEP_CURRENT_ICON = `<svg class="step-current-ring" viewBox="0 0 28 28" fill="none" aria-hidden="true"><circle cx="14" cy="14" r="10.5" pathLength="12" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="0.001 0.999"/></svg>`;
let codexIconInstance = 0;

function uniqueCodexIcon(): string {
  const gradientId = `burnclaw-codex-gradient-setup-${codexIconInstance++}`;
  return CODEX_ICON.replace(/burnclaw-codex-gradient/g, gradientId);
}

// ====================================================
// STATE
// ====================================================
let currentStep = 1;
let credsState: "ok" | "missing" | "expired" | "unknown" = "unknown";
let userPlan = "unknown";
let hooksInstalled = false;
let hookCount = 0;
let codexHooksInstalled = false;
let codexHookCount = 0;
let credsActionLoading = false;
let claudeCliInstalled = false;
let claudeCliPath: string | null = null;
let claudeLoginPending = false;
let claudeLoginPid: number | null = null;
let claudeLoginError: string | null = null;
let hooksActionLoading: "claude" | "codex" | null = null;
let pendingRemovalProvider: "claude" | "codex" = "claude";
let autoStartEnabled = true;
let pollingInterval = 60;
let step2Interval: number | null = null;

// --- Providers a trackear (elegidos en el Welcome) ---
let trackClaude = true;
let trackCodex = false;
let codexState: "ok" | "api_key_only" | "missing" | "unknown" = "unknown";
let codexActionLoading = false;
let codexCliInstalled = false;
let codexCliPath: string | null = null;
let codexLoginPending = false;
let codexLoginPid: number | null = null;
let codexLoginError: string | null = null;

// % por plan a 60s (community estimates — ver Consumption budget reference)
const PCT_AT_60S: Record<string, number> = { pro: 6.8, max: 3.4, max20: 1.4 };

// ====================================================
// BACKEND STATE
// ====================================================
async function refreshCredsState() {
  try {
    const check = await invoke<any>("check_credentials");
    credsState = check.state;
    claudeCliInstalled = Boolean(check.cli_installed);
    claudeCliPath = check.cli_path ?? null;
    if (check.subscription_type) userPlan = check.subscription_type;
    if (credsState === "ok") {
      claudeLoginPending = false;
      claudeLoginPid = null;
      claudeLoginError = null;
    }
  } catch {
    credsState = "missing";
  }
}

let codexPlan: string | null = null;
async function refreshCodexState() {
  try {
    const check = await invoke<any>("check_codex_credentials");
    codexState = check.state;
    codexCliInstalled = Boolean(check.cli_installed);
    codexCliPath = check.cli_path ?? null;
    if (codexState === "ok") {
      codexLoginPending = false;
      codexLoginPid = null;
      codexLoginError = null;
    }
  } catch {
    codexState = "missing";
  }
  // El plan no está en auth.json; se consulta una vez a wham/usage (read-only).
  if (codexState === "ok" && codexPlan === null) {
    try {
      codexPlan = (await invoke<string | null>("get_codex_plan")) ?? null;
    } catch {
      /* sin red / sin plan */
    }
  }
}

async function refreshHooksState() {
  const [claude, codex] = await Promise.allSettled([
    invoke<any>("check_hooks_status"),
    invoke<any>("check_codex_hooks_status"),
  ]);
  if (claude.status === "fulfilled") {
    hooksInstalled = claude.value.installed;
    hookCount = claude.value.hook_count;
  } else {
    hooksInstalled = false;
    hookCount = 0;
  }
  if (codex.status === "fulfilled") {
    codexHooksInstalled = codex.value.installed;
    codexHookCount = codex.value.hook_count;
  } else {
    codexHooksInstalled = false;
    codexHookCount = 0;
  }
}

// ====================================================
// NAVIGATION / RENDER
// ====================================================
function renderAll() {
  renderSidebar();
  renderContent();
  renderProviderSelect();
  renderCredsSection();
  renderCodexSection();
  renderHooksSection();
  renderReadySummary();
  renderFooter();
  updateTradeOff();
  manageStep2Polling();
}

function currentProvider(): "claude" | "codex" | "both" {
  if (trackClaude && trackCodex) return "both";
  if (trackCodex) return "codex";
  return "claude";
}

function renderProviderSelect() {
  const prov = currentProvider();
  document.querySelectorAll("#provider-select .pref-select-option").forEach((o) => {
    o.classList.toggle("selected", (o as HTMLElement).dataset.value === prov);
  });
  // "Detected" dentro de cada botón: ✓ en el proveedor que se detecta.
  const mark = (provider: string, ok: boolean) => {
    const el = document.querySelector(
      `#provider-select .opt-detect[data-detect="${provider}"]`,
    );
    if (!el) return;
    el.textContent = ok ? "detected" : "";
    el.classList.toggle("ok", ok);
  };
  mark("claude", credsState === "ok");
  mark("codex", codexState === "ok");
}

type StepMarkerState = "done" | "active" | "pending";

function paintStepMarker(
  step: HTMLElement,
  numberEl: HTMLElement,
  state: StepMarkerState,
  number: number,
) {
  step.classList.toggle("done", state === "done");
  step.classList.toggle("active", state === "active");
  numberEl.innerHTML =
    state === "done"
      ? STEP_CHECK_ICON
      : state === "active"
        ? STEP_CURRENT_ICON
        : String(number);
  step.dataset.markerState = state;
}

function renderSidebar() {
  document.querySelectorAll<HTMLElement>(".step").forEach((step) => {
    const n = parseInt(step.dataset.step || "0");
    const numberEl = step.querySelector<HTMLElement>(".step-number");
    if (!numberEl) return;

    const nextState: StepMarkerState =
      n < currentStep ? "done" : n === currentStep ? "active" : "pending";
    const previousState = step.dataset.markerState as StepMarkerState | undefined;

    // The first render is immediate. Subsequent state changes shrink the old
    // marker into its centre before revealing the replacement from scale zero.
    if (!previousState || previousState === nextState) {
      paintStepMarker(step, numberEl, nextState, n);
      return;
    }

    const animationToken = String(Number(step.dataset.markerToken || "0") + 1);
    step.dataset.markerToken = animationToken;
    numberEl.classList.remove("marker-enter");
    numberEl.classList.add("marker-exit");

    window.setTimeout(() => {
      if (step.dataset.markerToken !== animationToken) return;
      paintStepMarker(step, numberEl, nextState, n);
      numberEl.classList.remove("marker-exit");
      numberEl.classList.add("marker-enter");

      window.setTimeout(() => {
        if (step.dataset.markerToken === animationToken) {
          numberEl.classList.remove("marker-enter");
        }
      }, 240);
    }, 130);
  });
}

function renderContent() {
  document
    .querySelectorAll(".step-content")
    .forEach((c) => c.classList.remove("active"));
  document
    .querySelector(`[data-step-content="${currentStep}"]`)
    ?.classList.add("active");
}

// Fila de conexión, estilo Settings → Providers: icono de marca + nombre/plan
// arriba, y debajo el estado con el dot inline. `actions` opcional (botones).
function connRow(icon: string, top: string, meta: string, actions = ""): string {
  const provider = icon === CLAUDE_ICON ? "claude" : "codex";
  const renderedIcon = provider === "codex" ? uniqueCodexIcon() : icon;
  return `
    <div class="provider-row">
      <span class="provider-mark" data-provider="${provider}">${renderedIcon}</span>
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            ${top}
            <div class="meta">${meta}</div>
          </div>
        </div>
        ${actions ? `<div class="status-line-actions">${actions}</div>` : ""}
      </div>
    </div>`;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  };
  return value.replace(/[&<>'"]/g, (character) => entities[character]);
}

function loginActions(provider: "claude" | "codex"): string {
  return `
    <button class="action-btn subtle" onclick="checkProviderLogin('${provider}')">Check again</button>
    <button class="action-btn" onclick="restartProviderLogin('${provider}')">Open again</button>
    <button class="action-btn subtle" onclick="cancelProviderLogin('${provider}')">Cancel</button>`;
}

function renderCredsSection() {
  const container = document.getElementById("creds-section");
  if (!container) return;
  if (!trackClaude) {
    container.innerHTML = "";
    return;
  }
  const label = `<span class="provider-label">Claude</span>`;
  let html: string;

  if (credsActionLoading) {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot checking inline"></span>Starting secure sign-in…`,
    );
  } else if (credsState === "ok") {
    html = connRow(
      CLAUDE_ICON,
      `${label}<span class="plan-tag">${userPlan}</span>`,
      `<span class="status-dot ok inline"></span>Connected · managed by Claude Code`,
    );
  } else if (!claudeCliInstalled) {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot danger inline"></span>Claude Code is not installed
       <span class="connection-detail">Install the official CLI, then let BurnClaw detect it automatically.</span>`,
      `<button class="action-btn" onclick="openProviderInstall('claude')">Install Claude Code</button>
       <button class="action-btn subtle" onclick="checkProviderLogin('claude')">Check again</button>`,
    );
  } else if (claudeLoginPending) {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot checking inline"></span>Finish signing in in your browser
       <span class="connection-detail">BurnClaw will detect the account automatically. You can safely retry or cancel.</span>`,
      loginActions("claude"),
    );
  } else if (claudeLoginError) {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot danger inline"></span>Sign-in was not completed
       <span class="connection-detail">${escapeHtml(claudeLoginError)}</span>`,
      `<button class="action-btn" onclick="runClaudeLogin()">Try again</button>
       <button class="action-btn subtle" onclick="checkProviderLogin('claude')">Check again</button>`,
    );
  } else if (credsState === "missing") {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot danger inline"></span>Not signed in
       <span class="connection-detail">Claude Code found${claudeCliPath ? " and ready to open" : ""}.</span>`,
      `<button class="action-btn" onclick="runClaudeLogin()">Sign in with Claude</button>`,
    );
  } else if (credsState === "expired") {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot warn inline"></span>Token expired`,
      `<button class="action-btn" onclick="refreshToken()">Refresh token</button>`,
    );
  } else {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot checking inline"></span>Checking…`,
    );
  }
  container.innerHTML = html;
}

function renderCodexSection() {
  const container = document.getElementById("codex-section");
  if (!container) return;
  if (!trackCodex) {
    container.innerHTML = "";
    return;
  }
  const label = `<span class="provider-label">Codex</span>`;
  let html: string;

  if (codexActionLoading) {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot checking inline"></span>Starting secure sign-in…`,
    );
  } else if (codexState === "ok") {
    html = connRow(
      CODEX_ICON,
      `${label}${codexPlan ? `<span class="plan-tag">${codexPlan}</span>` : ""}`,
      `<span class="status-dot ok inline"></span>Connected · read-only, no quota`,
    );
  } else if (!codexCliInstalled) {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot danger inline"></span>Codex is not installed
       <span class="connection-detail">Install the official CLI or Codex app, then check again.</span>`,
      `<button class="action-btn" onclick="openProviderInstall('codex')">Install Codex</button>
       <button class="action-btn subtle" onclick="checkProviderLogin('codex')">Check again</button>`,
    );
  } else if (codexLoginPending) {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot checking inline"></span>Finish signing in with ChatGPT
       <span class="connection-detail">The browser flow returns securely to Codex. BurnClaw checks automatically.</span>`,
      loginActions("codex"),
    );
  } else if (codexLoginError) {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot danger inline"></span>Sign-in was not completed
       <span class="connection-detail">${escapeHtml(codexLoginError)}</span>`,
      `<button class="action-btn" onclick="runCodexLogin()">Try again</button>
       <button class="action-btn subtle" onclick="checkProviderLogin('codex')">Check again</button>`,
    );
  } else if (codexState === "api_key_only") {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot warn inline"></span>API key only — no plan to track`,
      `<button class="action-btn" onclick="runCodexLogin()">Sign in with ChatGPT</button>`,
    );
  } else {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot danger inline"></span>Not signed in
       <span class="connection-detail">Codex found${codexCliPath ? " and ready to open" : ""}.</span>`,
      `<button class="action-btn" onclick="runCodexLogin()">Sign in with ChatGPT</button>`,
    );
  }
  container.innerHTML = html;
}

function renderHooksSection() {
  const container = document.getElementById("hooks-section");
  if (!container) return;

  const activityRow = (
    provider: "claude" | "codex",
    icon: string,
    name: string,
    installed: boolean,
    count: number,
    file: string,
  ) => {
    const loading = hooksActionLoading === provider;
    const detail = provider === "claude"
      ? "Live sessions, questions and approvals"
      : "Live sessions and allow or deny approvals";
    const installedLabel = provider === "codex" ? "Configured" : "Ready";
    const state = loading
      ? `<span class="status-dot checking inline"></span>Updating live activity…`
      : installed
        ? `<span class="status-dot ok inline"></span>${installedLabel} · ${count} lifecycle events
           <span class="connection-detail">${detail} · ${provider === "codex" ? "restart Codex and review once with /hooks." : "restart Claude Code to apply."}</span>`
        : `<span class="status-dot inline"></span>Not configured
           <span class="connection-detail">${detail}</span>`;
    const actions = loading
      ? ""
      : installed
        ? `<button class="action-btn subtle" onclick="showRemoveModal('${provider}')">Remove</button>`
        : `<button class="action-btn" onclick="installActivity('${provider}')">Enable activity</button>`;
    return connRow(
      icon,
      `<span class="provider-label">${name}</span><code class="path-tag activity-path">${file}</code>`,
      state,
      actions,
    );
  };

  const rows: string[] = [];
  if (trackClaude) {
    rows.push(activityRow("claude", CLAUDE_ICON, "Claude Code", hooksInstalled, hookCount, "~/.claude/settings.json"));
  }
  if (trackCodex) {
    rows.push(activityRow("codex", CODEX_ICON, "Codex", codexHooksInstalled, codexHookCount, "~/.codex/hooks.json"));
  }
  container.innerHTML = rows.join("");
}

function renderReadySummary() {
  const container = document.getElementById("ready-summary");
  if (!container) return;
  const summaryRow = (icon: string, name: string, connected: boolean, live: boolean) => {
    const renderedIcon = icon === CODEX_ICON ? uniqueCodexIcon() : icon;
    const provider = icon === CODEX_ICON ? "codex" : "claude";
    return `<div class="ready-provider">
      <span class="ready-provider-icon" data-provider="${provider}">${renderedIcon}</span>
      <span class="ready-provider-copy">
        <strong>${name}</strong>
        <span><i class="status-dot ${connected ? "ok" : "danger"}"></i>${connected ? "Connected" : "Not connected"}</span>
      </span>
      <span class="ready-live ${live ? "enabled" : ""}">${live ? "Activity configured" : "Usage only"}</span>
    </div>`;
  };
  const rows: string[] = [];
  if (trackClaude) rows.push(summaryRow(CLAUDE_ICON, "Claude", credsState === "ok", hooksInstalled));
  if (trackCodex) rows.push(summaryRow(CODEX_ICON, "Codex", codexState === "ok", codexHooksInstalled));
  container.innerHTML = rows.join("");
}

function renderFooter() {
  const footer = document.getElementById("panel-footer");
  if (!footer) return;
  let leftHtml = "";
  let rightHtml = "";

  if (currentStep === 1) {
    leftHtml = "<div></div>";
    rightHtml = `<button class="btn btn-primary" onclick="goToStep(2)">Get started</button>`;
  } else if (currentStep === 2) {
    leftHtml = `<button class="btn btn-ghost" onclick="goToStep(1)">Back</button>`;
    const claudeOk = !trackClaude || credsState === "ok";
    const codexOk = !trackCodex || codexState === "ok";
    const canContinue =
      claudeOk && codexOk && !credsActionLoading && !codexActionLoading;
    rightHtml = `<button class="btn btn-primary" ${
      canContinue ? 'onclick="goToStep(3)"' : "disabled"
    }>Continue</button>`;
  } else if (currentStep === 3) {
    leftHtml = `<button class="btn btn-ghost" onclick="goToStep(2)">Back</button>`;
    const activityReady = (!trackClaude || hooksInstalled) && (!trackCodex || codexHooksInstalled);
    rightHtml = activityReady
      ? `<button class="btn btn-primary" onclick="goToStep(4)">Continue</button>`
      : `<button class="btn btn-secondary" onclick="goToStep(4)">Skip for now</button>`;
  } else if (currentStep === 4) {
    leftHtml = `<button class="btn btn-ghost" onclick="goToStep(3)">Back</button>`;
    rightHtml = `<button class="btn btn-primary" onclick="completeSetup()">Open BurnClaw</button>`;
  }

  footer.innerHTML = `${leftHtml}<div class="btn-row">${rightHtml}</div>`;
}

function updateTradeOff() {
  const tradeOffEl = document.getElementById("trade-off");
  if (!tradeOffEl) return;
  const planLabel = userPlan in PCT_AT_60S ? userPlan : "max";
  const basePct = PCT_AT_60S[planLabel];
  const pct = ((basePct * 60) / pollingInterval).toFixed(1);
  tradeOffEl.innerHTML = `At ${pollingInterval}s, BurnClaw uses about <strong>${pct}%</strong> of a session window (5h) on your <strong>${planLabel}</strong> plan.`;
}

// ====================================================
// STEP 2 — re-detección periódica (BLOQUE 7)
// Mientras estamos en el paso 2 sin credenciales OK, se re-comprueba cada 3s
// para detectar el login externo sin que el usuario pulse nada.
// ====================================================
function manageStep2Polling() {
  const claudePending = trackClaude && credsState !== "ok";
  const codexPending = trackCodex && codexState !== "ok";
  const shouldPoll =
    currentStep === 2 &&
    (claudePending || codexPending || credsActionLoading || codexActionLoading);

  if (shouldPoll && step2Interval === null) {
    step2Interval = window.setInterval(async () => {
      if (trackClaude) await refreshCredsState();
      if (trackCodex) await refreshCodexState();
      if (credsState === "ok") credsActionLoading = false;
      if (codexState === "ok") codexActionLoading = false;
      renderProviderSelect();
      renderCredsSection();
      renderCodexSection();
      renderFooter();
      manageStep2Polling(); // se auto-detiene al conectar o salir del paso
    }, 3000);
  } else if (!shouldPoll && step2Interval !== null) {
    clearInterval(step2Interval);
    step2Interval = null;
  }
}

// ====================================================
// ACTIONS (window-attached para los onclick inline)
// ====================================================
(window as any).goToStep = (n: number) => {
  currentStep = n;
  renderAll();
};

(window as any).runClaudeLogin = async () => {
  credsActionLoading = true;
  claudeLoginError = null;
  renderCredsSection();
  renderFooter();
  manageStep2Polling();
  try {
    const launch = await invoke<{ pid: number }>("run_claude_login");
    claudeLoginPid = launch.pid;
    claudeLoginPending = true;
  } catch (e) {
    console.error("run_claude_login failed", e);
    claudeLoginPending = false;
    claudeLoginError = String(e);
  }
  credsActionLoading = false;
  await refreshCredsState();
  renderProviderSelect();
  renderCredsSection();
  renderFooter();
  manageStep2Polling();
};

(window as any).runCodexLogin = async () => {
  codexActionLoading = true;
  codexLoginError = null;
  renderCodexSection();
  renderFooter();
  manageStep2Polling();
  try {
    const launch = await invoke<{ pid: number }>("run_codex_login");
    codexLoginPid = launch.pid;
    codexLoginPending = true;
  } catch (e) {
    console.error("run_codex_login failed", e);
    codexLoginPending = false;
    codexLoginError = String(e);
  }
  codexActionLoading = false;
  await refreshCodexState();
  renderProviderSelect();
  renderCodexSection();
  renderFooter();
  manageStep2Polling();
};

(window as any).checkProviderLogin = async (provider: "claude" | "codex") => {
  if (provider === "claude") {
    await refreshCredsState();
    renderCredsSection();
  } else {
    await refreshCodexState();
    renderCodexSection();
  }
  renderProviderSelect();
  renderFooter();
  manageStep2Polling();
};

(window as any).cancelProviderLogin = async (provider: "claude" | "codex") => {
  try {
    await invoke("cancel_provider_login", { provider });
  } catch (e) {
    console.error("cancel_provider_login failed", e);
  }
  if (provider === "claude") {
    claudeLoginPid = null;
    claudeLoginPending = false;
    claudeLoginError = null;
    renderCredsSection();
  } else {
    codexLoginPid = null;
    codexLoginPending = false;
    codexLoginError = null;
    renderCodexSection();
  }
  renderFooter();
  manageStep2Polling();
};

(window as any).restartProviderLogin = async (provider: "claude" | "codex") => {
  await (window as any).cancelProviderLogin(provider);
  if (provider === "claude") {
    await (window as any).runClaudeLogin();
  } else {
    await (window as any).runCodexLogin();
  }
};

(window as any).openProviderInstall = async (provider: "claude" | "codex") => {
  const url = provider === "claude"
    ? "https://code.claude.com/docs/en/setup"
    : "https://developers.openai.com/codex/cli/";
  try {
    await openUrl(url);
  } catch (e) {
    console.error("openProviderInstall failed", e);
  }
};

(window as any).refreshToken = async () => {
  credsActionLoading = true;
  renderCredsSection();
  renderFooter();
  try {
    await invoke("refresh_oauth_token");
    await refreshCredsState();
  } catch (e) {
    console.error("refresh_oauth_token failed", e);
  }
  credsActionLoading = false;
  renderCredsSection();
  renderFooter();
  manageStep2Polling();
};

(window as any).installActivity = async (provider: "claude" | "codex") => {
  hooksActionLoading = provider;
  renderHooksSection();
  renderFooter();
  try {
    await invoke(provider === "claude" ? "install_hooks" : "install_codex_hooks");
    await refreshHooksState();
  } catch (e) {
    console.error(`install_${provider}_activity failed`, e);
  }
  hooksActionLoading = null;
  renderHooksSection();
  renderReadySummary();
  renderFooter();
};

(window as any).showRemoveModal = (provider: "claude" | "codex") => {
  pendingRemovalProvider = provider;
  const name = provider === "claude" ? "Claude Code" : "Codex";
  const file = provider === "claude" ? "~/.claude/settings.json" : "~/.codex/hooks.json";
  const title = document.getElementById("remove-modal-title");
  const text = document.getElementById("remove-modal-text");
  if (title) title.textContent = `Remove ${name} live activity?`;
  if (text) text.textContent = `This removes only BurnClaw's entries from ${file}. Usage and service status keep working.`;
  document.getElementById("modal-backdrop")?.classList.add("visible");
};

(window as any).completeSetup = async () => {
  try {
    await invoke("complete_setup", {
      autoStart: autoStartEnabled,
      pollingIntervalSecs: pollingInterval,
      trackClaude,
      trackCodex,
    });
    // La ventana de setup la cierra el backend (complete_setup).
  } catch (e) {
    console.error("complete_setup failed", e);
  }
};

// ====================================================
// EVENT LISTENERS
// ====================================================
document.getElementById("modal-cancel")?.addEventListener("click", () => {
  document.getElementById("modal-backdrop")?.classList.remove("visible");
});

document
  .getElementById("modal-confirm")
  ?.addEventListener("click", async () => {
    document.getElementById("modal-backdrop")?.classList.remove("visible");
    const provider = pendingRemovalProvider;
    hooksActionLoading = provider;
    renderHooksSection();
    renderFooter();
    try {
      await invoke(provider === "claude" ? "remove_hooks" : "remove_codex_hooks");
      await refreshHooksState();
    } catch (e) {
      console.error(`remove_${provider}_activity failed`, e);
    }
    hooksActionLoading = null;
    renderHooksSection();
    renderReadySummary();
    renderFooter();
  });

// Cierre (X) — sea cual sea el paso, cerrar = salir. El usuario puede relanzar.
document.getElementById("close-btn")?.addEventListener("click", async () => {
  try {
    await invoke("exit_app");
  } catch (e) {
    console.error("exit_app failed", e);
  }
});

document
  .querySelectorAll("#pref-polling .pref-select-option")
  .forEach((opt) => {
    opt.addEventListener("click", () => {
      document
        .querySelectorAll("#pref-polling .pref-select-option")
        .forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
      pollingInterval = parseInt((opt as HTMLElement).dataset.value || "60");
      updateTradeOff();
    });
  });

document
  .querySelectorAll("#provider-select .pref-select-option")
  .forEach((opt) => {
    opt.addEventListener("click", () => {
      const v = (opt as HTMLElement).dataset.value;
      trackClaude = v === "claude" || v === "both";
      trackCodex = v === "codex" || v === "both";
      renderAll();
    });
  });

const autostartEl = document.getElementById(
  "pref-autostart",
) as HTMLInputElement | null;
autostartEl?.addEventListener("change", (e) => {
  autoStartEnabled = (e.target as HTMLInputElement).checked;
});

// Re-comprobar credenciales al volver el foco a la ventana (alt-tab tras login).
window.addEventListener("focus", async () => {
  if (trackClaude) await refreshCredsState();
  if (trackCodex) await refreshCodexState();
  if (credsState === "ok") credsActionLoading = false;
  if (codexState === "ok") codexActionLoading = false;
  renderProviderSelect();
  renderCredsSection();
  renderCodexSection();
  renderFooter();
  manageStep2Polling();
});

// Reabierto desde el menú "Settings" del tray: refresca el estado real.
if (isTauri) {
  void listen<{
    provider: "claude" | "codex";
    pid: number;
    exit_code: number | null;
    cancelled: boolean;
  }>("provider-login-finished", async ({ payload }) => {
    const isCurrentProcess = payload.provider === "claude"
      ? claudeLoginPid === payload.pid
      : codexLoginPid === payload.pid;
    if (!isCurrentProcess) return;

    if (payload.provider === "claude") {
      claudeLoginPid = null;
      claudeLoginPending = false;
      await refreshCredsState();
      if (credsState !== "ok" && !payload.cancelled) {
        claudeLoginError = "The login window was closed before Claude Code saved the account.";
      }
    } else {
      codexLoginPid = null;
      codexLoginPending = false;
      await refreshCodexState();
      if (codexState !== "ok" && !payload.cancelled) {
        codexLoginError = "The login window was closed before Codex saved the account.";
      }
    }

    renderProviderSelect();
    renderCredsSection();
    renderCodexSection();
    renderFooter();
    manageStep2Polling();
  });

  void listen("setup-reopened", async () => {
    await refreshCredsState();
    await refreshCodexState();
    await refreshHooksState();
    renderAll();
  });
}

// ====================================================
// INIT
// ====================================================
async function init() {
  if (!isTauri) {
    const preview = new URLSearchParams(window.location.search);
    const authPreview = preview.get("auth");
    credsState = authPreview ? "missing" : "ok";
    codexState = authPreview ? "missing" : "ok";
    claudeCliInstalled = authPreview !== "not-installed";
    codexCliInstalled = authPreview !== "not-installed";
    claudeCliPath = claudeCliInstalled ? "preview/claude.exe" : null;
    codexCliPath = codexCliInstalled ? "preview/codex.exe" : null;
    claudeLoginPending = authPreview === "pending";
    codexLoginPending = authPreview === "pending";
    claudeLoginError = authPreview === "error" ? "The login window was closed before Claude Code saved the account." : null;
    codexLoginError = authPreview === "error" ? "The login window was closed before Codex saved the account." : null;
    userPlan = "max";
    codexPlan = "plus";
    hooksInstalled = true;
    hookCount = 12;
    codexHooksInstalled = true;
    codexHookCount = 10;
    trackClaude = true;
    trackCodex = true;
    const requestedStep = Number(preview.get("step"));
    if (requestedStep >= 1 && requestedStep <= 4) currentStep = requestedStep;
    renderAll();
    return;
  }

  await refreshCredsState();
  await refreshCodexState();
  await refreshHooksState();

  // Auto-detección: preseleccionar según qué CLIs estén disponibles. Si solo
  // hay uno, se elige ese; si hay ambos (o ninguno), se deja "Both".
  const hasClaude = credsState === "ok";
  const hasCodex = codexState === "ok";
  if (hasCodex && !hasClaude) {
    trackClaude = false;
    trackCodex = true;
  } else if (hasClaude && !hasCodex) {
    trackClaude = true;
    trackCodex = false;
  } else {
    trackClaude = true;
    trackCodex = true;
  }

  renderAll();
}

// Iconos de marca en el selector "What do you want to track?".
function paintOptionIcons() {
  document
    .querySelectorAll<HTMLElement>('.opt-icon[data-icon="claude"]')
    .forEach((e) => (e.innerHTML = CLAUDE_ICON));
  document
    .querySelectorAll<HTMLElement>('.opt-icon[data-icon="codex"]')
    .forEach((e) => (e.innerHTML = uniqueCodexIcon()));
}

paintOptionIcons();
init();
