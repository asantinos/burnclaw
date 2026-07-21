import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CLAUDE_ICON, CODEX_ICON } from "./icons";

// ====================================================
// TYPES & STATE
// ====================================================
// Las claves van en snake_case: serde deserializa SetupState directamente,
// sin rename_all, así que el objeto debe coincidir campo a campo.
interface SetupState {
  completed: boolean;
  providers_chosen: boolean;
  track_claude: boolean;
  track_codex: boolean;
  auto_start: boolean;
  start_minimized: boolean;
  polling_interval_secs: number;
  pill_activity_enabled: boolean;
  pill_activity_claude: boolean;
  pill_activity_codex: boolean;
  pill_activity_working: boolean;
  pill_activity_awaiting: boolean;
  pill_activity_finished: boolean;
  pill_activity_dismiss_secs: number;
  console_banner: boolean;
  warning_threshold: number;
  critical_threshold: number;
  notify_usage_thresholds: boolean;
  notify_claude_finished: boolean;
  notify_claude_needs_you: boolean;
  notify_service_incidents: boolean;
}

type BoolKey =
  | "auto_start"
  | "pill_activity_enabled"
  | "pill_activity_claude"
  | "pill_activity_codex"
  | "pill_activity_working"
  | "pill_activity_awaiting"
  | "pill_activity_finished"
  | "console_banner"
  | "notify_usage_thresholds"
  | "notify_claude_finished"
  | "notify_claude_needs_you"
  | "notify_service_incidents";

const DEFAULTS: SetupState = {
  completed: true,
  providers_chosen: true,
  track_claude: true,
  track_codex: true,
  auto_start: true,
  start_minimized: true,
  polling_interval_secs: 60,
  pill_activity_enabled: true,
  pill_activity_claude: true,
  pill_activity_codex: true,
  pill_activity_working: false,
  pill_activity_awaiting: true,
  pill_activity_finished: true,
  pill_activity_dismiss_secs: 6,
  console_banner: true,
  warning_threshold: 80,
  critical_threshold: 95,
  notify_usage_thresholds: true,
  notify_claude_finished: true,
  notify_claude_needs_you: true,
  notify_service_incidents: false,
};

let state: SetupState = { ...DEFAULTS };
let userPlan = "max";
let hooksActionLoading = false;
let codexNotifyLoading = false;

const SOURCE_URL = "https://github.com/asantinos/burnclaw";
const ISSUES_URL = "https://github.com/asantinos/burnclaw/issues";
const AUTHOR_URL = "https://github.com/asantinos";

// ====================================================
// HELPERS
// ====================================================
function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function input(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}
function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// ====================================================
// NAVIGATION
// ====================================================
function goToSection(name: string) {
  document.querySelectorAll(".nav-item").forEach((it) => {
    it.classList.toggle(
      "active",
      (it as HTMLElement).dataset.section === name,
    );
  });
  document.querySelectorAll(".section-content").forEach((sec) => {
    sec.classList.toggle(
      "active",
      (sec as HTMLElement).dataset.sectionContent === name,
    );
  });
}

// ====================================================
// PERSISTENCE — live-apply, sin botón "Save"
// Cada cambio escribe a disco; un debounce corto evita 1 save por tecla en
// los number-input.
// ====================================================
let saveTimer: number | null = null;
function persist() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = null;
    try {
      await invoke("save_settings", { newSettings: state });
    } catch (e) {
      console.error("save_settings failed", e);
    }
  }, 250);
}

// ====================================================
// CONTROL ↔ STATE
// ====================================================
// Las sub-opciones del panel de actividad dependen del master
// `pill_activity_enabled`: si está off, se deshabilitan y atenúan.
function updateActivityDependents() {
  const enabled = state.pill_activity_enabled;
  [
    "set-pill-claude",
    "set-pill-codex",
    "set-pill-working",
    "set-pill-awaiting",
    "set-pill-finished",
  ].forEach((id) => {
    const c = input(id);
    if (!c) return;
    c.disabled = !enabled;
    c.closest(".pref-row")?.classList.toggle("pref-disabled", !enabled);
  });
  document
    .getElementById("set-pill-dismiss")
    ?.closest(".pref-row")
    ?.classList.toggle("pref-disabled", !enabled);
  ["activity-show-for-heading", "activity-when-heading"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("pref-disabled", !enabled);
  });
}

