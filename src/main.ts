import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

interface UsageSnapshot {
  session_5h_pct: number;
  session_5h_reset_at: string;
  weekly_pct: number;
  weekly_reset_at: string;
  fetched_at: string;
  unified_status: string;
  session_5h_status: string;
  weekly_7d_status: string;
  representative_claim: string;
  overage_status: string;
  overage_disabled_reason: string | null;
}

interface StatusSnapshot {
  indicator: string;
  description: string;
  fetched_at: string;
}

type LevelClass = "ok" | "warn" | "orange" | "danger";

const appWindow = getCurrentWindow();
const $ = (id: string) => document.getElementById(id)!;

const els = {
  shell: $("shell"),
  pillContent: $("pill-content"),
  widgetContent: $("widget-content"),
  // pill
  pillDot: $("pill-dot"),
  ringSession: $("ring-session"),
  ringWeekly: $("ring-weekly"),
  progressSession: $("progress-session") as unknown as SVGCircleElement,
  progressWeekly: $("progress-weekly") as unknown as SVGCircleElement,
  labelSession: $("label-session"),
  labelWeekly: $("label-weekly"),
  // widget
  statusIndicator: $("status-indicator"),
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  sessionPct: $("session-pct"),
  sessionBar: $("session-bar"),
  sessionTag: $("session-tag"),
  sessionCountdown: $("session-countdown"),
  sessionReset: $("session-reset"),
  weeklyPct: $("weekly-pct"),
  weeklyBar: $("weekly-bar"),
  weeklyTag: $("weekly-tag"),
  weeklyCountdown: $("weekly-countdown"),
  weeklyReset: $("weekly-reset"),
  updatedAgo: $("updated-ago"),
  viewDetails: $("view-details"),
  btnClose: $("btn-close"),
  btnRefresh: $("btn-refresh"),
};

const CIRCUMFERENCE = 94.25; // 2 * PI * 15
const LEVEL_CLASSES: LevelClass[] = ["ok", "warn", "orange", "danger"];
const DOT_CLASSES = ["ok", "warn", "orange", "danger", "blue", "gray"];

let latest: UsageSnapshot | null = null;

// ---------- helpers ----------

function getLevelClass(pct: number): LevelClass {
  if (pct >= 95) return "danger";
  if (pct >= 80) return "orange";
  if (pct >= 50) return "warn";
  return "ok";
}

function getStatusInfo(indicator: string): { cls: string; text: string } {
  switch (indicator) {
    case "none":
      return { cls: "ok", text: "Operational" };
    case "minor":
      return { cls: "warn", text: "Degraded" };
    case "major":
      return { cls: "orange", text: "Major outage" };
    case "critical":
      return { cls: "danger", text: "Critical" };
    case "maintenance":
      return { cls: "blue", text: "Maintenance" };
    default:
      return { cls: "gray", text: "Unknown" };
  }
}

