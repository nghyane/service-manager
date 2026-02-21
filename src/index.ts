import {
  discoverServices,
  runAction,
  createService,
  removeService,
  followLogs as spawnLogProcess,
  type ServiceInfo,
} from "./service.ts";
import chalk from "chalk";
import { truncateToWidth, visibleWidth, padding } from "@oh-my-pi/pi-tui";

// ── Constants ────────────────────────────────────────────────────────

const REFRESH_MS = 3000;
const FLASH_TTL_MS = 3000;
const MAX_LOG_LINES = 250;
const PAD_X = 2;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Terminal primitives ──────────────────────────────────────────────

const out = process.stdout;

function write(s: string) { out.write(s); }

const term = {
  enterAlt()   { write("\x1b[?1049h"); },
  leaveAlt()   { write("\x1b[?1049l"); },
  hideCursor() { write("\x1b[?25l"); },
  showCursor() { write("\x1b[?25h"); },
};

// ── Line-diff screen with Synchronized Output (CSI 2026) ────────────

let prevFrame: string[] = [];

function flush(lines: string[]) {
  let content = "";
  const max = Math.max(lines.length, prevFrame.length);
  for (let i = 0; i < max; i++) {
    if (i >= lines.length) {
      content += `\x1b[${i + 1};1H\x1b[2K`;
    } else if (lines[i] !== prevFrame[i]) {
      content += `\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
    }
  }
  if (content) write(`\x1b[?2026h${content}\x1b[?2026l`);
  prevFrame = lines;
}

// ── Layout helpers ───────────────────────────────────────────────────

function fit(s: string, w: number) {
  if (w <= 0) return "";
  return truncateToWidth(s, w) + padding(Math.max(0, w - visibleWidth(truncateToWidth(s, w))));
}

function row(content: string, w: number) {
  const pad = padding(PAD_X);
  const line = pad + content;
  const vw = visibleWidth(line);
  if (vw >= w) return truncateToWidth(line, w);
  return line + padding(w - vw);
}

function barLine(content: string, w: number) {
  const line = ` ${content}`;
  const vw = visibleWidth(line);
  const padded = vw >= w ? truncateToWidth(line, w) : line + padding(w - vw);
  return chalk.inverse(padded);
}

function highlightRow(content: string, w: number) {
  return row(chalk.bold(content), w);
}

function emptyRow(w: number) {
  return padding(w);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function visRange(total: number, sel: number, win: number) {
  if (total <= win) return { start: 0, end: total };
  const half = Math.floor(win / 2);
  const start = clamp(sel - half, 0, Math.max(0, total - win));
  return { start, end: Math.min(total, start + win) };
}

function svcEq(a: ServiceInfo[], b: ServiceInfo[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.name !== y.name || x.active !== y.active || x.status !== y.status || x.enabled !== y.enabled) return false;
  }
  return true;
}

function getFiltered(): ServiceInfo[] {
  if (!searchQuery) return services;
  const q = searchQuery.toLowerCase();
  return services.filter(s => s.name.toLowerCase().includes(q));
}

function startSpinner() {
  spinnerFrame = 0;
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = setInterval(() => { spinnerFrame = (spinnerFrame + 1) % SPINNER.length; paint(); }, 80);
}

function stopSpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
}

// ── State ────────────────────────────────────────────────────────────

type Tone = "success" | "error" | "info";
type Mode = "dashboard" | "add" | "logs";

let services: ServiceInfo[] = [];
let sel = 0;
let mode: Mode = "dashboard";
let busy = false;
let flash: { tone: Tone; text: string } | null = null;
let flashTimer: Timer | null = null;
let addForm = { name: "", command: "", field: 0 as 0 | 1 };
let logSvc: string | null = null;
let logLines: string[] = [];
let logProc: ReturnType<typeof Bun.spawn> | null = null;
let logScroll = 0;
let refreshing = false;
let spinnerFrame = 0;
let spinnerTimer: Timer | null = null;
let searchQuery = "";
let searching = false;
let confirmRemove: string | null = null;

// ── Flash ────────────────────────────────────────────────────────────

function setFlash(tone: Tone, text: string) {
  if (flashTimer) clearTimeout(flashTimer);
  flash = { tone, text };
  flashTimer = setTimeout(() => { flash = null; flashTimer = null; paint(); }, FLASH_TTL_MS);
  paint();
}

// ── Services ─────────────────────────────────────────────────────────

async function refresh(silent: boolean) {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await discoverServices();
    const changed = !svcEq(services, next);
    if (changed) services = next;
    sel = clamp(sel, 0, Math.max(0, services.length - 1));
    if (changed) paint();
    if (!silent && next.length === 0) setFlash("info", "No services discovered");
  } catch (e) {
    setFlash("error", `Refresh failed: ${e}`);
  } finally {
    refreshing = false;
  }
}

async function doAction(
  action: "start" | "stop" | "restart",
  name: string,
  msg: string,
) {
  busy = true;
  startSpinner();
  paint();
  try {
    const r = await runAction(action, name);
    if (r.ok) {
      services = services.map((s) => {
        if (s.name !== name) return s;
        if (action === "start") return { ...s, active: true, status: "running" };
        if (action === "stop") return { ...s, active: false, status: "stopped" };
        if (action === "restart") return { ...s, active: true, status: "running" };
        return s;
      });
      setFlash("success", `✓ ${msg}`);
    } else {
      setFlash("error", `✗ ${r.output || `${action} failed`}`);
    }
  } catch (e) {
    setFlash("error", `✗ ${action} failed: ${e}`);
  } finally {
    busy = false;
    stopSpinner();
    setTimeout(() => void refresh(true), 500);
  }
}

// ── Remove ───────────────────────────────────────────────────────────

async function doRemove(name: string) {
  busy = true;
  startSpinner();
  paint();
  try {
    const r = await removeService(name);
    if (r.ok) {
      services = services.filter(s => s.name !== name);
      sel = clamp(sel, 0, Math.max(0, services.length - 1));
      setFlash("success", `✓ Removed ${name}`);
    } else {
      setFlash("error", `✗ ${r.output || "remove failed"}`);
    }
  } catch (e) {
    setFlash("error", `✗ Remove failed: ${e}`);
  } finally {
    busy = false;
    stopSpinner();
    setTimeout(() => void refresh(true), 500);
  }
}

// ── Add form ─────────────────────────────────────────────────────────

async function submitAdd() {
  const n = addForm.name.trim();
  const c = addForm.command.trim();
  if (!n || !c) { setFlash("error", "Name and command required"); return; }
  busy = true;
  startSpinner();
  paint();
  try {
    const r = await createService({ name: n, command: c, cwd: process.cwd() });
    if (r.ok) {
      setFlash("success", `✓ Created ${n} → ${r.output}`);
      mode = "dashboard";
      addForm = { name: "", command: "", field: 0 };
      await refresh(true);
    } else {
      setFlash("error", `✗ ${r.output}`);
    }
  } catch (e) {
    setFlash("error", `✗ Create failed: ${e}`);
  } finally {
    busy = false;
    stopSpinner();
  }
}

// ── Log streaming ────────────────────────────────────────────────────

function stopLogs(goDash: boolean) {
  if (logProc) { try { logProc.kill(); } catch {} logProc = null; }
  if (goDash) { mode = "dashboard"; logSvc = null; paint(); }
}

function startLogs(name: string) {
  stopLogs(false);
  logLines = [];
  logSvc = name;
  mode = "logs";
  paint();

  const proc = spawnLogProcess(name);
  logProc = proc;

  async function drain(stream: ReadableStream<Uint8Array>, pfx: string) {
    const rdr = stream.getReader();
    const dec = new TextDecoder();
    let partial = "";
    try {
      while (true) {
        const { done, value } = await rdr.read();
        if (done) break;
        partial += dec.decode(value, { stream: true });
        const parts = partial.split("\n");
        partial = parts.pop()!;
        for (const ln of parts) {
          logLines.push(pfx + (ln || " "));
          if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
        }
        if (parts.length) paint();
      }
      if (partial) { logLines.push(pfx + partial); paint(); }
    } catch {}
  }

  void drain(proc.stdout, "");
  void drain(proc.stderr, chalk.red("[err] "));

  void (async () => {
    const code = await proc.exited;
    if (logProc === proc) {
      logProc = null;
      logLines.push(chalk.dim(`[exited: ${code}]`));
      paint();
      if (code !== 0) setFlash("error", `${name} logs exited ${code}`);
    }
  })();
}

// ── Render: Status line ──────────────────────────────────────────────

function renderStatus(w: number): string {
  if (flash) {
    const fn = flash.tone === "success" ? chalk.green : flash.tone === "error" ? chalk.red : chalk.cyan;
    return row(fn(flash.text), w);
  }
  if (busy) return row(chalk.cyan(`${SPINNER[spinnerFrame % SPINNER.length]} Working...`), w);
  return emptyRow(w);
}

// ── Render: Footer hints ─────────────────────────────────────────────

function hintBar(hints: [string, string][], w: number): string {
  const parts = hints.map(([key, desc]) => `${chalk.bold(key)} ${chalk.dim(desc)}`);
  return row(parts.join(chalk.dim("  ·  ")), w);
}

// ── Render: Dashboard ────────────────────────────────────────────────

function paintDashboard(w: number, h: number): string[] {
  const lines: string[] = [];
  const filtered = getFiltered();
  sel = clamp(sel, 0, Math.max(0, filtered.length - 1));

  const running = services.filter(s => s.active).length;
  const total = services.length;
  const fixed = 5; // header + search/blank + col header + status + footer
  const maxRows = Math.max(1, h - fixed);
  const { start, end } = visRange(filtered.length, sel, maxRows);
  const vis = filtered.slice(start, end);
  const cw = w - PAD_X * 2;
  const ew = 10; // enabled column
  const sw = Math.min(30, Math.max(12, Math.floor(cw * 0.28)));
  const nw = Math.max(8, cw - sw - ew - 4);

  // Header with summary
  const summary = total > 0
    ? `${chalk.dim(`${total} services ·`)} ${chalk.green(`${running} running`)} ${chalk.dim("·")} ${chalk.red(`${total - running} stopped`)}`
    : chalk.dim("no services");
  lines.push(row(`${chalk.bold("lazyctl")}  ${chalk.dim(process.platform)}  ${summary}`, w));

  // Search bar or blank
  if (searching || searchQuery) {
    const cursor = searching ? chalk.inverse(" ") : "";
    const matchInfo = searchQuery ? chalk.dim(` (${filtered.length} matches)`) : "";
    lines.push(row(`${chalk.yellow("/")} ${searchQuery}${cursor}${matchInfo}`, w));
  } else {
    lines.push(emptyRow(w));
  }

  // Column headers
  lines.push(row(
    `  ${chalk.dim("●")} ${chalk.dim(fit("NAME", nw))} ${chalk.dim(fit("STATUS", sw))} ${chalk.dim(fit("ENABLED", ew))}`,
    w,
  ));

  // Service rows
  if (!vis.length) {
    const msg = searchQuery
      ? chalk.dim("  No matches. Press ") + chalk.bold("Esc") + chalk.dim(" to clear search.")
      : chalk.dim("  No services found. Press ") + chalk.bold("a") + chalk.dim(" to add one.");
    lines.push(row(msg, w));
  } else {
    for (let i = 0; i < vis.length; i++) {
      const s = vis[i]!;
      const idx = start + i;
      const isSel = idx === sel;
      const dot = s.active ? chalk.green("●") : chalk.red("●");
      const name = chalk.cyan(fit(s.name, nw));
      const status = (s.active ? chalk.green : chalk.red)(fit(s.status, sw));
      const enabled = s.enabled === undefined ? chalk.dim(fit("—", ew))
        : s.enabled ? chalk.green(fit("yes", ew)) : chalk.dim(fit("no", ew));
      const pointer = isSel ? chalk.yellow("❯") : " ";
      const content = `${pointer} ${dot} ${name} ${status} ${enabled}`;

      lines.push(isSel ? highlightRow(content, w) : row(content, w));
    }
  }

  // Fill empty space
  while (lines.length < h - 2) lines.push(emptyRow(w));

  // Status
  lines.push(renderStatus(w));

  // Context-aware footer
  const svc = filtered[sel];
  const toggleLabel = svc?.active ? "stop" : "start";
  lines.push(hintBar([
    ["↑↓", "move"], ["s", toggleLabel], ["r", "restart"],
    ["l", "logs"], ["a", "add"], ["d", "remove"], ["/", "search"], ["esc", "quit"],
  ], w));

  return lines;
}

// ── Render: Add form ─────────────────────────────────────────────────

function paintAdd(w: number, h: number): string[] {
  const lines: string[] = [];

  // Header
  lines.push(row(`${chalk.bold("Add Service")}`, w));
  lines.push(emptyRow(w));

  // Center form vertically
  const formLines = 5;
  const contentArea = h - 4;
  const padTop = Math.max(0, Math.floor((contentArea - formLines) / 2));
  for (let i = 0; i < padTop; i++) lines.push(emptyRow(w));

  // Form fields
  const label1 = chalk.dim("Name    ");
  const label2 = chalk.dim("Command ");
  const cur = chalk.inverse(" ");
  const val1 = addForm.field === 0
    ? (addForm.name + cur)
    : (addForm.name || chalk.dim.italic("com.user.my-app"));
  const val2 = addForm.field === 1
    ? (addForm.command + cur)
    : (addForm.command || chalk.dim.italic("/usr/local/bin/myapp --port 3000"));

  const field1 = `${chalk.yellow("❯")} ${label1} ${val1}`;
  const field2 = `${chalk.yellow("❯")} ${label2} ${val2}`;
  const inact1 = `  ${label1} ${val1}`;
  const inact2 = `  ${label2} ${val2}`;

  lines.push(addForm.field === 0 ? highlightRow(field1, w) : row(inact1, w));
  lines.push(addForm.field === 1 ? highlightRow(field2, w) : row(inact2, w));

  // CWD info
  lines.push(emptyRow(w));
  lines.push(row(chalk.dim(`  CWD     ${process.cwd()}`), w));
  lines.push(emptyRow(w));

  // Fill
  while (lines.length < h - 2) lines.push(emptyRow(w));

  // Status
  lines.push(renderStatus(w));

  // Footer
  lines.push(hintBar([
    ["enter", "save"], ["tab", "switch"], ["esc", "cancel"],
  ], w));

  return lines;
}

// ── Render: Logs ─────────────────────────────────────────────────────

function paintLogs(w: number, h: number): string[] {
  const lines: string[] = [];

  // Header with scroll indicator
  const scrollInfo = logScroll > 0 ? chalk.yellow(` ↑${logScroll}`) : chalk.dim(" (live)");
  lines.push(row(`${chalk.bold("Logs")}  ${chalk.cyan(logSvc ?? "")}${scrollInfo}`, w));
  lines.push(emptyRow(w));

  // Log content with scroll
  const maxRows = Math.max(1, h - 4);
  const total = logLines.length;
  logScroll = clamp(logScroll, 0, Math.max(0, total - maxRows));
  if (!total) {
    lines.push(row(chalk.dim("Waiting for output..."), w));
  } else {
    const endIdx = Math.max(0, total - logScroll);
    const startIdx = Math.max(0, endIdx - maxRows);
    const logs = logLines.slice(startIdx, endIdx);
    for (const ln of logs) lines.push(row(ln, w));
  }

  // Fill
  while (lines.length < h - 2) lines.push(emptyRow(w));

  // Status
  lines.push(renderStatus(w));

  // Footer
  lines.push(hintBar([["↑↓", "scroll"], ["esc", "back"]], w));

  return lines;
}

// ── Paint ────────────────────────────────────────────────────────────

function paint() {
  const w = Math.max(2, out.columns ?? 80);
  const h = Math.max(3, out.rows ?? 24);

  let lines: string[];
  if (mode === "dashboard") lines = paintDashboard(w, h);
  else if (mode === "add") lines = paintAdd(w, h);
  else lines = paintLogs(w, h);

  flush(lines.slice(0, h));
}

// ── Input ────────────────────────────────────────────────────────────

function onKey(buf: Buffer) {
  const str = buf.toString("utf8");

  if (buf.length === 1 && buf[0] === 0x03) { shutdown(); return; }

  const up    = str === "\x1b[A";
  const down  = str === "\x1b[B";
  const pgUp  = str === "\x1b[5~";
  const pgDn  = str === "\x1b[6~";
  const esc   = buf.length === 1 && buf[0] === 0x1b;
  const enter = buf.length === 1 && buf[0] === 0x0d;
  const back  = buf.length === 1 && (buf[0] === 0x7f || buf[0] === 0x08);
  const tab   = buf.length === 1 && buf[0] === 0x09;
  const ch    = !str.startsWith("\x1b") && str.length > 0 && buf[0]! >= 0x20 ? str : null;

  // ── Logs mode ──
  if (mode === "logs") {
    if (esc) { stopLogs(true); logScroll = 0; setFlash("info", "Returned to dashboard"); return; }
    const pageSize = Math.max(1, (out.rows ?? 24) - 4);
    if (up) { logScroll += 1; paint(); return; }
    if (down) { logScroll = Math.max(0, logScroll - 1); paint(); return; }
    if (pgUp) { logScroll += pageSize; paint(); return; }
    if (pgDn) { logScroll = Math.max(0, logScroll - pageSize); paint(); return; }
    return;
  }

  // ── Add form mode ──
  if (mode === "add") {
    if (esc) { addForm = { name: "", command: "", field: 0 }; mode = "dashboard"; setFlash("info", "Canceled"); return; }
    if (up || down || tab) { addForm = { ...addForm, field: addForm.field === 0 ? 1 : 0 }; paint(); return; }
    if (enter) {
      if (addForm.field === 0) { addForm = { ...addForm, field: 1 }; paint(); }
      else void submitAdd();
      return;
    }
    if (back) {
      if (addForm.field === 0) addForm = { ...addForm, name: addForm.name.slice(0, -1) };
      else addForm = { ...addForm, command: addForm.command.slice(0, -1) };
      paint();
      return;
    }
    if (ch) {
      if (addForm.field === 0) addForm = { ...addForm, name: addForm.name + ch };
      else addForm = { ...addForm, command: addForm.command + ch };
      paint();
    }
    return;
  }

  // ── Dashboard: confirm remove ──
  if (confirmRemove) {
    if (ch === "y" || ch === "Y") {
      const name = confirmRemove;
      confirmRemove = null;
      void doRemove(name);
      return;
    }
    confirmRemove = null;
    setFlash("info", "Remove canceled");
    return;
  }

  // ── Dashboard: search mode ──
  if (searching) {
    if (esc) { searching = false; searchQuery = ""; sel = 0; paint(); return; }
    if (enter) { searching = false; paint(); return; }
    if (back) { searchQuery = searchQuery.slice(0, -1); sel = 0; paint(); return; }
    // Allow navigation while searching
    const filtered = getFiltered();
    if (up) { sel = Math.max(0, sel - 1); paint(); return; }
    if (down) { sel = Math.min(Math.max(0, filtered.length - 1), sel + 1); paint(); return; }
    if (ch) { searchQuery += ch; sel = 0; paint(); }
    return;
  }

  // ── Dashboard: Esc with active search → clear search first ──
  if (esc && searchQuery) { searchQuery = ""; sel = 0; paint(); return; }
  if (esc) { shutdown(); return; }

  if (busy) return;

  const filtered = getFiltered();
  const pageSize = Math.max(1, (out.rows ?? 24) - 5);

  if (up || ch === "k") { sel = Math.max(0, sel - 1); paint(); return; }
  if (down || ch === "j") { sel = Math.min(Math.max(0, filtered.length - 1), sel + 1); paint(); return; }
  if (pgUp) { sel = Math.max(0, sel - pageSize); paint(); return; }
  if (pgDn) { sel = Math.min(Math.max(0, filtered.length - 1), sel + pageSize); paint(); return; }

  if (ch === "/") { searching = true; paint(); return; }
  if (ch === "a") { addForm = { name: "", command: "", field: 0 }; mode = "add"; paint(); return; }

  const svc = filtered[sel];
  if (!svc) { if (ch && "srld".includes(ch)) setFlash("info", "No service selected"); return; }

  if (ch === "s") {
    const a = svc.active ? "stop" : "start";
    void doAction(a, svc.name, `${svc.name} ${a === "stop" ? "stopped" : "started"}`);
    return;
  }
  if (ch === "r") { void doAction("restart", svc.name, `${svc.name} restarted`); return; }
  if (ch === "d") { confirmRemove = svc.name; setFlash("info", `Remove ${svc.name}? Press y to confirm`); return; }

  if (ch === "l") { logScroll = 0; startLogs(svc.name); }
}

// ── Lifecycle ────────────────────────────────────────────────────────

function cleanup() {
  stopLogs(false);
  stopSpinner();
  if (flashTimer) clearTimeout(flashTimer);
  term.showCursor();
  term.leaveAlt();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

function shutdown() {
  cleanup();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
out.on("resize", () => { prevFrame = []; paint(); });

// ── Boot ─────────────────────────────────────────────────────────────

term.enterAlt();
term.hideCursor();
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);
}

paint();
void refresh(false);
setInterval(() => void refresh(true), REFRESH_MS);
