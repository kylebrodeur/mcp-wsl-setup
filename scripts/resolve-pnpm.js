#!/usr/bin/env node
/**
 * Resolve a working pnpm binary and update an MCP config in place.
 * Defaults:
 *   - server name: audio-transcription (override with --server <name>)
 *   - target config: VS Code user mcp.json (override with --target <path>)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`warn: ${msg}\n`);
}

function isWSL() {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"));
}

function resolveTargetPath() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  if (process.platform === "win32") {
    return path.join(appData, "Code", "User", "mcp.json");
  }

  if (isWSL()) {
    // Default to the Windows host path when running from WSL. Ask Windows for
    // %APPDATA% rather than hardcoding a username — this used to be a literal
    // path, which worked on exactly one machine.
    const r = spawnSync("cmd.exe", ["/c", "echo %APPDATA%"], { encoding: "utf8" });
    const appdata = r.status === 0 ? (r.stdout || "").trim() : "";
    if (appdata && /^[A-Za-z]:\\/.test(appdata)) {
      const drive = appdata[0].toLowerCase();
      const rest = appdata.slice(3).replace(/\\/g, "/");
      return path.join("/mnt", drive, rest, "Code", "User", "mcp.json");
    }
    // Fall back to discovery if interop is unavailable.
    const usersDir = "/mnt/c/Users";
    try {
      for (const u of fs.readdirSync(usersDir)) {
        const p = path.join(usersDir, u, "AppData", "Roaming", "Code", "User", "mcp.json");
        if (fs.existsSync(p)) return p;
      }
    } catch {}
    warn("could not determine the Windows APPDATA path; pass --target explicitly");
    return path.join(home, ".config", "Code", "User", "mcp.json");
  }

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }

  return path.join(home, ".config", "Code", "User", "mcp.json");
}

function wslToWindows(p) {
  if (!p || !p.startsWith("/mnt/")) return p;
  const driveLetter = p[5];
  const rest = p.slice(7); // skip "/mnt/x/"
  return `${driveLetter.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
}

function resolvePnpmHome() {
  const envHome = process.env.PNPM_HOME;
  if (!isWSL()) return envHome;

  // Keep pnpm state fully inside Linux when running from WSL.
  if (!envHome || envHome.startsWith("/mnt/")) {
    return path.join(os.homedir(), ".local", "share", "pnpm");
  }

  return envHome;
}

function parseLegacyWslShellPnpmArgs(existingArgs) {
  if (!Array.isArray(existingArgs) || existingArgs.length < 4) return null;
  if (existingArgs[0] !== "-e" || existingArgs[1] !== "/bin/sh" || existingArgs[2] !== "-lc") {
    return null;
  }

  const shellCmd = existingArgs[3] || "";
  const pnpmJsMatch = shellCmd.match(/pnpm\.js"\s+(.+)$/);
  if (!pnpmJsMatch || !pnpmJsMatch[1]) return null;

  return pnpmJsMatch[1].trim().split(/\s+/);
}

// True when args look like "-e <absolute-path-to-an-executable> ..." where that
// executable is not node/pnpm — i.e. the server runs its own binary and this
// script has no business rewriting it.
function isDirectBinaryInvocation(args) {
  if (!Array.isArray(args) || args.length < 2) return false;
  if (args[0] !== "-e") return false;
  const target = args[1];
  if (typeof target !== "string" || !target.startsWith("/")) return false;
  if (/(?:^|\/)(node|npm|npx|pnpm|pnpx|corepack)(?:\.exe)?$/i.test(target)) return false;
  if (/\.(js|cjs|mjs)$/i.test(target)) return false;
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    // Path is gone. Leave it alone and let the doctor/user notice, rather than
    // silently converting a broken entry into a differently broken one.
    return true;
  }
}

function stripLegacyWslPrefixes(args) {
  let normalized = [...args];
  let changed = true;

  while (changed) {
    changed = false;

    // Previous format: -e <node> <pnpm.js> ...
    while (
      normalized.length >= 3 &&
      normalized[0] === "-e" &&
      /(?:^|\/)node(?:\.exe)?$/i.test(normalized[1] || "") &&
      /pnpm\.js$/i.test(normalized[2] || "")
    ) {
      normalized = normalized.slice(3);
      changed = true;
    }

    // Previous format with explicit env PATH:
    // -e env PATH=... <node> <pnpm.js> ...
    while (
      normalized.length >= 5 &&
      normalized[0] === "-e" &&
      normalized[1] === "env" &&
      /^PATH=/.test(normalized[2] || "") &&
      /(?:^|\/)node(?:\.exe)?$/i.test(normalized[3] || "") &&
      /pnpm\.js$/i.test(normalized[4] || "")
    ) {
      normalized = normalized.slice(5);
      changed = true;
    }
  }

  return normalized;
}

function detectPnpm(targetIsWindows, runtimeIsWindows) {
  const candidates = [];
  const platform = process.platform;
  const pnpmHome = resolvePnpmHome();
  const fnmDefaultRoot = path.join(os.homedir(), ".local", "share", "fnm", "aliases", "default");
  const fnmNode = path.join(fnmDefaultRoot, "bin", "node");
  const fnmBinDir = path.dirname(fnmNode);
  const wslBasePath = `${fnmBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  // The standalone pnpm is a self-contained executable under $PNPM_HOME/bin. It
  // is preferred over corepack's shim because the shim lives INSIDE the fnm
  // version tree: switching Node versions changes it, and if that tree is ever
  // wiped or rebuilt the shim becomes a dangling path while `node` still works.
  // A config pointing at it then fails silently. The standalone binary is
  // version-independent.
  const standalonePnpm = pnpmHome ? path.join(pnpmHome, "bin", "pnpm") : null;

  const fnmPnpmJs = path.join(
    fnmDefaultRoot,
    "lib",
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js"
  );

  // If we're running in WSL but writing a Windows user mcp.json, force execution through wsl.exe.
  // This keeps MCP launches stable even when Windows host PATH does not include pnpm.
  if (isWSL() && targetIsWindows) {
    if (standalonePnpm && fs.existsSync(standalonePnpm)) {
      // Note: these branches return directly rather than collecting into
      // `candidates`, so this must return too — pushing here would be dead code.
      return {
        command: "wsl.exe",
        commandPrefixArgs: ["-e", "env", `PATH=${wslBasePath}`, standalonePnpm],
        pnpmHome,
        pathParts: [],
        discoveredCommand: standalonePnpm,
        manageEnv: false,
      };
    }
    if (fs.existsSync(fnmNode) && fs.existsSync(fnmPnpmJs)) {
      return {
        command: "wsl.exe",
        commandPrefixArgs: ["-e", "env", `PATH=${wslBasePath}`, fnmNode, fnmPnpmJs],
        pnpmHome,
        pathParts: [],
        discoveredCommand: fnmPnpmJs,
        manageEnv: false,
      };
    }

    const wslWhich = spawnSync("which", ["pnpm"], { encoding: "utf8" });
    if (wslWhich.status === 0 && wslWhich.stdout.trim()) {
      const discoveredPnpm = wslWhich.stdout.trim();
      const discoveredPnpmDir = path.dirname(discoveredPnpm);
      return {
        command: "wsl.exe",
        commandPrefixArgs: [
          "-e",
          "env",
          `PATH=${buildPath([discoveredPnpmDir, wslBasePath], ":")}`,
          "pnpm",
        ],
        pnpmHome,
        pathParts: [],
        discoveredCommand: discoveredPnpm,
        manageEnv: false,
      };
    }
  }

  if (!runtimeIsWindows && !targetIsWindows && standalonePnpm && fs.existsSync(standalonePnpm)) {
    const pathParts = [path.dirname(standalonePnpm)];
    if (pnpmHome) pathParts.push(pnpmHome);
    return {
      command: standalonePnpm,
      commandPrefixArgs: [],
      pnpmHome,
      pathParts,
      discoveredCommand: standalonePnpm,
      manageEnv: true,
    };
  }

  if (!runtimeIsWindows && !targetIsWindows && fs.existsSync(fnmNode) && fs.existsSync(fnmPnpmJs)) {
    const pathParts = [];
    if (pnpmHome) pathParts.push(pnpmHome);
    pathParts.push(path.dirname(fnmNode));
    return {
      command: fnmNode,
      commandPrefixArgs: [fnmPnpmJs],
      pnpmHome,
      pathParts,
      discoveredCommand: fnmPnpmJs,
      manageEnv: true,
    };
  }

  if (pnpmHome) {
    candidates.push(path.join(pnpmHome, platform === "win32" ? "pnpm.cmd" : "pnpm"));
  }

  const whichCmd = platform === "win32" ? "where" : "which";
  const whichResult = spawnSync(whichCmd, ["pnpm"], { encoding: "utf8" });
  if (whichResult.status === 0 && whichResult.stdout) {
    const first = whichResult.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) candidates.push(first);
  }

  if (runtimeIsWindows || platform === "win32") {
    const base = path.join(os.homedir(), "AppData", "Roaming", "pnpm");
    candidates.push(path.join(base, "pnpm.cmd"));
    candidates.push(path.join(base, "pnpm.exe"));
    if (isWSL()) {
      // Derive the Windows pnpm home from %APPDATA% instead of hardcoding a
      // username. The literal path here previously worked on one machine only.
      const r = spawnSync("cmd.exe", ["/c", "echo %APPDATA%"], { encoding: "utf8" });
      const appdata = r.status === 0 ? (r.stdout || "").trim() : "";
      if (/^[A-Za-z]:\\/.test(appdata)) {
        const wslAppData = path.join(
          "/mnt",
          appdata[0].toLowerCase(),
          appdata.slice(3).replace(/\\/g, "/")
        );
        candidates.push(path.join(wslAppData, "pnpm", "pnpm.cmd"));
        candidates.push(path.join(wslAppData, "pnpm", "pnpm.exe"));
      }
    }
  } else {
    candidates.push(path.join(os.homedir(), ".local", "share", "pnpm", "pnpm"));
  }

  const discoveredCommand = candidates.find((p) => p && fs.existsSync(p));

  // Use plain "pnpm" when we don't have a stable explicit binary.
  const resolvedCommand = "pnpm";
  const homeRaw = pnpmHome || (discoveredCommand ? path.dirname(discoveredCommand) : undefined);
  const home = runtimeIsWindows && targetIsWindows && homeRaw ? wslToWindows(homeRaw) : homeRaw;

  const pathParts = [];
  if (home) pathParts.push(home);
  if (runtimeIsWindows || platform === "win32") {
    pathParts.push("C:\\Program Files\\nodejs");
  } else if (process.execPath) {
    pathParts.push(path.dirname(process.execPath));
  }

  return {
    command: resolvedCommand,
    commandPrefixArgs: [],
    pnpmHome: home,
    pathParts,
    discoveredCommand,
    manageEnv: true,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const val = args[i];
    if (val === "--target" && args[i + 1]) {
      result.target = args[i + 1];
      i += 1;
    } else if (val === "--server" && args[i + 1]) {
      result.server = args[i + 1];
      i += 1;
    } else if (val === "--workspace" && args[i + 1]) {
      result.workspace = args[i + 1];
      i += 1;
    } else {
      warn(`unknown arg ignored: ${val}`);
    }
  }
  return result;
}

function promptYesNo(question, defaultYes = true) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    rl.question(question + suffix, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (!normalized) return resolve(defaultYes);
      if (["y", "yes"].includes(normalized)) return resolve(true);
      if (["n", "no"].includes(normalized)) return resolve(false);
      return resolve(defaultYes);
    });
  });
}

function loadWorkspaceServers(workspacePath) {
  const wsPath = workspacePath || path.join(process.cwd(), ".vscode", "mcp.json");
  if (!fs.existsSync(wsPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(wsPath, "utf8") || "{}");
    return Object.keys(data.servers || {});
  } catch (err) {
    warn(`Could not parse workspace mcp.json at ${wsPath}: ${err.message}`);
    return [];
  }
}

function buildPath(pathParts, delimiter = path.delimiter) {
  const seen = new Set();
  return pathParts
    .flatMap((p) => (p || "").split(delimiter))
    .map((p) => p.trim())
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(delimiter);
}

function ensureConfig(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { servers: {}, inputs: [] };
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    return raw ? JSON.parse(raw) : { servers: {}, inputs: [] };
  } catch (err) {
    throw new Error(`Could not parse JSON at ${targetPath}: ${err.message}`);
  }
}

async function main() {
  const { target: targetArg, server: serverArg, workspace: workspaceArg } = parseArgs();
  const targetPath = targetArg || resolveTargetPath();
  const targetIsWindows = targetPath.toLowerCase().startsWith("/mnt/c/") || /^[a-zA-Z]:\\/.test(targetPath);
  const runtimeIsWindows = process.platform === "win32";
  const workspaceServers = loadWorkspaceServers(workspaceArg);
  const config = ensureConfig(targetPath);
  config.servers = config.servers || {};

  // Default to all stdio-like servers in the target config so user-level MCP updates are comprehensive.
  const targetServerNames = Object.keys(config.servers);
  const stdioLikeTargetServers = targetServerNames.filter((name) => {
    const existing = config.servers[name] || {};
    const transport = (existing.type || "").toLowerCase();
    const isHttpLike =
      Boolean(existing.url) ||
      ["http", "https", "sse", "websocket"].includes(transport);
    return !isHttpLike || Boolean(existing.command) || Boolean(existing.args);
  });

  let serverNames = serverArg
    ? [serverArg]
    : stdioLikeTargetServers.length
      ? stdioLikeTargetServers
      : workspaceServers.length
        ? workspaceServers
        : ["audio-transcription"];

  if (!serverArg && !stdioLikeTargetServers.length && workspaceServers.length > 1) {
    const useAll = await promptYesNo(`Detected workspace MCP servers: ${workspaceServers.join(", ")}. Update all?`, true);
    serverNames = useAll ? workspaceServers : [workspaceServers[0]];
  }

  const {
    command,
    commandPrefixArgs,
    pnpmHome,
    pathParts,
    discoveredCommand,
    manageEnv,
  } = detectPnpm(targetIsWindows, runtimeIsWindows);
  if (!discoveredCommand) {
    throw new Error(
      "pnpm not found. Install pnpm first or set PNPM_HOME, then re-run this script."
    );
  }

  const skipped = [];
  for (const serverName of serverNames) {
    const existing = config.servers[serverName] || {};

    const transport = (existing.type || "").toLowerCase();
    const isHttpLike =
      Boolean(existing.url) ||
      ["http", "https", "sse", "websocket"].includes(transport);

    if (isHttpLike && !existing.command && !existing.args) {
      log(
        `Skipped ${serverName} (http-like transport with url; no command to fix).`
      );
      continue;
    }

    const mergedEnv = { ...(existing.env || {}) };
    if (manageEnv) {
      delete mergedEnv.PATH;
      delete mergedEnv.PNPM_HOME;

      if (pnpmHome) mergedEnv.PNPM_HOME = pnpmHome;

      const normalizedPath = buildPath(
        [pnpmHome, ...pathParts],
        runtimeIsWindows ? ";" : path.delimiter
      );
      if (normalizedPath) mergedEnv.PATH = normalizedPath;
    } else {
      delete mergedEnv.PATH;
      delete mergedEnv.PNPM_HOME;
    }

    const existingArgs = existing.args || [
      "exec",
      "mcp",
      "dev",
      "src/audio_transcription/mcp_server.py",
    ];
    let normalizedExistingArgs = [...existingArgs];
    const legacyWslArgs = parseLegacyWslShellPnpmArgs(existingArgs);
    if (legacyWslArgs) {
      normalizedExistingArgs = legacyWslArgs;
    }

    if (command === "wsl.exe") {
      normalizedExistingArgs = stripLegacyWslPrefixes(normalizedExistingArgs);
    }

    // Do not adopt a server that isn't a pnpm/node invocation in the first place.
    // Some MCP servers ship a self-contained executable (its own bundled runtime)
    // and are launched directly as `wsl.exe -e /path/to/bin ...`. Prepending the
    // pnpm shim to those produces `node pnpm.js -e /path/to/bin ...`, which is
    // nonsense and silently breaks a server that was working.
    if (isDirectBinaryInvocation(normalizedExistingArgs)) {
      skipped.push(serverName);
      continue;
    }

    if ((commandPrefixArgs || []).length) {
      while (
        commandPrefixArgs.every((prefixArg, idx) => normalizedExistingArgs[idx] === prefixArg)
      ) {
        normalizedExistingArgs = normalizedExistingArgs.slice(commandPrefixArgs.length);
      }

      // Migration safety: when switching to wsl.exe -e <node> <pnpm.js>,
      // previous runs may have args starting with <node> <pnpm.js>.
      const prefixWithoutFirst = commandPrefixArgs.slice(1);
      if (
        prefixWithoutFirst.length > 0 &&
        prefixWithoutFirst.every((prefixArg, idx) => normalizedExistingArgs[idx] === prefixArg)
      ) {
        normalizedExistingArgs = normalizedExistingArgs.slice(prefixWithoutFirst.length);
      }

      const lastPrefixArg = commandPrefixArgs[commandPrefixArgs.length - 1];
      while (normalizedExistingArgs[0] === lastPrefixArg) {
        normalizedExistingArgs = normalizedExistingArgs.slice(1);
      }
    }
    const args = [...(commandPrefixArgs || []), ...normalizedExistingArgs];

    const updatedServer = {
      ...existing,
      type: existing.type || "stdio",
      command,
      args,
    };
    if (Object.keys(mergedEnv).length) {
      updatedServer.env = mergedEnv;
    } else {
      delete updatedServer.env;
    }

    config.servers[serverName] = updatedServer;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2));

  log(`Updated ${targetPath}`);
  if (skipped.length) {
    log(`  skipped (not a pnpm invocation, left untouched): ${skipped.join(", ")}`);
  }
  log(`  servers: ${serverNames.join(", ")}`);
  log(`  command: ${command}`);
  if (pnpmHome) log(`  PNPM_HOME: ${pnpmHome}`);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