function formatCountdown(targetIso: string): string {
  const target = new Date(targetIso).getTime();
  let diff = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const d = Math.floor(diff / 86400);
  diff -= d * 86400;
  const h = Math.floor(diff / 3600);
  diff -= h * 3600;
  const m = Math.floor(diff / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `resets ${hh}:${mm}`;
  // No es hoy (típico del weekly): añade el día de la semana.
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `resets ${day} ${hh}:${mm}`;
}

function formatAgo(iso: string): string {
  const totalSecs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (totalSecs < 60) return `updated ${totalSecs}s ago`;
  const mins = Math.floor(totalSecs / 60);
  return `updated ${mins}m ${totalSecs - mins * 60}s ago`;
}

function setDotClass(el: HTMLElement, cls: string) {
  el.classList.remove(...DOT_CLASSES);
  el.classList.add(cls);
}

// ---------- render: usage (pill rings + widget bars) ----------

function renderUsage(snap: UsageSnapshot) {
  latest = snap;

  const sLevel = getLevelClass(snap.session_5h_pct);
  const wLevel = getLevelClass(snap.weekly_pct);

  // pill rings
  els.progressSession.setAttribute("class", `progress ${sLevel}`);
  els.progressWeekly.setAttribute("class", `progress ${wLevel}`);
  els.progressSession.setAttribute(
    "stroke-dashoffset",
    String(CIRCUMFERENCE - (Math.min(100, snap.session_5h_pct) / 100) * CIRCUMFERENCE),
  );
  els.progressWeekly.setAttribute(
    "stroke-dashoffset",
    String(CIRCUMFERENCE - (Math.min(100, snap.weekly_pct) / 100) * CIRCUMFERENCE),
  );
  els.labelSession.textContent = `${Math.round(snap.session_5h_pct)}%`;
  els.labelWeekly.textContent = `${Math.round(snap.weekly_pct)}%`;
  els.labelSession.className = `label ${sLevel}`;
  els.labelWeekly.className = `label ${wLevel}`;
  els.ringSession.setAttribute(
    "data-tooltip",
    `Session — resets in ${formatCountdown(snap.session_5h_reset_at)}`,
  );
  els.ringWeekly.setAttribute(
    "data-tooltip",
    `Weekly — resets in ${formatCountdown(snap.weekly_reset_at)}`,
  );

  // widget bars
  applyBar(els.sessionBar, els.sessionPct, snap.session_5h_pct, sLevel);
  applyBar(els.weeklyBar, els.weeklyPct, snap.weekly_pct, wLevel);
  els.sessionCountdown.textContent = formatCountdown(snap.session_5h_reset_at);
  els.sessionReset.textContent = formatLocalTime(snap.session_5h_reset_at);
  els.weeklyCountdown.textContent = formatCountdown(snap.weekly_reset_at);
  els.weeklyReset.textContent = formatLocalTime(snap.weekly_reset_at);

  const sessionDominant = snap.representative_claim === "five_hour";
  const weeklyDominant = snap.representative_claim === "seven_day";
  els.sessionTag.classList.toggle("active", sessionDominant);
  els.sessionTag.textContent = sessionDominant ? "DOMINANT" : "";
  els.weeklyTag.classList.toggle("active", weeklyDominant);
  els.weeklyTag.textContent = weeklyDominant ? "DOMINANT" : "";

  els.updatedAgo.textContent = formatAgo(snap.fetched_at);

  if (state === "expanded") fitShellHeight();
}

function applyBar(
  barEl: HTMLElement,
  valueEl: HTMLElement,
  pct: number,
  level: LevelClass,
) {
  for (const c of LEVEL_CLASSES) {
    barEl.classList.remove(c);
    valueEl.classList.remove(c);
  }
  barEl.classList.add(level);
  valueEl.classList.add(level);
  barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  valueEl.textContent = `${Math.round(pct)}%`;
}

// ---------- render: service status (pill dot + widget indicator) ----------

function renderStatus(snap: StatusSnapshot) {
  const info = getStatusInfo(snap.indicator);
  setDotClass(els.pillDot, info.cls);
  els.pillDot.setAttribute("data-tooltip", snap.description || info.text);
  setDotClass(els.statusDot, info.cls);
  els.statusText.textContent = info.text;
  els.statusIndicator.setAttribute("data-tooltip", snap.description || info.text);
}

function renderError(message: string) {
  els.updatedAgo.textContent = message;
}

// ---------- morph: collapsed (pill) <-> expanded (widget) ----------

type ShellState = "collapsed" | "expanded";
let state: ShellState = "collapsed";

const BODY_PADDING = 18; // coincide con `body { padding }` en styles.css — sombra
// Margen transparente extra: en estado colapsado los tooltips de la pill se
// despliegan hacia los lados / abajo y no deben recortarse contra el borde de
// la ventana.
const COLLAPSED_TOOLTIP_SIDE = 80;
const COLLAPSED_TOOLTIP_BELOW = 32;

// El ANCHO de la ventana es constante (el del estado más ancho). Así el morph
// pill<->widget nunca redimensiona en X: el shell, centrado por flexbox en una
// ventana de ancho fijo, mantiene su centro horizontal sin reposicionar la
// ventana. Reposicionar en X durante el resize (set_size + set_position no son
// atómicos) causaba un flick de ~15px al terminar de colapsar.
let windowWidth = 0;
function computeWindowWidth() {
  const widgetW = els.widgetContent.offsetWidth + BODY_PADDING * 2;
  const pillW =
    els.pillContent.offsetWidth + BODY_PADDING * 2 + COLLAPSED_TOOLTIP_SIDE * 2;
  windowWidth = Math.max(widgetW, pillW);
}

function activeContent() {
  return state === "collapsed" ? els.pillContent : els.widgetContent;
}

function applyShellSize() {
  const el = activeContent();
  els.shell.style.width = `${el.offsetWidth}px`;
  els.shell.style.height = `${el.offsetHeight}px`;
}

// La ventana del SO sigue al ALTO del contenido (el ancho es constante, ver
// `windowWidth`). Anclada arriba: crece hacia abajo. En estado colapsado lleva
// margen extra por debajo para los tooltips de la pill.
function resizeWindowToContent() {
  const el = activeContent();
  let height = el.offsetHeight + BODY_PADDING * 2;
  if (state === "collapsed") height += COLLAPSED_TOOLTIP_BELOW;
  return invoke("resize_shell_window", { width: windowWidth, height }).catch(
    (e) => console.error("resize_shell_window failed:", e),
  );
}

// Reajusta el alto al contenido del widget (p. ej. al aparecer el banner).
function fitShellHeight() {
  const h = `${els.widgetContent.offsetHeight}px`;
  if (els.shell.style.height !== h) {
    els.shell.classList.remove("settled");
    els.shell.style.height = h;
  }
}

async function expand() {
  if (state === "expanded") return;
  state = "expanded";
  els.shell.classList.remove("settled");
  // 1. agrandar la ventana primero (instantáneo; el espacio extra es
  //    transparente, así que no se ve el salto).
  await resizeWindowToContent();
  // 2. morph CSS dentro de la ventana ya grande.
  els.shell.classList.remove("collapsed");
  els.shell.classList.add("expanded");
  applyShellSize();
}

function collapse() {
  if (state === "collapsed") return;
  state = "collapsed";
  // 1. morph CSS primero (la ventana sigue grande mientras el shell encoge).
  els.shell.classList.remove("settled", "expanded");
  els.shell.classList.add("collapsed");
  applyShellSize();
  // 2. la ventana se encoge al terminar la transición (ver transitionend).
}

// Reset instantáneo a colapsado, al abrir desde el tray.
function resetCollapsed() {
  // Al reabrir, la ventana vuelve a ser interactiva; el siguiente mousemove
  // reevalúa si el cursor está sobre un margen.
  void setCursorIgnored(false);
  state = "collapsed";
  els.shell.style.transition = "none";
  els.shell.classList.remove("expanded", "settled");
  els.shell.classList.add("collapsed");
  applyShellSize();
  void els.shell.offsetWidth;
  els.shell.style.transition = "";
  els.shell.classList.add("settled");
  resizeWindowToContent();
}

let pendingResize = false;
els.shell.addEventListener("transitionend", (e) => {
  if (
    e.target === els.shell &&
    (e.propertyName === "width" || e.propertyName === "height")
  ) {
    els.shell.classList.add("settled");
    // width y height terminan en el mismo frame → el handler se dispara dos
    // veces. Coalescer en un único resize: dos `invoke` en paralelo hacen que
    // el 2º lea un tamaño de ventana a medio aplicar y reposicione de más,
    // produciendo un flick horizontal al terminar de colapsar.
    if (pendingResize) return;
    pendingResize = true;
    requestAnimationFrame(() => {
      pendingResize = false;
      // expand: la ventana ya tiene el tamaño correcto (no-op).
      // collapse / banner: la ventana se ajusta al nuevo tamaño del shell.
      resizeWindowToContent();
    });
  }
});

// ---------- Claude Code activity (eje separado: borde + console banner) ----------

let workingTimeout: number | null = null;
let activeTimeout: number | null = null;

// Ajustes vivos: la ventana de Settings los cambia y emite `settings-changed`.
// Gobiernan los dos efectos visuales de actividad de Claude Code.
let orangeBorderEnabled = true;
let consoleBannerEnabled = true;

function applySettings(s: any) {
  orangeBorderEnabled = s?.orange_border ?? true;
  consoleBannerEnabled = s?.console_banner ?? true;
  // Aplica el cambio al instante, sin esperar al siguiente evento de Claude.
  if (!orangeBorderEnabled) {
    document.body.classList.remove("cc-active", "cc-working", "cc-awaiting");
  }
  if (!consoleBannerEnabled) {
    $("console-banner").style.display = "none";
    if (state === "expanded") fitShellHeight();
  }
}

function setClaudeState(s: "idle" | "cc-active" | "cc-working" | "cc-awaiting") {
  document.body.classList.remove("cc-active", "cc-working", "cc-awaiting");
  if (!orangeBorderEnabled) return;
  if (s !== "idle") document.body.classList.add(s);
}

function flashRings() {
  document.querySelectorAll(".ring").forEach((r) => {
    r.classList.add("flash");
    setTimeout(() => r.classList.remove("flash"), 1000);
  });
}

function updateConsoleBanner(bannerState: string, evt: any) {
  const banner = $("console-banner");

  if (!consoleBannerEnabled) {
    banner.style.display = "none";
    if (state === "expanded") fitShellHeight();
    return;
  }

  if (bannerState === "hidden") {
    banner.style.display = "none";
  } else {
    banner.style.display = "flex";
    banner.className = `console-banner ${bannerState}`;
    const text = banner.querySelector(".banner-text")!;
    const projectName = evt.cwd ? evt.cwd.split(/[/\\]/).pop() : "session";
    switch (bannerState) {
      case "active":
        text.innerHTML = `claude active &mdash; ${projectName}`;
        break;
      case "working": {
        const tool = evt.tool_name || "tool";
        const target = evt.tool_target ? `&mdash;${evt.tool_target}` : "";
        text.innerHTML = `running ${tool}${target}<span class="console-cursor"></span>`;
        break;
      }
      case "awaiting": {
        const msg = evt.message || "awaiting input";
        text.innerHTML = `${msg}<span class="console-cursor"></span>`;
        break;
      }
      case "finished":
        text.innerHTML = `response complete &mdash; ${projectName}`;
        break;
    }
  }

  // El banner cambió el alto del widget: si está expandido, reajusta el shell.
  if (state === "expanded") fitShellHeight();
}

function handleClaudeEvent(evt: any) {
  switch (evt.event_type) {
    case "SessionStart":
    case "UserPromptSubmit":
      setClaudeState("cc-active");
      updateConsoleBanner("active", evt);
      break;
    case "PreToolUse":
      setClaudeState("cc-working");
      updateConsoleBanner("working", evt);
      break;
    case "PostToolUse":
      if (workingTimeout) clearTimeout(workingTimeout);
      workingTimeout = window.setTimeout(() => {
        setClaudeState("cc-active");
        updateConsoleBanner("active", evt);
      }, 500);
      break;
    case "Notification":
      setClaudeState("cc-awaiting");
      updateConsoleBanner("awaiting", evt);
      break;
    case "Stop":
    case "SubagentStop":
      updateConsoleBanner("finished", evt);
      flashRings();
      if (activeTimeout) clearTimeout(activeTimeout);
      activeTimeout = window.setTimeout(() => {
        setClaudeState("idle");
        updateConsoleBanner("hidden", evt);
      }, 4000);
      break;
  }
}

// ---------- events ----------

listen<UsageSnapshot>("usage-updated", (e) => renderUsage(e.payload));
listen<StatusSnapshot>("status-updated", (e) => renderStatus(e.payload));
listen<string>("usage-error", (e) => renderError(e.payload));
listen("claude-event", (e) => handleClaudeEvent(e.payload));
listen("window-shown", () => resetCollapsed());
listen("settings-changed", (e) => applySettings(e.payload));

// tick: updated-ago + countdowns en vivo
setInterval(() => {
  if (!latest) return;
  els.updatedAgo.textContent = formatAgo(latest.fetched_at);
  els.sessionCountdown.textContent = formatCountdown(latest.session_5h_reset_at);
  els.weeklyCountdown.textContent = formatCountdown(latest.weekly_reset_at);
}, 1000);

// ---------- click-through en los márgenes transparentes ----------
// La ventana es más ancha que la pill: hace falta sitio para los tooltips de
// la pill y para que el ancho sea constante (sin flick al morfear). Esos
// márgenes son transparentes pero por defecto capturan el click. Cuando el
// cursor está sobre un margen, la ventana ignora eventos de ratón y el click
// pasa a la app que haya detrás. Al ignorarlos el webview deja de recibir
// `mousemove`, así que la reentrada sobre el shell se detecta sondeando la
// posición global del cursor (comando `cursor_position`).

// Factor de escala del monitor (constante); se cachea en bootstrap.
let windowScale = 1;
let cursorIgnored = false;
let reentryPoll: number | null = null;
// Posición de la ventana (px físicos) capturada al empezar a ignorar. Mientras
// se ignora la ventana no se mueve (arrastrarla requiere clicar el shell, que
// entonces no es accesible). El RECT del shell sí puede cambiar de alto si
// llega el console banner, así que se relee del DOM en cada tick del poll.
let ignoredWinPos: { x: number; y: number } | null = null;

async function setCursorIgnored(ignore: boolean) {
  if (ignore === cursorIgnored) return;
  cursorIgnored = ignore;
  try {
    if (ignore) {
      ignoredWinPos = await appWindow.outerPosition();
      await appWindow.setIgnoreCursorEvents(true);
      startReentryPoll();
    } else {
      stopReentryPoll();
      ignoredWinPos = null;
      await appWindow.setIgnoreCursorEvents(false);
    }
  } catch (e) {
    console.error("setIgnoreCursorEvents failed:", e);
    cursorIgnored = false;
  }
}

function startReentryPoll() {
  if (reentryPoll !== null) return;
  reentryPoll = window.setInterval(async () => {
    if (!ignoredWinPos) {
      void setCursorIgnored(false);
      return;
    }
    try {
      const [cx, cy] = await invoke<[number, number]>("cursor_position");
      // Rect del shell en px físicos de pantalla, recalculado cada tick.
      const r = els.shell.getBoundingClientRect();
      const left = ignoredWinPos.x + r.left * windowScale;
      const top = ignoredWinPos.y + r.top * windowScale;
      const right = ignoredWinPos.x + r.right * windowScale;
      const bottom = ignoredWinPos.y + r.bottom * windowScale;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        void setCursorIgnored(false);
      }
    } catch {
      // Si no se puede leer el cursor, no dejar la ventana inservible.
      void setCursorIgnored(false);
    }
  }, 90);
}

