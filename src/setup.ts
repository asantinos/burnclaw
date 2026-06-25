import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CLAUDE_ICON, CODEX_ICON } from "./icons";

// ====================================================
// STATE
// ====================================================
let currentStep = 1;
let credsState: "ok" | "missing" | "expired" | "unknown" = "unknown";
let userPlan = "unknown";
let hooksInstalled = false;
let hookCount = 0;
let credsActionLoading = false;
let hooksActionLoading = false;
let autoStartEnabled = true;
let pollingInterval = 60;
let step2Interval: number | null = null;

// --- Providers a trackear (elegidos en el Welcome) ---
let trackClaude = true;
let trackCodex = false;
let codexState: "ok" | "api_key_only" | "missing" | "unknown" = "unknown";
let codexActionLoading = false;

// % por plan a 60s (community estimates — ver Consumption budget reference)
const PCT_AT_60S: Record<string, number> = { pro: 6.8, max: 3.4, max20: 1.4 };

// ====================================================
// BACKEND STATE
// ====================================================
async function refreshCredsState() {
  try {
    const check = await invoke<any>("check_credentials");
    credsState = check.state;
    if (check.subscription_type) userPlan = check.subscription_type;
  } catch {
    credsState = "missing";
  }
}

let codexPlan: string | null = null;
async function refreshCodexState() {
  try {
    const check = await invoke<any>("check_codex_credentials");
    codexState = check.state;
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
  try {
    const check = await invoke<any>("check_hooks_status");
    hooksInstalled = check.installed;
    hookCount = check.hook_count;
  } catch {
    hooksInstalled = false;
    hookCount = 0;
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

function renderSidebar() {
  document.querySelectorAll(".step").forEach((step) => {
    const n = parseInt((step as HTMLElement).dataset.step || "0");
    step.classList.remove("active", "done");
    const numberEl = step.querySelector(".step-number");
    if (!numberEl) return;
    if (n < currentStep) {
      step.classList.add("done");
      numberEl.textContent = "✓";
    } else if (n === currentStep) {
      step.classList.add("active");
      numberEl.textContent = String(n);
    } else {
      numberEl.textContent = String(n);
    }
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
  return `
    <div class="provider-row">
      <span class="provider-mark" data-provider="${provider}">${icon}</span>
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
      `<span class="status-dot checking inline"></span>Opening login…`,
    );
  } else if (credsState === "ok") {
    html = connRow(
      CLAUDE_ICON,
      `${label}<span class="plan-tag">${userPlan}</span>`,
      `<span class="status-dot ok inline"></span>Connected · managed by Claude Code`,
    );
  } else if (credsState === "missing") {
    html = connRow(
      CLAUDE_ICON,
      label,
      `<span class="status-dot danger inline"></span>Not signed in`,
      `<button class="action-btn" onclick="runClaudeLogin()">Open Claude Code login</button>`,
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
      `<span class="status-dot checking inline"></span>Opening login…`,
    );
  } else if (codexState === "ok") {
    html = connRow(
      CODEX_ICON,
      `${label}${codexPlan ? `<span class="plan-tag">${codexPlan}</span>` : ""}`,
      `<span class="status-dot ok inline"></span>Connected · read-only, no quota`,
    );
  } else if (codexState === "api_key_only") {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot warn inline"></span>API key only — no plan to track`,
      `<button class="action-btn" onclick="runCodexLogin()">Open Codex login</button>`,
    );
  } else {
    html = connRow(
      CODEX_ICON,
      label,
      `<span class="status-dot danger inline"></span>Not signed in`,
      `<button class="action-btn" onclick="runCodexLogin()">Open Codex login</button>`,
    );
  }
  container.innerHTML = html;
}

function renderHooksSection() {
  const container = document.getElementById("hooks-section");
  if (!container) return;
  let html = "";

  if (hooksActionLoading) {
    const verb = hooksInstalled ? "Removing" : "Installing";
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot checking inline"></span>${verb} hooks…
            <div class="meta">Writing to ~/.claude/settings.json</div>
          </div>
        </div>
      </div>`;
  } else if (hooksInstalled) {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <div class="status-text-row">
              <span><span class="status-dot ok inline"></span>Hooks installed</span>
              <code class="path-tag">~/.claude/settings.json</code>
            </div>
            <div class="meta">${hookCount} lifecycle events registered · restart Claude Code to apply</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn danger" onclick="showRemoveModal()">Remove</button>
        </div>
      </div>`;
  } else {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <div class="status-text">
            <span class="status-dot inline"></span>Hooks not configured
            <div class="meta">Existing hooks in your settings.json will be preserved (backup created).</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="installHooks()">Install hooks</button>
        </div>
      </div>`;
  }
  container.innerHTML = html;
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
    rightHtml = hooksInstalled
      ? `<button class="btn btn-primary" onclick="goToStep(4)">Continue</button>`
      : `<button class="btn btn-secondary" onclick="goToStep(4)">Skip for now</button>`;
  } else if (currentStep === 4) {
    leftHtml = `<button class="btn btn-ghost" onclick="goToStep(3)">Back</button>`;
    rightHtml = `<button class="btn btn-primary" onclick="completeSetup()">Done</button>`;
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
  renderCredsSection();
  renderFooter();
  manageStep2Polling();
  try {
    await invoke("run_claude_login");
  } catch (e) {
    console.error("run_claude_login failed", e);
  }
  // Timeout de seguridad: si en 2 min no se detecta el login, quita el spinner.
  setTimeout(() => {
    if (credsActionLoading && credsState !== "ok") {
      credsActionLoading = false;
      renderCredsSection();
      renderFooter();
      manageStep2Polling();
    }
  }, 120000);
};

(window as any).runCodexLogin = async () => {
  codexActionLoading = true;
  renderCodexSection();
  renderFooter();
  manageStep2Polling();
  try {
    await invoke("run_codex_login");
  } catch (e) {
    console.error("run_codex_login failed", e);
  }
  // Timeout de seguridad: si en 2 min no se detecta el login, quita el spinner.
  setTimeout(() => {
    if (codexActionLoading && codexState !== "ok") {
      codexActionLoading = false;
      renderCodexSection();
      renderFooter();
      manageStep2Polling();
    }
  }, 120000);
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

(window as any).installHooks = async () => {
  hooksActionLoading = true;
  renderHooksSection();
  renderFooter();
  try {
    await invoke("install_hooks");
    await refreshHooksState();
  } catch (e) {
    console.error("install_hooks failed", e);
  }
  hooksActionLoading = false;
  renderHooksSection();
  renderFooter();
};

(window as any).showRemoveModal = () => {
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
    hooksActionLoading = true;
    renderHooksSection();
    renderFooter();
    try {
      await invoke("remove_hooks");
      await refreshHooksState();
    } catch (e) {
      console.error("remove_hooks failed", e);
    }
    hooksActionLoading = false;
    renderHooksSection();
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
listen("setup-reopened", async () => {
  await refreshCredsState();
  await refreshCodexState();
  await refreshHooksState();
  renderAll();
});

// ====================================================
// INIT
// ====================================================
async function init() {
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
    .forEach((e) => (e.innerHTML = CODEX_ICON));
}

paintOptionIcons();
init();