function updateProviderControls() {
  const claude = input("set-track-claude");
  const codex = input("set-track-codex");
  if (!claude || !codex) return;
  claude.checked = state.track_claude;
  codex.checked = state.track_codex;
  // One provider must remain visible. Enable the other before disabling the last one.
  claude.disabled = state.track_claude && !state.track_codex;
  codex.disabled = state.track_codex && !state.track_claude;
}

function populateControls() {
  const bools: [string, BoolKey][] = [
    ["set-pill-activity", "pill_activity_enabled"],
    ["set-pill-claude", "pill_activity_claude"],
    ["set-pill-codex", "pill_activity_codex"],
    ["set-pill-working", "pill_activity_working"],
    ["set-pill-awaiting", "pill_activity_awaiting"],
    ["set-pill-finished", "pill_activity_finished"],
    ["set-console-banner", "console_banner"],
    ["set-auto-start", "auto_start"],
    ["set-notify-usage", "notify_usage_thresholds"],
    ["set-notify-finished", "notify_claude_finished"],
    ["set-notify-needs-you", "notify_claude_needs_you"],
    ["set-notify-incidents", "notify_service_incidents"],
  ];
  for (const [id, key] of bools) {
    const c = input(id);
    if (c) c.checked = state[key];
  }
  updateProviderControls();
  updateActivityDependents();

  // Start mode: pill = start_minimized true, window = false.
  document
    .querySelectorAll("#set-start-mode .pref-select-option")
    .forEach((opt) => {
      const isPill = (opt as HTMLElement).dataset.value === "pill";
      opt.classList.toggle("selected", isPill === state.start_minimized);
    });

  const warnEl = input("set-warning-threshold");
  if (warnEl) warnEl.value = String(state.warning_threshold);
  const critEl = input("set-critical-threshold");
  if (critEl) critEl.value = String(state.critical_threshold);

  document
    .querySelectorAll("#set-polling .pref-select-option")
    .forEach((opt) => {
      opt.classList.toggle(
        "selected",
        (opt as HTMLElement).dataset.value ===
          String(state.polling_interval_secs),
      );
    });

  document
    .querySelectorAll("#set-pill-dismiss .pref-select-option")
    .forEach((opt) => {
      opt.classList.toggle(
        "selected",
        (opt as HTMLElement).dataset.value ===
          String(state.pill_activity_dismiss_secs),
      );
    });

  updateThresholdBar();
  updateTradeOff();
}

function updateThresholdBar() {
  const warn = clampPct(state.warning_threshold);
  const crit = clampPct(state.critical_threshold);

  const seg = el("thr-segment");
  if (seg) {
    seg.style.left = "0";
    seg.style.right = `${100 - warn}%`;
  }
  const wm = el("thr-warn-marker");
  if (wm) {
    wm.style.left = `${warn}%`;
    wm.dataset.label = `warning ${warn}%`;
  }
  const cm = el("thr-crit-marker");
  if (cm) {
    cm.style.left = `${crit}%`;
    cm.dataset.label = `critical ${crit}%`;
  }
}

function updateTradeOff() {
  const elTrade = el("set-trade-off");
  if (!elTrade) return;
  const descriptions: Record<number, string> = {
    30: "Fastest updates with more frequent background checks.",
    60: "Recommended balance between freshness and background activity.",
    120: "Fewer background checks; usage may take up to two minutes to update.",
    300: "Lowest background activity; usage may take up to five minutes to update.",
  };
  elTrade.textContent = descriptions[state.polling_interval_secs] ?? descriptions[60];
}