function stopReentryPoll() {
  if (reentryPoll !== null) {
    clearInterval(reentryPoll);
    reentryPoll = null;
  }
}

// Mientras la ventana NO ignora eventos, cada mousemove decide: si el cursor
// está sobre un margen transparente (target fuera del shell) se pasa a modo
// click-through.
window.addEventListener("mousemove", (e) => {
  if (cursorIgnored) return;
  if (!els.shell.contains(e.target as Node)) {
    void setCursorIgnored(true);
  }
});

// ---------- interactions ----------

// Drag vs click: startDragging() captura el ratón y se "come" el click, así
// que NO se llama en mousedown. Solo cuando el ratón se mueve más de un umbral
// se inicia el arrastre; un click puro (sin movimiento) llega como click
// normal y dispara expand/collapse.
let downPos: { x: number; y: number } | null = null;
let dragged = false;
const DRAG_THRESHOLD = 4;

els.shell.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("a, button, input")) return;
  downPos = { x: e.screenX, y: e.screenY };
  dragged = false;
});

window.addEventListener("mousemove", (e) => {
  if (!downPos) return;
  if (
    Math.abs(e.screenX - downPos.x) > DRAG_THRESHOLD ||
    Math.abs(e.screenY - downPos.y) > DRAG_THRESHOLD
  ) {
    downPos = null;
    dragged = true;
    appWindow.startDragging().catch(() => {});
  }
});

