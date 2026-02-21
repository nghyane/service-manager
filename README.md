# service-manager

A terminal UI for managing system services on **macOS** (launchd) and **Linux** (systemd).

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6)

## Features

- **Service discovery** — automatically lists launchd agents/daemons or systemd units
- **Start / Stop / Restart** — control services with a single keypress
- **Live log streaming** — tail service logs directly in the TUI
- **Add services** — create new launchd plists or systemd unit files via a built-in form
- **Auto-refresh** — status updates every 3 seconds

## Requirements

- [Bun](https://bun.sh) v1.0+
- macOS or Linux

## Install

### Via bunx (no install needed)

```bash
bunx @nghyane/service-manager
```

### Global install

```bash
bun add -g @nghyane/service-manager
service-manager
```

### From source

```bash
git clone https://github.com/nghyane/service-manager.git
cd service-manager
bun install
bun start
```

### Standalone binary

```bash
bun run build
./service-manager
```

## Keybindings

| Key | Action |
| --- | --- |
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `s` | Start / Stop selected service |
| `r` | Restart selected service |
| `l` | View live logs |
| `a` | Add a new service |
| `Esc` | Back / Quit |

## License

MIT
