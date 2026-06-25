import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CLAUDE_ICON, CODEX_ICON } from "./icons";

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
  plan: string;
}

interface CodexUsageSnapshot {
  session_5h_pct: number;
  session_5h_reset_at: string | null;
  weekly_pct: number;
  weekly_reset_at: string | null;
  fetched_at: string;
  plan_type: string | null;
}

// Forma normalizada común a ambos proveedores, para renderizar genéricamente.
interface ProviderSnapshot {
  sessionPct: number;
  sessionResetAt: string | null;
  weeklyPct: number;
  weeklyResetAt: string | null;
  fetchedAt: string;
  plan: string | null;
  /** Ventana que el servidor marca como dominante (solo Claude la reporta). */
  dominant: "session" | "weekly" | null;
}

type ProviderId = "claude" | "codex";

interface ProviderDef {
  id: ProviderId;
  name: string;
  icon: string;
  detailsUrl: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    name: "Claude",
    icon: CLAUDE_ICON,
    detailsUrl: "https://claude.ai/settings/usage",
  },
  {
    id: "codex",
    name: "Codex",
    icon: CODEX_ICON,
    detailsUrl: "https://chatgpt.com/codex/cloud/settings/analytics",
  },
];

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
  pillProviders: $("pill-providers"),
  // widget
  providers: $("providers"),
  statusIndicator: $("status-indicator"),
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  updatedAgo: $("updated-ago"),
  btnClose: $("btn-close"),
  btnRefresh: $("btn-refresh"),
  pillNotif: $("pill-notif"),
};

// Doble ring concéntrico de la pill: arco exterior (5h, r=16) e interior
// (semanal, r=11). Cada uno con su circunferencia para el dashoffset.
const OUTER_CIRC = 100.531; // 2 * PI * 16
const INNER_CIRC = 69.115; // 2 * PI * 11
const LEVEL_CLASSES: LevelClass[] = ["ok", "warn", "orange", "danger"];
const DOT_CLASSES = ["ok", "warn", "orange", "danger", "blue", "gray"];

// Último snapshot normalizado por proveedor (null = sin datos / inactivo).
const snapshots: Record<ProviderId, ProviderSnapshot | null> = {
  claude: null,
  codex: null,
};


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

// ---------- render: usage (pill rings + widget bars, por proveedor) ----------

function normalizeClaude(snap: UsageSnapshot): ProviderSnapshot {
  let dominant: "session" | "weekly" | null = null;
  if (snap.representative_claim === "five_hour") dominant = "session";
  else if (snap.representative_claim === "seven_day") dominant = "weekly";
  return {
    sessionPct: snap.session_5h_pct,
    sessionResetAt: snap.session_5h_reset_at,
    weeklyPct: snap.weekly_pct,
    weeklyResetAt: snap.weekly_reset_at,
    fetchedAt: snap.fetched_at,
    plan: snap.plan || null,
    dominant,
  };
}

function normalizeCodex(snap: CodexUsageSnapshot): ProviderSnapshot {
  return {
    sessionPct: snap.session_5h_pct,
    sessionResetAt: snap.session_5h_reset_at,
    weeklyPct: snap.weekly_pct,
    weeklyResetAt: snap.weekly_reset_at,
    fetchedAt: snap.fetched_at,
    plan: snap.plan_type,
    dominant: null, // Codex no reporta ventana dominante.
  };
}

function renderUsage(snap: UsageSnapshot) {
  snapshots.claude = normalizeClaude(snap);
  renderAll();
}

function renderCodexUsage(snap: CodexUsageSnapshot) {
  snapshots.codex = normalizeCodex(snap);
  renderAll();
}

// HTML templates (generados una vez por proveedor) -------------------------