// ====================================================
// ACCOUNT / HOOKS — estado vivo del backend
// ====================================================
// `showChecking`: pinta el estado "checking" con el dot pulsante y lo mantiene
// un mínimo visible. Solo para acciones explícitas (botón Re-check, abrir la
// ventana). El re-check por foco es silencioso para no animar en cada alt-tab.
async function renderAccount(showChecking = true) {
  const ccBox = el("cc-status");
  const credsBox = el("creds-file-status");
  if (!ccBox || !credsBox) return;

  let minVisible: Promise<unknown> = Promise.resolve();
  if (showChecking) {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot checking"></span>
          <div class="status-text">Checking Claude Code…</div>
        </div>
      </div>`;
    minVisible = new Promise((r) => setTimeout(r, 450));
  }

  let credsState: "ok" | "missing" | "expired" | "unknown" = "unknown";
  try {
    const check = await invoke<any>("check_credentials");
    credsState = check.state;
    if (check.subscription_type) userPlan = check.subscription_type;
  } catch {
    credsState = "missing";
  }

  await minVisible;

  if (credsState === "ok") {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="provider-label">Claude</span><span class="plan-tag">${userPlan}</span>
            <div class="meta">
              <span class="status-dot ok inline"></span>Connected · managed by Claude Code
            </div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn subtle" onclick="recheckAccount()">Check again</button>
        </div>
      </div>`;
  } else if (credsState === "expired") {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot warn inline"></span>Token expired
            <div class="meta">Run <code>claude login</code> again to renew it.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openClaudeLogin()">Sign in to Claude</button>
        </div>
      </div>`;
  } else {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot danger inline"></span>Claude Code not signed in
            <div class="meta">BurnClaw needs an authenticated Claude Code session to read usage.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openClaudeLogin()">Sign in to Claude</button>
        </div>
      </div>`;
  }

  const fileFound = credsState === "ok" || credsState === "expired";
  credsBox.innerHTML = `
    <div class="status-line">
      <div class="status-line-header">
        <div class="status-text">
          <span class="provider-label">Claude</span>
          <div class="meta">
            <span class="status-dot ${fileFound ? "ok" : "danger"} inline"></span>${
              fileFound ? "File found" : "File not found"
            } · <code class="path-tag">~/.claude/.credentials.json</code>
          </div>
        </div>
      </div>
    </div>`;

  updateTradeOff();
}

