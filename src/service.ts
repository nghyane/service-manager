import { homedir } from "os";

export interface ServiceInfo {
  name: string;
  active: boolean;
  status: string;
  enabled?: boolean;
}

const isMac = process.platform === "darwin";

// macOS: map service label → plist file path
const plistPaths = new Map<string, string>();

async function exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ── systemd (Linux) ──────────────────────────────────────────────────

async function discoverSystemd(): Promise<ServiceInfo[]> {
  const [units, unitFiles] = await Promise.all([
    exec(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager"]),
    exec(["systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager"]),
  ]);

  const enabledMap = new Map<string, string>();
  for (const line of unitFiles.stdout.split("\n").filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      enabledMap.set(parts[0]!.replace(".service", ""), parts[1]!);
    }
  }

  const services: ServiceInfo[] = [];
  for (const line of units.stdout.split("\n").filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const name = parts[0]!.replace(".service", "");
    const loadState = parts[1]!;
    if (loadState === "not-found") continue;
    const activeState = parts[2]!;
    const enableState = enabledMap.get(name) ?? "unknown";
    services.push({
      name,
      active: activeState === "active",
      status: activeState,
      enabled: enableState === "enabled",
    });
  }

  return services.sort((a, b) => a.name.localeCompare(b.name));
}

async function runSystemd(
  action: string,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  const { code, stdout, stderr } = await exec(["sudo", "-n", "systemctl", action, name]);
  if (code !== 0 && stderr.includes("sudo:")) {
    return { ok: false, output: "sudo required – run 'sudo -v' in another terminal first" };
  }
  return { ok: code === 0, output: (stdout + " " + stderr).trim() };
}

function followSystemdLogs(name: string) {
  return Bun.spawn(["journalctl", "-u", name, "-f", "-n", "50", "--no-pager"], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ── launchd (macOS) ──────────────────────────────────────────────────

function parseLaunchctlList(output: string): Map<string, { pid: number; status: number }> {
  const map = new Map<string, { pid: number; status: number }>();
  for (const line of output.split("\n").slice(1)) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      map.set(parts[2], {
        pid: parts[0] === "-" ? 0 : parseInt(parts[0]),
        status: parseInt(parts[1]),
      });
    }
  }
  return map;
}

async function discoverLaunchd(): Promise<ServiceInfo[]> {
  const dirs = [
    "/Library/LaunchDaemons",
    "/Library/LaunchAgents",
    `${homedir()}/Library/LaunchAgents`,
  ];

  // Gather loaded services from user domain and (if sudo cached) system domain
  const [userList, systemList] = await Promise.all([
    exec(["launchctl", "list"]),
    exec(["sudo", "-n", "launchctl", "list"]),
  ]);

  const loaded = parseLaunchctlList(userList.stdout);
  if (systemList.code === 0) {
    for (const [k, v] of parseLaunchctlList(systemList.stdout)) loaded.set(k, v);
  }

  plistPaths.clear();
  const services: ServiceInfo[] = [];

  const scans = await Promise.all(
    dirs.map((dir) =>
      exec(["find", dir, "-maxdepth", "1", "-name", "*.plist", "-type", "f"]),
    ),
  );

  for (const scan of scans) {
    if (scan.code !== 0 || !scan.stdout) continue;
    for (const file of scan.stdout.split("\n").filter(Boolean)) {
      const label = file.split("/").pop()!.replace(".plist", "");
      plistPaths.set(label, file);
      const info = loaded.get(label);
      services.push({
        name: label,
        active: info ? info.pid > 0 : false,
        status: info
          ? info.pid > 0
            ? `running (PID ${info.pid})`
            : `stopped (${info.status})`
          : "unloaded",
        enabled: !!info,
      });
    }
  }

  return services.sort((a, b) => a.name.localeCompare(b.name));
}

function sudoError(r: { stderr: string }): string | null {
  return r.stderr.includes("sudo:") ? "sudo required – run 'sudo -v' in another terminal first" : null;
}

async function runLaunchd(
  action: string,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  const plist = plistPaths.get(name);
  const needsSudo = plist?.startsWith("/Library/LaunchDaemons") ?? false;
  const sudo = needsSudo ? ["sudo", "-n"] : [];

  switch (action) {
    case "start": {
      if (plist) {
        const load = await exec([...sudo, "launchctl", "load", plist]);
        if (load.code !== 0) {
          const se = sudoError(load);
          if (se) return { ok: false, output: se };
          if (!load.stderr.includes("already loaded")) {
            return { ok: false, output: (load.stdout + " " + load.stderr).trim() };
          }
        }
      }
      const r = await exec([...sudo, "launchctl", "start", name]);
      return { ok: r.code === 0, output: sudoError(r) ?? (r.stdout + " " + r.stderr).trim() };
    }
    case "stop": {
      await exec([...sudo, "launchctl", "stop", name]);
      if (plist) {
        const r = await exec([...sudo, "launchctl", "unload", plist]);
        return { ok: r.code === 0, output: sudoError(r) ?? (r.stdout + " " + r.stderr).trim() };
      }
      return { ok: true, output: "" };
    }
    case "restart": {
      const s = await exec([...sudo, "launchctl", "stop", name]);
      const se = sudoError(s);
      if (se) return { ok: false, output: se };
      const r = await exec([...sudo, "launchctl", "start", name]);
      return { ok: r.code === 0, output: sudoError(r) ?? (r.stdout + " " + r.stderr).trim() };
    }
    case "enable": {
      if (!plist) return { ok: false, output: "plist not found" };
      const r = await exec([...sudo, "launchctl", "load", "-w", plist]);
      return { ok: r.code === 0, output: sudoError(r) ?? (r.stdout + " " + r.stderr).trim() };
    }
    case "disable": {
      if (!plist) return { ok: false, output: "plist not found" };
      const r = await exec([...sudo, "launchctl", "unload", "-w", plist]);
      return { ok: r.code === 0, output: sudoError(r) ?? (r.stdout + " " + r.stderr).trim() };
    }
    default:
      return { ok: false, output: `Unknown action: ${action}` };
  }
}