function pillGroupHTML(def: ProviderDef): string {
  // Doble ring concéntrico: arco exterior = 5h, interior = semanal. En el
  // centro, % de 5h arriba / separador / % semanal debajo. Badge de marca
  // en la esquina. El detalle (resets) va en el tooltip del grupo.
  return `<div class="pill-provider" data-provider="${def.id}"
    data-tooltip="${def.name} — loading…" data-tooltip-pos="below">
    <div class="dual-ring">
      <svg viewBox="0 0 40 40">
        <circle class="track" cx="20" cy="20" r="16"></circle>
        <circle class="progress" data-progress="session" cx="20" cy="20" r="16"
          stroke-dasharray="${OUTER_CIRC}" stroke-dashoffset="${OUTER_CIRC}"></circle>
        <circle class="track" cx="20" cy="20" r="11"></circle>
        <circle class="progress" data-progress="weekly" cx="20" cy="20" r="11"
          stroke-dasharray="${INNER_CIRC}" stroke-dashoffset="${INNER_CIRC}"></circle>
      </svg>
      <span class="dual-icon">${def.icon}</span>
    </div>
  </div>`;
}

function metricHTML(window: "session" | "weekly", label: string): string {
  return `<section class="metric" data-window="${window}">
    <div class="metric-head">
      <span class="metric-label">${label}<span class="claim-tag" data-tag></span></span>
      <span class="metric-value" data-val>—</span>
    </div>
    <div class="metric-bar"><div class="metric-bar-fill" data-bar></div></div>
    <div class="metric-meta"><span data-cd>—</span><span data-reset>—</span></div>
  </section>`;
}

function widgetBlockHTML(def: ProviderDef): string {
  return `<div class="provider-group" data-provider="${def.id}">
    <div class="provider-head">
      <span class="provider-icon">${def.icon}</span>
      <span class="provider-name">${def.name}</span>
      <span class="provider-plan" data-plan></span>
      <a class="provider-details" data-details href="#">view details</a>
    </div>
    ${metricHTML("session", "Session 5h")}
    ${metricHTML("weekly", "Weekly 7d")}
  </div>`;
}

// Construye los bloques que falten para los proveedores activos y elimina los
// de proveedores que ya no lo están. Devuelve true si el conjunto activo cambió
// (para recalcular el tamaño de ventana).
let activeKey = "";
function ensureBlocks(): boolean {
  const active = PROVIDERS.filter((p) => snapshots[p.id]);
  const key = active.map((p) => p.id).join(",");
  if (key === activeKey) return false;
  activeKey = key;

  // Reconstruye contenedores en orden estable (orden de PROVIDERS).
  els.pillProviders.innerHTML = active.map(pillGroupHTML).join("");
  els.providers.innerHTML = active.map(widgetBlockHTML).join("");
  return true;
}

function renderAll() {
  const setChanged = ensureBlocks();

  for (const def of PROVIDERS) {
    const snap = snapshots[def.id];
    if (!snap) continue;
    renderProviderPill(def, snap);
    renderProviderWidget(def, snap);
  }

  // "updated Xs ago": el fetch más reciente entre los proveedores activos.
  const newest = PROVIDERS.map((p) => snapshots[p.id])
    .filter((s): s is ProviderSnapshot => !!s)
    .map((s) => s.fetchedAt)
    .sort()
    .pop();
  if (newest) els.updatedAgo.textContent = formatAgo(newest);

  if (setChanged) {
    // Cambió el nº de proveedores → cambian anchos/altos: re-medir y
    // redimensionar la ventana (mantiene el invariante de ancho constante).
    computeWindowWidth();
    applyShellSize();
    void resizeWindowToContent();
    // Cambió el conjunto activo → el status combinado puede incluir/excluir
    // ahora a un proveedor.
    renderStatus();
  } else if (state === "expanded") {
    fitShellHeight();
  }
}