async function renderCodexAccount(showChecking = true) {
  const box = el("codex-status");
  const fileBox = el("codex-file-status");
  if (!box || !fileBox) return;

  let minVisible: Promise<unknown> = Promise.resolve();
  if (showChecking) {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot checking"></span>
          <div class="status-text">Checking Codex…</div>
        </div>
      </div>`;
    minVisible = new Promise((r) => setTimeout(r, 450));
  }

  let cstate: "ok" | "api_key_only" | "missing" | "unknown" = "unknown";
  let email: string | null = null;
  try {
    const check = await invoke<any>("check_codex_credentials");
    cstate = check.state;
    email = check.email ?? null;
  } catch {
    cstate = "missing";
  }

  let plan: string | null = null;
  if (cstate === "ok") {
    try {
      const usage = await invoke<any>("get_current_codex_usage");
      if (usage?.plan_type) plan = usage.plan_type;
    } catch {
      /* sin datos de uso todavía */
    }
  }

  await minVisible;

  if (cstate === "ok") {
    const planTxt = plan
      ? `<span class="provider-label">Codex</span><span class="plan-tag">${plan}</span>`
      : `<span class="provider-label">Codex</span>`;
    const metaTxt = email
      ? `Connected · ${email}`
      : "Connected · managed by Codex CLI";
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            ${planTxt}
            <div class="meta">
              <span class="status-dot ok inline"></span>${metaTxt}
            </div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn subtle" onclick="recheckCodex()">Check again</button>
        </div>
      </div>`;
  } else if (cstate === "api_key_only") {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot warn inline"></span>Signed in with an API key
            <div class="meta">API-key usage has no plan limits to track. Sign in with ChatGPT to track Codex.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openCodexLogin()">Sign in to Codex</button>
        </div>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot danger inline"></span>Codex not signed in
            <div class="meta">Sign in with ChatGPT in Codex CLI to track usage.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openCodexLogin()">Sign in to Codex</button>
        </div>
      </div>`;
  }

  const found = cstate === "ok" || cstate === "api_key_only";
  fileBox.innerHTML = `
    <div class="status-line">
      <div class="status-line-header">
        <div class="status-text">
          <span class="provider-label">Codex</span>
          <div class="meta">
            <span class="status-dot ${found ? "ok" : "danger"} inline"></span>${
              found ? "File found" : "File not found"
            } · <code class="path-tag">~/.codex/auth.json</code>
          </div>
        </div>
      </div>
    </div>`;
}

async function renderHooks() {
  const statusBox = el("hooks-status");
  const backupBox = el("hooks-backup");
  if (!statusBox || !backupBox) return;

  if (hooksActionLoading) {
    statusBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot checking inline"></span>Updating live activity...
            <div class="meta">Applying the local Claude Code connection.</div>
          </div>
        </div>
      </div>`;
    return;
  }

  let installed = false;
  let count = 0;
  try {
    const check = await invoke<any>("check_hooks_status");
    installed = check.installed;
    count = check.hook_count;
  } catch {
    installed = false;
  }

  if (installed) {
    statusBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot ok inline"></span>Live activity enabled
            <div class="meta">${count} events connected · restart Claude Code after changes</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn danger" onclick="removeHooks()">Turn off</button>
        </div>
      </div>`;
    backupBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <div class="status-text-row">
              <span><span class="status-dot ok inline"></span>Configuration protected</span>
              <code class="path-tag">~/.claude/settings.json.bak</code>
            </div>
            <div class="meta">Original settings saved before BurnClaw made changes.</div>
          </div>
        </div>
      </div>`;
  } else {
    statusBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot inline"></span>Live activity is off
            <div class="meta">Your existing Claude Code configuration will be preserved.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="installHooks()">Enable live activity</button>
        </div>
      </div>`;
    backupBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <div class="status-text-row">
              <span><span class="status-dot inline"></span>Configuration unchanged</span>
              <code class="path-tag">~/.claude/settings.json</code>
            </div>
            <div class="meta">BurnClaw creates a backup automatically before enabling activity.</div>
          </div>
        </div>
      </div>`;
  }
}

async function renderCodexNotify() {
  const box = el("codex-notify-status");
  if (!box) return;

  if (codexNotifyLoading) {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot checking inline"></span>Updating live activity...
            <div class="meta">Applying the local Codex connection.</div>
          </div>
        </div>
      </div>`;
    return;
  }

  let installed = false;
  try {
    const check = await invoke<any>("check_codex_hooks_status");
    installed = check.installed;
  } catch {
    installed = false;
  }

  if (installed) {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <div class="status-text-row">
              <span><span class="status-dot ok inline"></span>Live activity enabled</span>
              <code class="path-tag">~/.codex/hooks.json</code>
            </div>
            <div class="meta">Sessions and approvals connected · restart Codex after changes.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn danger" onclick="removeCodexNotify()">Turn off</button>
        </div>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot inline"></span>Live activity is off
            <div class="meta">Your existing Codex configuration will be preserved.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="installCodexNotify()">Enable live activity</button>
        </div>
      </div>`;
  }
}

// ====================================================
// WINDOW-ATTACHED ACTIONS (para los onclick inline del HTML renderado)
// ====================================================
(window as any).recheckAccount = () => {
  void renderAccount();
};

(window as any).recheckCodex = () => {
  void renderCodexAccount();
};

