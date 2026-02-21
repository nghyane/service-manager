# lazyctl

A terminal UI for managing system services on **macOS** (launchd) and **Linux** (systemd).

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun-f472b6)
![License](https://img.shields.io/badge/license-MIT-green)

![demo](demo.gif)

## Features

- **Service discovery** — automatically lists launchd agents/daemons or systemd units
- **Start / Stop / Restart** — control services with a single keypress
- **Detail view** — inspect service info (status, command, path) with live log streaming
- **Add / Remove services** — create or delete launchd plists or systemd unit files
- **Search & filter** — quickly find services by name
- **Mouse support** — scroll with mouse wheel
- **Auto-refresh** — status updates every 3 seconds

## Requirements

- [Bun](https://bun.sh) v1.0+
- macOS or Linux

## Install

### Via bunx (no install needed)

```bash
bunx lazyctl
```

### Global install

```bash
bun add -g lazyctl
lazyctl
```

### From source

```bash
git clone https://github.com/nghyane/lazyctl.git
cd lazyctl
bun install
bun start
```

### Standalone binary

```bash
bun run build
./lazyctl
```

## Keybindings

### Dashboard

| Key | Action |
| --- | --- |
| `↑` / `k` / scroll up | Move up |
| `↓` / `j` / scroll down | Move down |
| `PgUp` / `PgDn` | Page up / down |
| `Enter` | Open detail view |
| `s` | Start / Stop selected service |
| `r` | Restart selected service |
| `a` | Add a new service |
| `d` | Remove selected service |
| `/` | Search / filter services |
| `Esc` | Clear search / Quit |

### Detail View

| Key | Action |
| --- | --- |
| `↑` / `↓` / scroll | Scroll logs |
| `PgUp` / `PgDn` | Page scroll |
| `g` / `G` | Jump to top / bottom |
| `s` | Start / Stop service |
| `r` | Restart service |
| `d` | Remove service |
| `Esc` | Back to dashboard |

## License

MIT
