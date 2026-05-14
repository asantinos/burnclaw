import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

// ====================================================
// TYPES & STATE
// ====================================================
// Las claves van en snake_case: serde deserializa SetupState directamente,
// sin rename_all, así que el objeto debe coincidir campo a campo.
interface SetupState {
  completed: boolean;
  auto_start: boolean;
  start_minimized: boolean;
  polling_interval_secs: number;
  orange_border: boolean;
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
  | "orange_border"
  | "console_banner"
  | "notify_usage_thresholds"
  | "notify_claude_finished"
  | "notify_claude_needs_you"
  | "notify_service_incidents";

const DEFAULTS: SetupState = {
  completed: true,
  auto_start: true,
  start_minimized: true,
  polling_interval_secs: 60,
  orange_border: true,
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

const SOURCE_URL = "https://github.com/asantinos/burnclaw";
const ISSUES_URL = "https://github.com/asantinos/burnclaw/issues";
const AUTHOR_URL = "https://github.com/asantinos";

// % de una ventana de 5h consumido a 60s, por plan (estimaciones community).
const PCT_AT_60S: Record<string, number> = { pro: 6.8, max: 3.4, max20: 1.4 };

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
function populateControls() {
  const bools: [string, BoolKey][] = [
    ["set-orange-border", "orange_border"],
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
    wm.dataset.label = `warn ${warn}%`;
  }
  const cm = el("thr-crit-marker");
  if (cm) {
    cm.style.left = `${crit}%`;
    cm.dataset.label = `crit ${crit}%`;
  }
}

function updateTradeOff() {
  const elTrade = el("set-trade-off");
  if (!elTrade) return;
  const planLabel = userPlan in PCT_AT_60S ? userPlan : "max";
  const basePct = PCT_AT_60S[planLabel];
  const pct = ((basePct * 60) / state.polling_interval_secs).toFixed(1);
  elTrade.innerHTML = `At ${state.polling_interval_secs}s, BurnClaw uses about <strong>${pct}%</strong> of a session window (5h) on your <strong>${planLabel}</strong> plan.`;
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
          <span class="status-dot ok"></span>
          <div class="status-text">
            Connected — <strong>${userPlan}</strong> plan
            <div class="meta">Managed by Claude Code.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn subtle" onclick="recheckAccount()">Re-check</button>
        </div>
      </div>`;
  } else if (credsState === "expired") {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot warn"></span>
          <div class="status-text">
            Token expired
            <div class="meta">Run <code>claude login</code> again to renew it.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openClaudeLogin()">Open Claude Code login</button>
        </div>
      </div>`;
  } else {
    ccBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot danger"></span>
          <div class="status-text">
            Claude Code not signed in
            <div class="meta">BurnClaw needs an authenticated Claude Code session to read usage.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="openClaudeLogin()">Open Claude Code login</button>
        </div>
      </div>`;
  }

  const fileFound = credsState === "ok" || credsState === "expired";
  credsBox.innerHTML = `
    <div class="status-line">
      <div class="status-line-header">
        <span class="status-dot ${fileFound ? "ok" : "danger"}"></span>
        <div class="status-text">
          <div class="status-text-row">
            <span>${fileFound ? "File found" : "File not found"}</span>
            <code class="path-tag">~/.claude/.credentials.json</code>
          </div>
          <div class="meta">BurnClaw reads this file only — never modifies it.</div>
        </div>
      </div>
    </div>`;

  updateTradeOff();
}

async function renderHooks() {
  const statusBox = el("hooks-status");
  const backupBox = el("hooks-backup");
  if (!statusBox || !backupBox) return;

  if (hooksActionLoading) {
    statusBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot checking"></span>
          <div class="status-text">
            Updating hooks…
            <div class="meta">Writing to ~/.claude/settings.json</div>
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
          <span class="status-dot ok"></span>
          <div class="status-text">
            Hooks installed
            <div class="meta">${count} lifecycle events registered · restart Claude Code to apply</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn danger" onclick="removeHooks()">Remove hooks</button>
        </div>
      </div>`;
    backupBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot ok"></span>
          <div class="status-text">
            <div class="status-text-row">
              <span>Backup created</span>
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
          <span class="status-dot"></span>
          <div class="status-text">
            Hooks not configured
            <div class="meta">Existing hooks in your settings.json will be preserved (backup created).</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="installHooks()">Install hooks</button>
        </div>
      </div>`;
    backupBox.innerHTML = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot"></span>
          <div class="status-text">
            <div class="status-text-row">
              <span>No changes made yet</span>
              <code class="path-tag">~/.claude/settings.json</code>
            </div>
            <div class="meta">A backup is created automatically when hooks are installed.</div>
          </div>
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

(window as any).openClaudeLogin = async () => {
  try {
    await invoke("run_claude_login");
  } catch (e) {
    console.error("run_claude_login failed", e);
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

  // Toggles
  const bools: [string, BoolKey][] = [
    ["set-orange-border", "orange_border"],
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
  await renderHooks();
}

// Reabierta desde el menú "Settings" del tray: refresca el estado real.
listen("settings-reopened", () => {
  void refreshAll();
});

// Al recuperar el foco (p. ej. tras un `claude login` externo), re-check
// silencioso: actualiza el estado si cambió, sin animar en cada alt-tab.
window.addEventListener("focus", () => {
  void renderAccount(false);
  void renderHooks();
});

wireControls();
void refreshAll();