(window as any).openClaudeLogin = async () => {
  try {
    await invoke("run_claude_login");
  } catch (e) {
    console.error("run_claude_login failed", e);
  }
};

(window as any).openCodexLogin = async () => {
  try {
    await invoke("run_codex_login");
  } catch (e) {
    console.error("run_codex_login failed", e);
  }
};

(window as any).installHooks = async () => {
  hooksActionLoading = true;
  void renderHooks();
  try {
    await invoke("install_hooks");
  } catch (e) {
    console.error("install_hooks failed", e);
  }
  hooksActionLoading = false;
  void renderHooks();
};

(window as any).removeHooks = async () => {
  hooksActionLoading = true;
  void renderHooks();
  try {
    await invoke("remove_hooks");
  } catch (e) {
    console.error("remove_hooks failed", e);
  }
  hooksActionLoading = false;
  void renderHooks();
};

(window as any).installCodexNotify = async () => {
  codexNotifyLoading = true;
  void renderCodexNotify();
  try {
    await invoke("install_codex_hooks");
  } catch (e) {
    console.error("install_codex_hooks failed", e);
  }
  codexNotifyLoading = false;
  void renderCodexNotify();
};

(window as any).removeCodexNotify = async () => {
  codexNotifyLoading = true;
  void renderCodexNotify();
  try {
    await invoke("remove_codex_hooks");
  } catch (e) {
    console.error("remove_codex_hooks failed", e);
  }
  codexNotifyLoading = false;
  void renderCodexNotify();
};

// ====================================================
// STATIC CONTROL WIRING
// ====================================================
function wireControls() {
  // Navegación lateral
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () =>
      goToSection((item as HTMLElement).dataset.section || "account"),
    );
  });

  ([
    ["set-track-claude", "track_claude"],
    ["set-track-codex", "track_codex"],
  ] as const).forEach(([id, key]) => {
    input(id)?.addEventListener("change", (event) => {
      const control = event.currentTarget as HTMLInputElement;
      state[key] = control.checked;
      state.providers_chosen = true;
      if (!state.track_claude && !state.track_codex) {
        state[key] = true;
      }
      updateProviderControls();
      persist();
    });
  });

  // Toggles
  const bools: [string, BoolKey][] = [
    ["set-pill-activity", "pill_activity_enabled"],
    ["set-pill-claude", "pill_activity_claude"],
    ["set-pill-codex", "pill_activity_codex"],
    ["set-pill-working", "pill_activity_working"],
    ["set-pill-awaiting", "pill_activity_awaiting"],
    ["set-pill-finished", "pill_activity_finished"],
    ["set-console-banner", "console_banner"],
    ["set-auto-start", "auto_start"],
    ["set-notify-usage", "notify_usage_thresholds"],
    ["set-notify-finished", "notify_claude_finished"],
    ["set-notify-needs-you", "notify_claude_needs_you"],
    ["set-notify-incidents", "notify_service_incidents"],
  ];
  for (const [id, key] of bools) {
    const c = input(id);
    c?.addEventListener("change", () => {
      state[key] = c.checked;
      if (key === "pill_activity_enabled") updateActivityDependents();
      persist();
    });
  }

  // Start mode segmented (pill / window)
  document
    .querySelectorAll("#set-start-mode .pref-select-option")
    .forEach((opt) => {
      opt.addEventListener("click", () => {
        document
          .querySelectorAll("#set-start-mode .pref-select-option")
          .forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        state.start_minimized =
          (opt as HTMLElement).dataset.value === "pill";
        persist();
      });
    });

  // Polling segmented
  document
    .querySelectorAll("#set-polling .pref-select-option")
    .forEach((opt) => {
      opt.addEventListener("click", () => {
        document
          .querySelectorAll("#set-polling .pref-select-option")
          .forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        state.polling_interval_secs = parseInt(
          (opt as HTMLElement).dataset.value || "60",
          10,
        );
        updateTradeOff();
        persist();
      });
    });

  // Auto-dismiss del panel de actividad (segundos; 0 = nunca)
  document
    .querySelectorAll("#set-pill-dismiss .pref-select-option")
    .forEach((opt) => {
      opt.addEventListener("click", () => {
        document
          .querySelectorAll("#set-pill-dismiss .pref-select-option")
          .forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        state.pill_activity_dismiss_secs = parseInt(
          (opt as HTMLElement).dataset.value || "6",
          10,
        );
        persist();
      });
    });

  // Number inputs (umbrales)
  wireThreshold("set-warning-threshold", "warning_threshold");
  wireThreshold("set-critical-threshold", "critical_threshold");

  // Logs — ambos botones abren la misma carpeta
  document.querySelectorAll(".js-open-logs").forEach((btn) => {
    btn.addEventListener("click", () => {
      invoke("open_logs_folder").catch((e) =>
        console.error("open_logs_folder failed", e),
      );
    });
  });

  // Reset — borra setup.json y reabre el wizard
  el("btn-reset-settings")?.addEventListener("click", async () => {
    try {
      await invoke("reset_settings");
    } catch (e) {
      console.error("reset_settings failed", e);
    }
  });

  // About — enlaces externos
  el("link-author")?.addEventListener("click", (e) => {
    e.preventDefault();
    openUrl(AUTHOR_URL).catch((err) => console.error(err));
  });
  el("link-source")?.addEventListener("click", (e) => {
    e.preventDefault();
    openUrl(SOURCE_URL).catch((err) => console.error(err));
  });
  el("btn-report-issue")?.addEventListener("click", () => {
    openUrl(ISSUES_URL).catch((err) => console.error(err));
  });

  el("close-btn")?.addEventListener("click", () => {
    invoke("hide_settings").catch((e) => console.error("hide_settings failed", e));
  });
}

