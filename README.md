# mcp-wsl-setup

Fix VS Code MCP server stdio launches when running Node/pnpm inside WSL via fnm.

## Quick Start

```bash
pnpm dlx mcp-wsl-setup
```

Or with npx:

```bash
npx mcp-wsl-setup
```

Run from your WSL terminal. The script auto-detects your fnm/pnpm paths and
rewrites your VS Code user `mcp.json` in place. Reload the VS Code window
afterwards (`Ctrl+Shift+P` → `Developer: Reload Window`).

### VS Code task (optional)

Copy `.vscode/tasks.json` into your project. Then `Ctrl+Shift+P` →
`Tasks: Run Task` → `Fix MCP pnpm path` runs `pnpm dlx mcp-wsl-setup`
without leaving the editor.

---

# Full Documentation

How to run VS Code MCP servers (stdio transport) reliably when your development
environment is WSL but VS Code is a Windows host application.

---

## Table of Contents

1. [Environment Overview](#1-environment-overview)
2. [fnm and Node.js Setup](#2-fnm-and-nodejs-setup)
3. [Shell Configuration](#3-shell-configuration)
4. [The Problem](#4-the-problem)
5. [Root Causes — In Order of Discovery](#5-root-causes--in-order-of-discovery)
6. [The Solution](#6-the-solution)
7. [Final Working Configuration](#7-final-working-configuration)
8. [The `resolve-pnpm.js` Script](#8-the-resolve-pnpmjs-script)
9. [VS Code Task](#9-vs-code-task)
10. [Replicating This Setup](#10-replicating-this-setup)
11. [Troubleshooting Reference](#11-troubleshooting-reference)

---

## 1. Environment Overview

| Component         | Detail                                                        |
|-------------------|---------------------------------------------------------------|
| Host OS           | Windows 11                                                    |
| Linux environment | WSL 2 (Ubuntu) — distro name in `WSL_DISTRO_NAME`            |
| Node manager      | [fnm](https://github.com/Schniz/fnm) installed inside WSL    |
| Node.js           | `~/.local/share/fnm/aliases/default/bin/node`                 |
| Package manager   | pnpm, bootstrapped via **corepack** (bundled with Node)       |
| pnpm binary       | `~/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js` |
| PNPM_HOME (final) | `~/.local/share/pnpm` (Linux-side only)                       |
| VS Code           | Windows host — reads `%APPDATA%\Code\User\mcp.json`           |
| MCP config        | `/mnt/c/Users/<you>/AppData/Roaming/Code/User/mcp.json` (auto-detected from `%APPDATA%`) |

The key tension: **VS Code runs on Windows, but all the tools live in WSL.**
Every stdio MCP server VS Code starts is launched from a Windows process (or
`wsl.exe`) with no shell initialization, so the WSL login shell environment
(PATH, PNPM_HOME, fnm shims, keychain…) is unavailable.

---

## 4. fnm and Node.js Setup

[fnm (Fast Node Manager)](https://github.com/Schniz/fnm) manages Node.js
versions inside WSL. It installs to `~/.local/share/fnm` and creates a
`default` alias that points to whichever version you set as default.

### Installed versions (this machine)

```
fnm 1.39.0
* v20.20.1
* v22.22.1  ← default (active)
  system
```

### Key paths fnm creates

| Path | What it is |
|------|------------|
| `~/.local/share/fnm/aliases/default/bin/node` | The active Node.js binary |
| `~/.local/share/fnm/aliases/default/bin/pnpm` | Shim → corepack pnpm.js |
| `~/.local/share/fnm/aliases/default/bin/corepack` | Shim → corepack.js |
| `~/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js` | The real pnpm entry point used in MCP args |

### Why fnm shims cannot be used for MCP directly

The `pnpm` file in `bin/` is itself a shim script that calls `corepack`.
Corepack then resolves the real `pnpm.js`. Under `wsl.exe -e` (no shell)
this chain works, but it adds an indirection layer. The resolver script
instead points directly at `pnpm.js` to eliminate any shim ambiguity.

### Switching the default Node version

If you upgrade Node via fnm, re-run the resolver task — it reads the
`default` alias at runtime so the absolute paths in your MCP config
will always reflect the current default:

```bash
fnm install --lts        # install a new LTS
fnm default lts-latest   # update the default alias
node scripts/resolve-pnpm.js  # regenerate mcp.json with new paths
```

### Enabling corepack (one-time)

If pnpm is not yet available via corepack:

```bash
corepack enable pnpm
# verify:
pnpm --version
```

---

## 3. Shell Configuration

MCP server launches via `wsl.exe -e env …` **do not load any shell config**.
The resolver script injects everything MCP needs directly into the launch
arguments. However, your shell config still matters for interactive use and
has a direct effect on what the resolver script inherits when you run it.

### `.zprofile` — login shell fnm init

```zsh
# ~/.zprofile
export FNM_PATH="$HOME/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env --shell zsh)"
fi
```

**Required?** Yes, for interactive terminals and for running the resolver
script itself. Without this, `node` and `fnm` are not on PATH in login
shells (e.g. `ssh`, `wsl.exe -l`).

**Does it affect MCP launches?** No. `wsl.exe -e` is a direct exec — it
never sources `.zprofile`, `.zshrc`, or any other startup file. All PATH
and environment setup for MCP is handled by the `env PATH=…` argument that
the resolver writes into `mcp.json`.

> **Note:** `.zprofile` had a comment saying *"including VS Code MCP
> launches"* — this was aspirational from before we discovered that
> `wsl.exe -e` skips all shell init. The comment can be removed or ignored.

### `.zshrc` — interactive shell config

The relevant section:

```zsh
# ~/.zshrc  (excerpt)
export PNPM_HOME="/mnt/d/.pnpm-store"   # ← Windows-side path, should be changed
export PATH="$HOME/.local/bin:$PNPM_HOME:$BUN_INSTALL/bin:$PATH"
```

**The `PNPM_HOME` here should be changed to a Linux path.** The
`/mnt/d/.pnpm-store` path works in interactive sessions but causes
cross-filesystem I/O overhead and can produce lock conflicts when pnpm
runs both from the shell and from within MCP server processes.

Recommended change in `~/.zshrc`:

```zsh
# Before:
export PNPM_HOME="/mnt/d/.pnpm-store"

# After:
export PNPM_HOME="$HOME/.local/share/pnpm"
```

Then create the directory if it does not yet exist:

```bash
mkdir -p ~/.local/share/pnpm
```

The resolver script already forces this Linux path for MCP launches
regardless of what `PNPM_HOME` is set to in your shell, but aligning
your interactive shell avoids having two separate pnpm stores.

### Summary — what shell config is required

| File | Required for MCP? | Required for interactive use? | Action needed |
|------|-------------------|-------------------------------|---------------|
| `~/.zprofile` (fnm init) | No — MCP bypasses shell | Yes | Keep as-is |
| `~/.zshrc` `PNPM_HOME` | No — resolver overrides it | Yes (avoid cross-fs) | Change to `~/.local/share/pnpm` |
| `~/.zshrc` fnm PATH | No — resolver injects PATH | Yes | Keep as-is |

---

## 4. The Problem

After adding pnpm-based MCP servers (Playwright, Sequential Thinking, Memory)
via the VS Code gallery, the servers either:

- Exited immediately with `code 1` — `Unknown option: 'prefer-offline'`
- Logged `Waiting for server to respond to initialize request…` indefinitely
- Logged `exec: node: not found` with exit code 127
- Appeared to start (printed a banner to stderr) but never completed the MCP
  handshake

---

## 5. Root Causes — In Order of Discovery

### 3.1 `--prefer-offline` flag no longer valid

The gallery-generated server entries used:

```
pnpm dlx --prefer-offline @modelcontextprotocol/server-sequential-thinking@latest
```

Newer pnpm versions removed `--prefer-offline` as a `dlx` sub-command flag.
This caused an immediate exit code 1.

**Fix:** Remove `--prefer-offline` from all `dlx` invocations.

---

### 3.2 Login-shell startup pollutes stdio

After removing `--prefer-offline` the servers appeared to start but hung
forever on `initialize`. The launch style was:

```json
"args": ["-e", "/bin/sh", "-lc", "PATH=\"...\"; exec node pnpm.js dlx ..."]
```

`/bin/sh -lc` sources `/etc/profile`, `.profile`, `.bashrc`, etc.  
On this machine that runs **keychain**, which:
- Prints multi-line banners to stderr
- Waits up to 5 seconds checking for an ssh-agent lock
- All of this output lands on the same stdio channel VS Code watches for the
  MCP JSON-RPC handshake

VS Code sees unexpected bytes before the first `{"jsonrpc":...}` frame and
times out waiting for `initialize`.

**Fix:** Do not invoke a login shell. Launch node directly as an executable
using `wsl.exe -e` (exec-only, no shell).

---

### 3.3 Directly invoking node without PATH set → `node: not found` in dlx scripts

When `pnpm dlx` downloads and runs a package (e.g. `@playwright/mcp`) it
creates a small wrapper script in its cache, e.g.:

```
~/.cache/pnpm/dlx/.../node_modules/.bin/mcp-server-memory
```

That script calls `exec node ...`. Because we bypassed the login shell, the
`node` binary (which only exists inside fnm's tree, not in `/usr/bin`) is not
on PATH—so the exec fails with:

```
exec: node: not found
exit code 127
```

**Fix:** Use `wsl.exe -e env PATH=<fnm-bin>:<std-paths> node pnpm.js dlx ...`.
Inject PATH explicitly without ever spawning a shell.

---

### 3.4 `PNPM_HOME` pointed at a Windows `/mnt/` path

The inherited `PNPM_HOME=/mnt/d/.pnpm-store` worked for interactive WSL
sessions, but when invoked via `wsl.exe -e env ...` without a login shell, the
cross-filesystem path caused cache inconsistencies and slower I/O.

**Fix:** Force `PNPM_HOME=~/.local/share/pnpm` (pure Linux path) whenever
running under WSL and the inherited value starts with `/mnt/`.

---

### 3.5 Re-running the resolver script accumulated duplicate launch prefixes

Each iteration of `resolve-pnpm.js` prepended a new launch prefix to the
existing `args` array without fully stripping the previous format.  Over
several runs the array grew:

```json
["-e", "env", "PATH=...", "node", "pnpm.js",
 "-e", "node", "pnpm.js",
 "dlx", "@playwright/mcp@latest"]
```

**Fix:** Add `stripLegacyWslPrefixes()` which iteratively strips all known
legacy prefix forms before prepending the current one, and wrap it in an outer
`while (changed)` loop to handle stacked layers.

---

## 6. The Solution

Launch each stdio MCP server as a direct `wsl.exe` exec (no shell) with an
explicitly injected PATH that includes the fnm node binary directory:

```
wsl.exe -e env PATH=<fnm-bin>:<standard-paths> <abs-path-to-node> <abs-path-to-pnpm.js> dlx <package>
```

This approach:
- Never spawns a login shell → no keychain, no startup banners
- Passes an explicit PATH → `node` is resolvable inside dlx-generated scripts
- Uses absolute paths to node and pnpm.js → no reliance on PATH for the
  initial invocation
- Keeps all pnpm state in Linux (`~/.local/share/pnpm`) → no cross-filesystem
  perf penalty

---

## 7. Final Working Configuration

Location: `%APPDATA%\Code\User\mcp.json`  
(WSL path: `/mnt/c/Users/<user>/AppData/Roaming/Code/User/mcp.json`)

```json
{
  "inputs": [
    {
      "id": "memory_file_path",
      "type": "promptString",
      "description": "Path to the memory storage file",
      "password": false
    },
    {
      "id": "Authorization",
      "type": "promptString",
      "description": "Authentication token (PAT or App token)",
      "password": true
    }
  ],
  "servers": {
    "sequentialthinking": {
      "type": "stdio",
      "command": "wsl.exe",
      "args": [
        "-e",
        "env",
        "PATH=/home/<user>/.local/share/fnm/aliases/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/home/<user>/.local/share/fnm/aliases/default/bin/node",
        "/home/<user>/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js",
        "dlx",
        "@modelcontextprotocol/server-sequential-thinking@latest"
      ],
      "gallery": true,
      "version": "0.0.1"
    },
    "memory": {
      "type": "stdio",
      "command": "wsl.exe",
      "args": [
        "-e",
        "env",
        "PATH=/home/<user>/.local/share/fnm/aliases/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/home/<user>/.local/share/fnm/aliases/default/bin/node",
        "/home/<user>/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js",
        "dlx",
        "@modelcontextprotocol/server-memory@latest"
      ],
      "env": {
        "MEMORY_FILE_PATH": "$${input:memory_file_path}"
      },
      "gallery": true,
      "version": "0.0.1"
    },
    "playwright": {
      "type": "stdio",
      "command": "wsl.exe",
      "args": [
        "-e",
        "env",
        "PATH=/home/<user>/.local/share/fnm/aliases/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "/home/<user>/.local/share/fnm/aliases/default/bin/node",
        "/home/<user>/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js",
        "dlx",
        "@playwright/mcp@latest",
        "--caps=vision"
      ]
    }
  }
}
```

Replace `<user>` with your WSL username. The `resolve-pnpm.js` script fills in
the correct paths automatically—you should not hand-edit those paths.

---

## 8. The `resolve-pnpm.js` Script

`scripts/resolve-pnpm.js` is an idempotent Node.js script that auto-detects the
correct launch configuration for your environment and rewrites your user-level
`mcp.json` in place. It is safe to run repeatedly.

### What it does

1. Detects whether it is running under WSL and whether the target config file
   lives on the Windows filesystem (`/mnt/c/…`).
2. Resolves `PNPM_HOME` — forces a Linux-side path (`~/.local/share/pnpm`)
   when running in WSL to avoid `/mnt/` cross-filesystem issues.
3. Finds the fnm-managed `node` and `corepack/pnpm.js` absolute paths.
4. Builds the safe WSL launch prefix:
   `wsl.exe -e env PATH=<fnm-bin>:<std> <node> <pnpm.js>`
5. Strips any previously written legacy launch prefixes from existing `args`
   arrays (handles multiple layered formats idempotently).
6. Rewrites all stdio-type servers in the target config, skipping HTTP/SSE
   servers that have no `command`.

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--server <name>` | all stdio servers in target config | Update only this server |
| `--target <path>` | auto-detected per platform | Path to `mcp.json` to write |
| `--workspace <path>` | `.vscode/mcp.json` in cwd | Workspace MCP config to read server names from |

### Usage

```bash
# Update all stdio servers in user mcp.json (normal usage):
node scripts/resolve-pnpm.js

# Update only the playwright server:
node scripts/resolve-pnpm.js --server playwright

# Dry-run against a test file:
node scripts/resolve-pnpm.js --target /tmp/test-mcp.json
```

### Detection priority (WSL → Windows config)

```
1. fnm node + corepack pnpm.js exist?
   → wsl.exe -e env PATH=<fnm-bin>:… <node> <pnpm.js> dlx …   ✓ used
2. `which pnpm` finds a binary?
   → wsl.exe -e env PATH=<pnpm-dir>:… pnpm dlx …
3. Fallback
   → plain `pnpm` with PATH/PNPM_HOME env vars injected
```

---

## 9. VS Code Task

`.vscode/tasks.json` registers a task that runs the resolver with one command:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Fix MCP pnpm path",
      "type": "shell",
      "command": "node",
      "args": ["scripts/resolve-pnpm.js"],
      "options": {
        "cwd": "${workspaceFolder}"
      },
      "problemMatcher": []
    }
  ]
}
```

**Run it:** `Ctrl+Shift+P` → `Tasks: Run Task` → `Fix MCP pnpm path`

After the task completes, reload the VS Code window (`Ctrl+Shift+P` →
`Developer: Reload Window`) to pick up the changed MCP config.

---

## 10. Replicating This Setup

### Prerequisites

- WSL 2 with Ubuntu (or any distro)
- fnm installed in WSL (`curl -fsSL https://fnm.vercel.app/install | bash`)
- fnm init in `~/.zprofile` (or `~/.profile` for bash) — see [Shell Configuration](#3-shell-configuration)
- Node.js active via fnm (`fnm install --lts && fnm default lts-latest`)
- pnpm accessible via corepack (`corepack enable pnpm`)
- `PNPM_HOME` set to a Linux path in `~/.zshrc` (`export PNPM_HOME="$HOME/.local/share/pnpm"`)

### Steps

1. **Copy the files** into your project:

   ```
   scripts/resolve-pnpm.js
   .vscode/tasks.json
   ```

2. **Adjust the hardcoded username** in `resolveTargetPath()` if your Windows
   username differs (the script now derives it from `%APPDATA%` automatically):

   ```js
   // In resolveTargetPath(), line ~40:
   return path.join("/mnt/c", "Users", "YOUR_WINDOWS_USERNAME", "AppData", ...);
   ```

   Or pass `--target` explicitly to override entirely.

3. **Run the resolver** once from your WSL terminal:

   ```bash
   node scripts/resolve-pnpm.js
   ```

4. **Reload VS Code** window — the MCP servers should start without hanging.

5. For future MCP servers added via the gallery, re-run the resolver or the
   VS Code task after adding them.

### Verify paths exist

```bash
# Node binary (fnm)
ls ~/.local/share/fnm/aliases/default/bin/node

# pnpm.js (corepack)
ls ~/.local/share/fnm/aliases/default/lib/node_modules/corepack/dist/pnpm.js

# Linux PNPM_HOME
ls ~/.local/share/pnpm
```

If `corepack` is not present, run:

```bash
corepack enable pnpm
```

---

## 11. Troubleshooting Reference

### Server exits with `Unknown option: 'prefer-offline'`

Your MCP config still has `--prefer-offline` in the `dlx` args. Run the
resolver task — it removes this flag automatically.

### Server logs keychain output then hangs on `initialize`

The server is still being launched via `/bin/sh -lc`. Re-run the resolver task
to switch to the direct `wsl.exe -e env …` format.

### `exec: node: not found` (exit code 127)

PATH is not being injected into the WSL process. Re-run the resolver — the
current version adds an explicit `env PATH=…` argument before the node binary.

### Duplicate entries in `args` after re-running resolver

An older version of the script. Pull the latest `resolve-pnpm.js`, which
includes `stripLegacyWslPrefixes()` with an outer `while (changed)` loop that
clears all stacked legacy formats before writing.

### PNPM_HOME is a `/mnt/` path

Add `PNPM_HOME=~/.local/share/pnpm` to your WSL `~/.bashrc` / `~/.profile`, or
unset the variable — the resolver will substitute the Linux default. Then run
the resolver again.

### Server initializes successfully in the terminal but hangs in VS Code

Check that `PNPM_HOME` is not set to a Windows path in your shell profile.
Cross-filesystem I/O (`/mnt/d/…`) can cause pnpm's store to lock or time out
under `wsl.exe -e`.

### How to diagnose any new server failure

1. Open the VS Code Output panel (`Ctrl+Shift+U`) and select the MCP server
   from the dropdown.
2. Look for the first stderr lines — they reveal whether the failure is in
   the WSL bootstrap, pnpm, or the server itself.
3. Reproduce in your WSL terminal by copy-pasting the `wsl.exe` command from
   the generated `mcp.json` `args` array — prepend `wsl.exe` as the binary and
   pass each array element as a separate positional argument.