function renderProviderPill(def: ProviderDef, snap: ProviderSnapshot) {
  const group = els.pillProviders.querySelector(
    `.pill-provider[data-provider="${def.id}"]`,
  );
  if (!group) return;
  applyArc(group, "session", snap.sessionPct, OUTER_CIRC);
  applyArc(group, "weekly", snap.weeklyPct, INNER_CIRC);
  const sCd = snap.sessionResetAt ? formatCountdown(snap.sessionResetAt) : "—";
  const wCd = snap.weeklyResetAt ? formatCountdown(snap.weeklyResetAt) : "—";
  group.setAttribute(
    "data-tooltip",
    `${def.name} — 5h ${Math.round(snap.sessionPct)}% (${sCd}) · 7d ${Math.round(
      snap.weeklyPct,
    )}% (${wCd})`,
  );
}

// Pinta uno de los dos arcos concéntricos (+ su número central) según su %.
function applyArc(
  group: Element,
  window: "session" | "weekly",
  pct: number,
  circ: number,
) {
  const level = getLevelClass(pct);
  const progress = group.querySelector(
    `.progress[data-progress="${window}"]`,
  ) as SVGCircleElement;
  progress.setAttribute("class", `progress ${level}`);
  progress.setAttribute(
    "stroke-dashoffset",
    String(circ - (Math.min(100, pct) / 100) * circ),
  );
}

function renderProviderWidget(def: ProviderDef, snap: ProviderSnapshot) {
  const block = els.providers.querySelector(
    `.provider-group[data-provider="${def.id}"]`,
  );
  if (!block) return;

  const planEl = block.querySelector("[data-plan]") as HTMLElement;
  planEl.textContent = snap.plan ?? "";

  applyMetric(block, "session", snap.sessionPct, snap.sessionResetAt, snap.dominant === "session");
  applyMetric(block, "weekly", snap.weeklyPct, snap.weeklyResetAt, snap.dominant === "weekly");
}