function wireThreshold(
  id: string,
  key: "warning_threshold" | "critical_threshold",
) {
  const elInput = input(id);
  if (!elInput) return;
  elInput.addEventListener("input", () => {
    const v = parseInt(elInput.value, 10);
    if (isNaN(v)) return;
    state[key] = clampPct(v);
    updateThresholdBar();
    persist();
  });
  // Al perder foco, normaliza el campo al valor saneado.
  elInput.addEventListener("blur", () => {
    elInput.value = String(state[key]);
  });
}

// ====================================================
// REFRESH / INIT
// ====================================================
async function loadSettings() {
  try {
    state = await invoke<SetupState>("get_settings");
  } catch (e) {
    console.error("get_settings failed", e);
    state = { ...DEFAULTS };
  }
  populateControls();
}

async function refreshAll() {
  await loadSettings();
  await renderAccount();
  await renderCodexAccount();
  await renderHooks();
  await renderCodexNotify();
}

// Reabierta desde el menú "Settings" del tray: refresca el estado real.
listen("settings-reopened", () => {
  void refreshAll();
});

// Al recuperar el foco (p. ej. tras un `claude login` externo), re-check
// silencioso: actualiza el estado si cambió, sin animar en cada alt-tab.
window.addEventListener("focus", () => {
  void renderAccount(false);
  void renderCodexAccount(false);
  void renderHooks();
  void renderCodexNotify();
});

// Marcas de proveedor (iconos SVG) en Providers — estáticas, se pintan una vez.
function paintProviderMarks() {
  document
    .querySelectorAll<HTMLElement>('[data-provider="claude"].provider-mark, [data-provider="claude"].mini-provider-mark')
    .forEach((e) => (e.innerHTML = CLAUDE_ICON));
  document
    .querySelectorAll<HTMLElement>('[data-provider="codex"].provider-mark, [data-provider="codex"].mini-provider-mark')
    .forEach((e) => (e.innerHTML = CODEX_ICON));
}

paintProviderMarks();
wireControls();
void refreshAll();