window.addEventListener("mouseup", () => {
  downPos = null;
});

els.pillContent.addEventListener("click", () => {
  if (dragged) {
    dragged = false;
    return;
  }
  if (state === "collapsed") expand();
});

els.btnClose.addEventListener("click", (e) => {
  e.preventDefault();
  collapse();
});

els.btnRefresh.addEventListener("click", (e) => {
  e.preventDefault();
  els.btnRefresh.classList.remove("spinning");
  void els.btnRefresh.offsetWidth; // reinicia la animación
  els.btnRefresh.classList.add("spinning");
  invoke("force_refresh").catch((err) =>
    console.error("force_refresh failed:", err),
  );
});

els.viewDetails.addEventListener("click", (e) => {
  e.preventDefault();
  openUrl("https://claude.ai/settings/usage").catch((err) =>
    console.error("openUrl failed:", err),
  );
});

// ---------- bootstrap ----------

async function bootstrap() {
  windowScale = await appWindow.scaleFactor();
  // tamaño inicial del shell + ventana, sin animación
  computeWindowWidth();
  els.shell.style.transition = "none";
  applyShellSize();
  void els.shell.offsetWidth;
  els.shell.style.transition = "";
  els.shell.classList.add("settled");
  await resizeWindowToContent();

  try {
    applySettings(await invoke("get_settings"));
  } catch (e) {
    console.error("get_settings failed", e);
  }

  try {
    const usage = await invoke<UsageSnapshot | null>("get_current_usage");
    if (usage) renderUsage(usage);
  } catch (e) {
    renderError(String(e));
  }
  try {
    const status = await invoke<StatusSnapshot | null>("get_current_status");
    if (status) renderStatus(status);
  } catch (e) {
    console.error("status fetch failed", e);
  }
}

bootstrap();