function applyMetric(
  block: Element,
  window: "session" | "weekly",
  pct: number,
  resetAt: string | null,
  dominant: boolean,
) {
  const sec = block.querySelector(`.metric[data-window="${window}"]`);
  if (!sec) return;
  const level = getLevelClass(pct);
  const bar = sec.querySelector("[data-bar]") as HTMLElement;
  const val = sec.querySelector("[data-val]") as HTMLElement;
  applyBar(bar, val, pct, level);
  (sec.querySelector("[data-cd]") as HTMLElement).textContent = resetAt
    ? formatCountdown(resetAt)
    : "—";
  (sec.querySelector("[data-reset]") as HTMLElement).textContent = resetAt
    ? formatLocalTime(resetAt)
    : "—";
  const tag = sec.querySelector("[data-tag]") as HTMLElement;
  tag.classList.toggle("active", dominant);
  tag.textContent = dominant ? "DOMINANT" : "";
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
// Indicador combinado de Claude + OpenAI. Verde si ambos OK; si alguno falla,
// el color del peor, y el tooltip/texto dice cuál. Solo cuenta los proveedores
// trackeados (los que tienen datos de uso).

const STATUS_PAGE: Record<ProviderId, string> = {
  claude: "https://status.claude.com/",
  codex: "https://status.openai.com/",
};
const STATUS_RANK: Record<string, number> = {
  none: 0,
  maintenance: 1,
  minor: 2,
  major: 3,
  critical: 4,
};

let claudeStatus: StatusSnapshot | null = null;
let codexStatus: StatusSnapshot | null = null;
// Página de status que abre el indicador del widget (la del proveedor con
// problema, o Claude si todo va bien).
let statusTargetUrl = STATUS_PAGE.claude;

function renderStatus() {
  const items: { name: string; provider: ProviderId; snap: StatusSnapshot }[] = [];
  if (snapshots.claude && claudeStatus)
    items.push({ name: "Claude", provider: "claude", snap: claudeStatus });
  if (snapshots.codex && codexStatus)
    items.push({ name: "Codex", provider: "codex", snap: codexStatus });
  // Arranque: aún sin datos de uso pero ya tenemos el status de Claude.
  if (items.length === 0 && claudeStatus)
    items.push({ name: "Claude", provider: "claude", snap: claudeStatus });
  if (items.length === 0) return;

  const rank = (i: string) => STATUS_RANK[i] ?? 2;
  let worst = items[0];
  for (const it of items) if (rank(it.snap.indicator) > rank(worst.snap.indicator)) worst = it;

  const allOk = items.every((it) => it.snap.indicator === "none");
  const worstInfo = getStatusInfo(worst.snap.indicator);
  const cls = allOk ? "ok" : worstInfo.cls;
  setDotClass(els.pillDot, cls);
  setDotClass(els.statusDot, cls);

  // Texto del widget.
  let text: string;
  if (allOk) {
    text = items.length > 1 ? "All operational" : worstInfo.text;
  } else {
    text = items
      .filter((it) => it.snap.indicator !== "none")
      .map((it) => `${it.name}: ${getStatusInfo(it.snap.indicator).text}`)
      .join(" · ");
  }
  els.statusText.textContent = text;

  // Tooltip: descripción por proveedor (con problema), o todo operativo.
  const tip = allOk
    ? items.length > 1
      ? "All systems operational"
      : items[0].snap.description || "Operational"
    : items
        .filter((it) => it.snap.indicator !== "none")
        .map((it) => `${it.name} — ${it.snap.description || getStatusInfo(it.snap.indicator).text}`)
        .join(" · ");
  els.pillDot.setAttribute("data-tooltip", tip);
  els.statusIndicator.setAttribute("data-tooltip", tip);

  // El click del indicador abre la página del proveedor con problema (o Claude).
  statusTargetUrl = STATUS_PAGE[allOk ? items[0].provider : worst.provider];
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
// Espacio (px) que reserva la ventana para el panel de actividad bajo la pill.
// Fijo (no medido en vivo) para que la ventana ya esté alta antes de que el
// panel termine su animación de entrada y no se recorte.
const PILL_NOTIF_SPACE = 26;

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
  if (state === "collapsed") {
    // Con el panel de actividad visible, la ventana reserva su espacio (fijo);
    // si no, el margen para los tooltips de la pill.
    height += els.pillNotif.classList.contains("show")
      ? PILL_NOTIF_SPACE
      : COLLAPSED_TOOLTIP_BELOW;
  }
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
  updatePillNotif(false); // oculta el panel: en widget manda el console banner
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
  updatePillNotif(false); // si hay actividad activa, el panel reaparece
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
  updatePillNotif(false);
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
let dismissTimer: number | null = null;

// Ajustes vivos (los cambia Settings vía `settings-changed`).
let consoleBannerEnabled = true;
let pillActivity = {
  enabled: true,
  claude: true,
  codex: true,
  working: false,
  awaiting: true,
  finished: true,
};
// Segundos hasta auto-ocultar el panel (0 = no se oculta solo).
let pillDismissSecs = 6;

// Estado de actividad actual, para re-pintar al alternar pill <-> widget.
type ActivityState = "idle" | "active" | "working" | "awaiting" | "finished";
let activity: { state: ActivityState; evt: any; provider: "claude" | "codex" } = {
  state: "idle",
  evt: null,
  provider: "claude",
};

function applySettings(s: any) {
  consoleBannerEnabled = s?.console_banner ?? true;
  pillActivity = {
    enabled: s?.pill_activity_enabled ?? true,
    claude: s?.pill_activity_claude ?? true,
    codex: s?.pill_activity_codex ?? true,
    working: s?.pill_activity_working ?? false,
    awaiting: s?.pill_activity_awaiting ?? true,
    finished: s?.pill_activity_finished ?? true,
  };
  pillDismissSecs = s?.pill_activity_dismiss_secs ?? 6;
  if (!consoleBannerEnabled) {
    $("console-banner").style.display = "none";
    if (state === "expanded") fitShellHeight();
  }
  renderActivity();
}

function setActivity(s: ActivityState, evt: any, provider: "claude" | "codex") {
  activity = { state: s, evt, provider };
  renderActivity();
  // Auto-cierre: cada evento reinicia el temporizador; con 0 no se oculta solo.
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (s !== "idle" && pillDismissSecs > 0) {
    dismissTimer = window.setTimeout(
      () => setActivity("idle", evt, provider),
      pillDismissSecs * 1000,
    );
  }
}

// Dos canales de actividad: console banner (widget) y panel deslizante (pill).
// Cada uno solo es visible en su estado del shell.
function renderActivity() {
  updateConsoleBanner(activity.state === "idle" ? "hidden" : activity.state, activity.evt);
  updatePillNotif();
}

function pillStateEnabled(s: ActivityState): boolean {
  if (s === "active" || s === "working") return pillActivity.working;
  if (s === "awaiting") return pillActivity.awaiting;
  if (s === "finished") return pillActivity.finished;
  return false;
}

function activityMessage(s: ActivityState, evt: any, provider: "claude" | "codex"): string {
  const name = provider === "codex" ? "Codex" : "Claude";
  switch (s) {
    case "working": {
      const tool = evt?.tool_name;
      const target = evt?.tool_target;
      if (tool && target) return `${name} · ${tool} ${target}…`;
      if (tool) return `${name} · ${tool}…`;
      return `${name} is working…`;
    }
    case "active":
      return `${name} is working…`;
    case "awaiting":
      return `${name} needs you`;
    case "finished":
      return `${name} finished`;
    default:
      return "";
  }
}

// El panel deslizante solo aplica en estado colapsado (la pill). `doResize`:
// expand/collapse gestionan su propio resize, así que ahí solo se togglea la
// clase sin disparar otro resize.
function updatePillNotif(doResize = true) {
  const notif = els.pillNotif;
  const s = activity.state;
  const providerEnabled =
    activity.provider === "codex" ? pillActivity.codex : pillActivity.claude;
  const show =
    pillActivity.enabled &&
    providerEnabled &&
    state === "collapsed" &&
    s !== "idle" &&
    pillStateEnabled(s);

  if (!show) {
    if (notif.classList.contains("show")) {
      notif.classList.remove("show");
      if (doResize) {
        // Tras la animación de salida, encoger la ventana.
        window.setTimeout(() => {
          if (!notif.classList.contains("show")) void resizeWindowToContent();
        }, 240);
      }
    }
    return;
  }

  (notif.querySelector(".pill-notif-icon") as HTMLElement).innerHTML =
    activity.provider === "codex" ? CODEX_ICON : CLAUDE_ICON;
  (notif.querySelector(".pill-notif-text") as HTMLElement).textContent =
    activityMessage(s, activity.evt, activity.provider);
  notif.className = `pill-notif ${activity.provider} ${s} show`;
  if (doResize) void resizeWindowToContent();
}

function flashRings() {
  document.querySelectorAll(".dual-ring").forEach((r) => {
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
  const provider: "claude" | "codex" = evt.provider === "codex" ? "codex" : "claude";
  switch (evt.event_type) {
    case "SessionStart":
    case "UserPromptSubmit":
      setActivity("active", evt, provider);
      break;
    case "PreToolUse":
      setActivity("working", evt, provider);
      break;
    case "PostToolUse":
      if (workingTimeout) clearTimeout(workingTimeout);
      workingTimeout = window.setTimeout(() => setActivity("active", evt, provider), 500);
      break;
    case "Notification":
      setActivity("awaiting", evt, provider);
      break;
    case "Stop":
    case "SubagentStop":
      setActivity("finished", evt, provider);
      flashRings();
      break;
  }
}

// ---------- events ----------

listen<UsageSnapshot>("usage-updated", (e) => renderUsage(e.payload));
listen<CodexUsageSnapshot>("codex-usage-updated", (e) => renderCodexUsage(e.payload));
listen<StatusSnapshot>("status-updated", (e) => {
  claudeStatus = e.payload;
  renderStatus();
});
listen<StatusSnapshot>("codex-status-updated", (e) => {
  codexStatus = e.payload;
  renderStatus();
});
listen<string>("usage-error", (e) => renderError(e.payload));
listen("claude-event", (e) => handleClaudeEvent(e.payload));
listen("window-shown", () => resetCollapsed());
listen("settings-changed", (e) => applySettings(e.payload));

// tick: updated-ago + countdowns en vivo, para todos los proveedores activos.
setInterval(() => {
  if (!activeKey) return;
  let newest: string | undefined;
  for (const def of PROVIDERS) {
    const snap = snapshots[def.id];
    if (!snap) continue;
    if (!newest || snap.fetchedAt > newest) newest = snap.fetchedAt;
    const widget = els.providers.querySelector(
      `.provider-group[data-provider="${def.id}"]`,
    );
    if (widget) {
      const sCd = widget.querySelector('.metric[data-window="session"] [data-cd]');
      const wCd = widget.querySelector('.metric[data-window="weekly"] [data-cd]');
      if (sCd && snap.sessionResetAt) sCd.textContent = formatCountdown(snap.sessionResetAt);
      if (wCd && snap.weeklyResetAt) wCd.textContent = formatCountdown(snap.weeklyResetAt);
    }
  }
  if (newest) els.updatedAgo.textContent = formatAgo(newest);
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
      const pos = ignoredWinPos;
      // Cursor dentro del rect (px físicos) de un elemento interactivo.
      const inside = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const left = pos.x + r.left * windowScale;
        const top = pos.y + r.top * windowScale;
        const right = pos.x + r.right * windowScale;
        const bottom = pos.y + r.bottom * windowScale;
        return cx >= left && cx <= right && cy >= top && cy <= bottom;
      };
      // El shell y el panel de actividad son interactivos: volver de
      // click-through si el cursor entra en cualquiera de los dos.
      if (inside(els.shell) || inside(els.pillNotif)) {
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
  const t = e.target as Node;
  // El panel de actividad también es interactivo: no activar click-through.
  if (!els.shell.contains(t) && !els.pillNotif.contains(t)) {
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
  if (target?.closest("a, button, input, .status-indicator")) return;
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

// X del panel de actividad: lo descarta (vuelve a idle, oculta y para el timer).
$("pill-notif-close").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setActivity("idle", activity.evt, activity.provider);
});

// El indicador de estado del widget abre la página de status del proveedor con
// problema (o Claude si todo va bien).
els.statusIndicator.addEventListener("click", (e) => {
  e.preventDefault();
  openUrl(statusTargetUrl).catch((err) => console.error("openUrl failed:", err));
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

// "view details" por proveedor (delegado: los bloques se re-crean al cambiar
// el conjunto activo). Cada enlace abre la URL de uso del proveedor.
els.providers.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("[data-details]");
  if (!link) return;
  e.preventDefault();
  const group = link.closest(".provider-group");
  const id = group?.getAttribute("data-provider");
  const def = PROVIDERS.find((p) => p.id === id);
  if (def) {
    openUrl(def.detailsUrl).catch((err) => console.error("openUrl failed:", err));
  }
});

// ---------- bootstrap ----------

async function bootstrap() {
  windowScale = await appWindow.scaleFactor();

  // Cargar ajustes + datos ANTES del primer dimensionado, con la transición
  // desactivada: así los bloques de proveedor se construyen sin que la ventana
  // crezca de forma animada al arrancar.
  els.shell.style.transition = "none";

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
    const codex = await invoke<CodexUsageSnapshot | null>("get_current_codex_usage");
    if (codex) renderCodexUsage(codex);
  } catch (e) {
    console.error("codex usage fetch failed", e);
  }

  // Dimensionado inicial ya con los bloques presentes.
  computeWindowWidth();
  applyShellSize();
  void els.shell.offsetWidth;
  els.shell.style.transition = "";
  els.shell.classList.add("settled");
  await resizeWindowToContent();

  try {
    const status = await invoke<StatusSnapshot | null>("get_current_status");
    if (status) claudeStatus = status;
    const cStatus = await invoke<StatusSnapshot | null>("get_current_codex_status");
    if (cStatus) codexStatus = cStatus;
    renderStatus();
  } catch (e) {
    console.error("status fetch failed", e);
  }
}

bootstrap();