function followLaunchdLogs(name: string) {
  const short = name.split(".").pop() ?? name;
  return Bun.spawn(
    ["log", "stream", "--predicate", `process == "${short}"`, "--style", "compact"],
    { stdout: "pipe", stderr: "pipe" },
  );
}

// ── create service ───────────────────────────────────────────────────

export interface CreateServiceOptions {
  name: string;
  command: string;
  cwd?: string;
}

async function createSystemdService(opts: CreateServiceOptions): Promise<{ ok: boolean; output: string }> {
  const unit = [
    "[Unit]",
    `Description=${opts.name}`,
    "",
    "[Service]",
    `ExecStart=${opts.command}`,
    ...(opts.cwd ? [`WorkingDirectory=${opts.cwd}`] : []),
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n") + "\n";

  const tmp = `/tmp/${opts.name}.service`;
  const dest = `/etc/systemd/system/${opts.name}.service`;

  await Bun.write(tmp, unit);
  const cp = await exec(["sudo", "-n", "cp", tmp, dest]);
  await exec(["rm", tmp]);
  if (cp.code !== 0) {
    return { ok: false, output: cp.stderr.includes("sudo:") ? "sudo required – run 'sudo -v' in another terminal first" : cp.stderr };
  }

  await exec(["sudo", "-n", "systemctl", "daemon-reload"]);
  await exec(["sudo", "-n", "systemctl", "enable", opts.name]);

  return { ok: true, output: dest };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of cmd) {
    if (escape) { current += ch; escape = false; continue; }
    if (ch === "\\" && !inSingle) { escape = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) { args.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

async function createLaunchdService(opts: CreateServiceOptions): Promise<{ ok: boolean; output: string }> {
  const args = parseCommand(opts.command);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(opts.name)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${escapeXml(a)}</string>`),
    "  </array>",
  ];

  if (opts.cwd) {
    lines.push("  <key>WorkingDirectory</key>", `  <string>${escapeXml(opts.cwd)}</string>`);
  }
  lines.push("  <key>KeepAlive</key>", "  <true/>");
  lines.push("  <key>RunAtLoad</key>", "  <true/>");

  lines.push("</dict>", "</plist>", "");

  const dir = `${homedir()}/Library/LaunchAgents`;
  await exec(["mkdir", "-p", dir]);
  const path = `${dir}/${opts.name}.plist`;
  await Bun.write(path, lines.join("\n"));

  return { ok: true, output: path };
}

export async function createService(
  opts: CreateServiceOptions,
): Promise<{ ok: boolean; output: string }> {
  return isMac ? createLaunchdService(opts) : createSystemdService(opts);
}

// ── remove service ───────────────────────────────────────────────────

async function removeSystemdService(name: string): Promise<{ ok: boolean; output: string }> {
  // Locate the actual unit file
  const show = await exec(["systemctl", "show", "-p", "FragmentPath", `${name}.service`]);
  const path = show.stdout.replace("FragmentPath=", "").trim();
  if (!path) return { ok: false, output: "Unit file not found" };

  const stop = await exec(["sudo", "-n", "systemctl", "stop", name]);
  if (stop.code !== 0) {
    const se = stop.stderr.includes("sudo:") ? "sudo required – run 'sudo -v' in another terminal first" : stop.stderr;
    return { ok: false, output: se };
  }

  const disable = await exec(["sudo", "-n", "systemctl", "disable", name]);
  if (disable.code !== 0) {
    return { ok: false, output: disable.stderr.includes("sudo:") ? "sudo required" : disable.stderr };
  }

  const rm = await exec(["sudo", "-n", "rm", "-f", path]);
  if (rm.code !== 0) {
    return { ok: false, output: rm.stderr.includes("sudo:") ? "sudo required – run 'sudo -v' in another terminal first" : rm.stderr };
  }
  await exec(["sudo", "-n", "systemctl", "daemon-reload"]);
  return { ok: true, output: `Removed ${path}` };
}

async function removeLaunchdService(name: string): Promise<{ ok: boolean; output: string }> {
  const plist = plistPaths.get(name);
  if (!plist) return { ok: false, output: "plist not found" };

  const needsSudo = plist.startsWith("/Library/LaunchDaemons");
  const sudo = needsSudo ? ["sudo", "-n"] : [];

  await exec([...sudo, "launchctl", "stop", name]);
  await exec([...sudo, "launchctl", "unload", plist]);

  const rm = await exec([...sudo, "rm", "-f", plist]);
  if (rm.code !== 0) {
    const se = sudoError(rm);
    return { ok: false, output: se ?? (rm.stdout + " " + rm.stderr).trim() };
  }
  return { ok: true, output: `Removed ${plist}` };
}

export async function removeService(name: string): Promise<{ ok: boolean; output: string }> {
  return isMac ? removeLaunchdService(name) : removeSystemdService(name);
}

// ── public API ───────────────────────────────────────────────────────

export async function discoverServices(): Promise<ServiceInfo[]> {
  return isMac ? discoverLaunchd() : discoverSystemd();
}

export async function runAction(
  action: "start" | "stop" | "restart" | "enable" | "disable",
  name: string,
): Promise<{ ok: boolean; output: string }> {
  return isMac ? runLaunchd(action, name) : runSystemd(action, name);
}

export function followLogs(name: string) {
  return isMac ? followLaunchdLogs(name) : followSystemdLogs(name);
}
