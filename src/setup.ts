import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  renderCredsSection();
  renderHooksSection();
  renderFooter();
  updateTradeOff();
  manageStep2Polling();
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

function renderCredsSection() {
  const container = document.getElementById("creds-section");
  if (!container) return;
  let html = "";

  if (credsActionLoading) {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot checking"></span>
          <div class="status-text">
            Opening Claude Code login…
            <div class="meta">Complete the login in your terminal, then come back here.</div>
          </div>
        </div>
      </div>`;
  } else if (credsState === "ok") {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot ok"></span>
          <div class="status-text">
            Connected — <strong>${userPlan}</strong> plan
            <div class="meta">Managed by Claude Code.</div>
          </div>
        </div>
      </div>`;
  } else if (credsState === "missing") {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot danger"></span>
          <div class="status-text">
            Claude Code not signed in
            <div class="meta">BurnClaw needs an authenticated Claude Code session to read usage.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="runClaudeLogin()">Open Claude Code login</button>
        </div>
      </div>`;
  } else if (credsState === "expired") {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot warn"></span>
          <div class="status-text">
            Token expired
            <div class="meta">Run <code>claude login</code> again, or BurnClaw can try refreshing.</div>
          </div>
        </div>
        <div class="status-line-actions">
          <button class="action-btn" onclick="refreshToken()">Refresh token</button>
        </div>
      </div>`;
  } else {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot checking"></span>
          <div class="status-text">Checking Claude Code…</div>
        </div>
      </div>`;
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
          <span class="status-dot checking"></span>
          <div class="status-text">
            ${verb} hooks…
            <div class="meta">Writing to ~/.claude/settings.json</div>
          </div>
        </div>
      </div>`;
  } else if (hooksInstalled) {
    html = `
      <div class="status-line">
        <div class="status-line-header">
          <span class="status-dot ok"></span>
          <div class="status-text">
            <div class="status-text-row">
              <span>Hooks installed</span>
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
    const canContinue = credsState === "ok" && !credsActionLoading;
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
  const shouldPoll =
    currentStep === 2 &&
    (credsState === "missing" ||
      credsState === "expired" ||
      credsActionLoading);

  if (shouldPoll && step2Interval === null) {
    step2Interval = window.setInterval(async () => {
      await refreshCredsState();
      if (credsState === "ok") credsActionLoading = false;
      renderCredsSection();
      renderFooter();
      manageStep2Polling(); // se auto-detiene al pasar a ok o salir del paso
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

const autostartEl = document.getElementById(
  "pref-autostart",
) as HTMLInputElement | null;
autostartEl?.addEventListener("change", (e) => {
  autoStartEnabled = (e.target as HTMLInputElement).checked;
});

// Re-comprobar credenciales al volver el foco a la ventana (alt-tab tras login).
window.addEventListener("focus", async () => {
  await refreshCredsState();
  if (credsState === "ok") credsActionLoading = false;
  renderCredsSection();
  renderFooter();
  manageStep2Polling();
});

// Reabierto desde el menú "Settings" del tray: refresca el estado real.
listen("setup-reopened", async () => {
  await refreshCredsState();
  await refreshHooksState();
  renderAll();
});

// ====================================================
// INIT
// ====================================================
async function init() {
  await refreshCredsState();
  await refreshHooksState();
  renderAll();
}

init();
