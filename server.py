#!/usr/bin/env python3
"""
MCP Local Access

File tools    : list_files, read_file, search_text, file_info,
                edit_file, multi_edit, create, move, delete
Command tools : run_command, list_processes, check_process, stop_process
Guide tool    : project_guide (Rules.md, also pushed with the first result)
Browser tools : browser_navigate, browser_snapshot, browser_click, browser_type,
                browser_hover, browser_drag, browser_select_option,
                browser_press_key, browser_go_back, browser_go_forward,
                browser_wait, browser_screenshot, browser_get_console_logs,
                browser_status, browser_diagnostics, browser_console,
                browser_network, browser_capture, browser_cdp, browser_evaluate,
                browser_launch, browser_close,
                browser_cdp_events (Browser Control extension in extension/;
                the old Browser MCP extension covers the first 14, no npx needed)
Transport: Streamable HTTP at /mcp
Usage: python server.py [--config other.json]   (file is looked up next to server.py)
Auth: Authorization: Bearer <MCP_TOKEN>
File sandbox: ROOT_DIR plus explicitly granted external Read/Write directories.
Shell commands are not filesystem-sandboxed.

Commands run through the system shell, so "&&", "||" and "|" work. Every link
of such a chain is matched against the Run(...) whitelist separately, and
commands are denied unless a Run rule allows them.

Path validation and edit logic are modelled on the MIT-licensed
@modelcontextprotocol/server-filesystem reference implementation.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import base64
import difflib
import inspect
import functools
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path, PureWindowsPath

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    print("Missing dependency: python-dotenv. Run: pip install -r requirements.txt")
    raise SystemExit(1)

try:
    import uvicorn
    from mcp.server.fastmcp import FastMCP, Image
except ImportError:  # pragma: no cover
    print("Missing dependencies. Run: pip install -r requirements.txt")
    raise SystemExit(1)


# ---------------------------------------------------------------- config ----

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
load_dotenv(ENV_PATH)

DEFAULT_CONFIG_NAME = "config.json"

MAX_RESPONSE_CHARS = 100_000
MAX_CONTENT_BYTES = 1024 * 1024  # 1 MB
MAX_LIST_ENTRIES = 1000
SKIP_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".idea",
}
WINDOWS_ABS = re.compile(r"^[A-Za-z]:[\\/]")
IS_WINDOWS = os.name == "nt"

# --- commands -------------------------------------------------------------
LOG_DIR_NAME = "logs"           # created inside rootDir on first use
AUDIT_FILENAME = "audit.log"
AUDIT_KEEP_LINES = 300          # audit.log is a rolling tail, not an archive
AUDIT_TRIM_EVERY = 100          # appends between two trims while the server runs
STATE_FILENAME = "processes.json"  # registry mirror, so a restart can recover it
DEFAULT_TIMEOUT = 60            # seconds a synchronous command may run
MAX_TIMEOUT = 600               # ceiling the model cannot raise
DEFAULT_IDLE_TIMEOUT = 15       # background: stop waiting once output goes quiet
MAX_PROCESSES = 8               # simultaneous background processes
MAX_OUTPUT_CHARS = 20_000       # command output returned in one response
PROCESS_KEEP_SECONDS = 600      # how long a finished process stays in the registry


def fail(message: str) -> None:
    print(f"\n  ERROR: {message}\n", file=sys.stderr)
    raise SystemExit(1)


TOKEN_LINE_RE = re.compile(r"^[ \t]*MCP_TOKEN[ \t]*=.*$")


def persist_token(token: str) -> None:
    """Write the token into .env, replacing any existing MCP_TOKEN line.

    Appending blindly used to leave two MCP_TOKEN lines in the file, so the
    first line is rewritten in place and duplicates are dropped.
    """
    line = f"MCP_TOKEN={token}"
    try:
        text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    except OSError as exc:
        fail(f"Cannot read {ENV_PATH.name}: {exc}")

    if any(TOKEN_LINE_RE.match(row) for row in text.splitlines()):
        kept: list[str] = []
        written = False
        for row in text.splitlines():
            if TOKEN_LINE_RE.match(row):
                if written:
                    continue  # drop duplicate MCP_TOKEN lines
                written = True
                kept.append(line)
            else:
                kept.append(row)
        updated = "\n".join(kept) + "\n"
    else:
        separator = "" if not text or text.endswith("\n") else "\n"
        updated = f"{text}{separator}{line}\n"

    try:
        ENV_PATH.write_text(updated, encoding="utf-8")
    except OSError as exc:
        fail(f"Cannot write {ENV_PATH.name}: {exc}")


def ensure_token() -> str:
    """Read MCP_TOKEN from .env, generating and persisting one on first run."""
    token = (os.getenv("MCP_TOKEN") or "").strip()
    if token:
        return token
    token = secrets.token_hex(16)
    persist_token(token)
    print(f"Generated a new MCP_TOKEN and saved it to {ENV_PATH}")
    return token


def resolve_config_path() -> Path:
    """Pick the settings file: --config, then CONFIG_FILE, then config.json.

    "python server.py --config new.json" looks the file up in the folder of
    server.py, so start.cmd never needs a full path. A file named explicitly
    with --config must exist; only the default config.json may be missing.
    """
    parser = argparse.ArgumentParser(description="MCP Local Access")
    parser.add_argument(
        "--config",
        "-c",
        metavar="FILE",
        help=f"settings file next to server.py (default: {DEFAULT_CONFIG_NAME})",
    )
    args, _ = parser.parse_known_args()
    name = (args.config or "").strip().strip('"')
    if name:
        path = BASE_DIR / name
        if not path.is_file():
            fail(f"Config file not found: {path}. Put it next to server.py or drop --config.")
        return path
    return Path(os.getenv("CONFIG_FILE") or (BASE_DIR / DEFAULT_CONFIG_NAME))


CONFIG_PATH = resolve_config_path()


def load_config_file() -> dict:
    """Read the active config. Missing default file is fine; broken JSON is fatal."""
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Cannot read {CONFIG_PATH.name}: {exc}")
    if not isinstance(data, dict):
        fail(f"{CONFIG_PATH.name} must contain a JSON object.")
    return data


CONFIG = load_config_file()

# config.json holds the settings; .env holds only the secret token.
# ROOT_DIR / PORT / READ_ONLY in .env still work as a fallback for older setups.
_root_raw = str(CONFIG.get("rootDir") or os.getenv("ROOT_DIR") or "").strip()
if not _root_raw:
    fail('rootDir is not set. Copy config.example.json to config.json and set "rootDir".')

ROOT = Path(_root_raw).expanduser().resolve()
if not ROOT.is_dir():
    fail(f"rootDir does not exist or is not a directory: {ROOT}")

TOKEN = ensure_token()
PORT = int(CONFIG.get("port") or os.getenv("PORT") or 8000)
# Interface to listen on. The default 0.0.0.0 works for both publication paths:
# a tunnel on this machine and a reverse proxy on another host in the network.
# Set "127.0.0.1" to accept local connections only; the server warns on start
# while it is listening on every interface.
HOST = str(CONFIG.get("host") or os.getenv("HOST") or "0.0.0.0").strip()


def flag(key: str, env_name: str) -> bool:
    if key in CONFIG:
        return bool(CONFIG[key])
    return (os.getenv(env_name) or "").strip().lower() in {"1", "true", "yes"}


READ_ONLY = flag("readOnly", "READ_ONLY")
JSON_RESPONSE = flag("jsonResponse", "JSON_RESPONSE")

# Command logs and the audit trail live inside rootDir so they can be read
# with the normal file tools.
LOG_DIR = ROOT / str(CONFIG.get("logDir") or LOG_DIR_NAME)
AUDIT_PATH = LOG_DIR / AUDIT_FILENAME
STATE_PATH = LOG_DIR / STATE_FILENAME
AUDIT = bool(CONFIG.get("audit", True))
COMMAND_TIMEOUT_CAP = max(1, int(CONFIG.get("maxCommandTimeout") or MAX_TIMEOUT))

# The active config is always protected, whatever its name: a deny rule such as
# *(**/config.json) would not cover a file started with --config new.json.
ACTIVE_CONFIG = CONFIG_PATH.resolve()

# --- browser (Browser MCP extension bridge) --------------------------------
BROWSER_DEFAULT_PORT = 9009     # the port the extension connects to
BROWSER_DEFAULT_TIMEOUT = 30    # seconds to wait for the extension to answer
BROWSER_MAX_MESSAGE = 64 * 1024 * 1024  # screenshots travel as base64 text
BROWSER_MAX_WAIT = 60           # ceiling for browser_wait
BROWSER_LAUNCH_TIMEOUT = 30     # browser_launch: wait for the extension to connect
BROWSER_CLOSE_TIMEOUT = 10      # browser_close: wait for Chrome to exit by itself
# Hides Chrome's "started debugging this browser" bar. Chrome keeps one
# process per profile and reads flags only when that process starts, so the
# owner's own shortcut needs the flag too (README, browser_launch).
BROWSER_SILENT_FLAG = "--silent-debugger-extension-api"


def browser_settings() -> dict:
    spec = CONFIG.get("browser", {})
    if spec is None:
        spec = {}
    if not isinstance(spec, dict):
        fail(f'{CONFIG_PATH.name}: "browser" must be a JSON object.')
    try:
        port = int(spec.get("port") or BROWSER_DEFAULT_PORT)
        timeout = max(1, int(spec.get("timeoutSeconds") or BROWSER_DEFAULT_TIMEOUT))
        launch_timeout = max(5, int(spec.get("launchTimeoutSeconds") or BROWSER_LAUNCH_TIMEOUT))
        close_timeout = max(1, int(spec.get("closeTimeoutSeconds") or BROWSER_CLOSE_TIMEOUT))
    except (TypeError, ValueError):
        fail(f"{CONFIG_PATH.name}: browser.port and browser.*Seconds must be numbers.")
    launch_args = spec.get("launchArgs") or []
    if not isinstance(launch_args, list) or not all(isinstance(arg, str) for arg in launch_args):
        fail(f'{CONFIG_PATH.name}: "browser.launchArgs" must be a list of strings.')
    return {
        "enabled": bool(spec.get("enabled", True)),
        "host": str(spec.get("host") or "localhost").strip(),
        "port": port,
        "timeout": timeout,
        # file:// pages show the AI any file of this computer, past rootDir and
        # its deny rules, so browser_navigate / browser_cdp refuse them unless
        # the owner opts in here (and in the Browser Control popup).
        "allowFileUrls": bool(spec.get("allowFileUrls", False)),
        # browser_launch: Chrome binary (auto-detected when empty), optional
        # profile overrides and extra flags. Empty userDataDir = the owner's
        # normal profile, so signed-in sites stay signed in.
        "chromePath": str(spec.get("chromePath") or "").strip(),
        "userDataDir": str(spec.get("userDataDir") or "").strip(),
        "profileDirectory": str(spec.get("profileDirectory") or "").strip(),
        "launchArgs": list(launch_args),
        "launchTimeout": launch_timeout,
        "closeTimeout": close_timeout,
    }


BROWSER = browser_settings()


# ------------------------------------------------------------- sandboxing ---


def is_absolute_path(value: str) -> bool:
    return value.startswith("/") or bool(WINDOWS_ABS.match(value))


def path_value(raw: str) -> str:
    value = (raw or ".").strip().replace("\\", "/")
    windows = PureWindowsPath(value)
    if windows.drive and not windows.is_absolute():
        raise ValueError("Drive-relative paths such as J:src are not allowed; use J:/src.")
    if IS_WINDOWS and value.startswith("/") and not value.startswith("//"):
        raise ValueError("Windows paths must include a drive or a complete UNC share.")
    if value.startswith("//"):
        unc_parts = value[2:].split("/")
        if len(unc_parts) < 2 or not all(unc_parts[:2]) or unc_parts[0] in {"?", "."} or not windows.is_absolute():
            raise ValueError("UNC paths must include a server and a share: //server/share/folder; device paths are not allowed.")
    if IS_WINDOWS:
        tail = value[2:] if WINDOWS_ABS.match(value) else value
        if ":" in tail:
            raise ValueError("Windows alternate data streams are not allowed.")
    if not IS_WINDOWS and (windows.drive or value.startswith("//")):
        raise ValueError("Windows drive/UNC paths require a Windows server; use an SMB mount path on Linux.")
    return value


def policy_path(raw: str) -> Path:
    value = path_value(raw)
    # Keep the lexical alias for deny checks. Resolve separately before granting access.
    return Path(os.path.abspath(value if is_absolute_path(value) else ROOT / value))


def external_matches(path: Path) -> list[tuple[str, Path, Path, str]]:
    return [rule for rule in PERMISSIONS.get("external", []) if _is_within(path, rule[2])]


def allowed_location(path: Path) -> bool:
    real = path.resolve()
    if _is_within(path, ROOT):
        return _is_within(real, ROOT) or bool(external_matches(real))
    # Compare canonical targets: mapped drives and UNC may spell the same location
    # differently. A link back into ROOT is not an external grant.
    return bool(external_matches(real))


def resolve_path(raw: str) -> Path:
    """Validate a relative project path or an explicitly granted external absolute path."""
    candidate = policy_path(raw)
    value = path_value(raw)
    if is_absolute_path(value) and _is_within(candidate, ROOT):
        raise ValueError("Absolute paths inside rootDir are not allowed; use a relative project path.")
    if not allowed_location(candidate):
        raise ValueError(
            f"Path escapes the allowed root directory or external grants. Allowed root: {ROOT}. Got: {raw!r}"
        )
    return candidate


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix() or "."
    except ValueError:
        return path.as_posix()


def human_size(num: int) -> str:
    step = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if step < 1024 or unit == "GB":
            return f"{step:.0f} {unit}" if unit == "B" else f"{step:.1f} {unit}"
        step /= 1024
    return f"{num} B"


# ----------------------------------------------------------- permissions ---

# Rules are written Claude-Code style: Tool(path-glob), or Run(command-glob).
# "*" means every path-based tool; it never covers Run.
#
#   List   -> list_files
#   Read   -> read_file, search_text, file_info
#   Edit   -> edit_file, multi_edit
#   Create -> create, and the destination of move
#   Delete -> delete, and the source of move
#   Run    -> run_command (matched against the command text, not a path)
KNOWN_TOOLS = {
    "LIST": "list_files",
    "READ": "read_file",
    "EDIT": "edit_file",
    "CREATE": "create",
    "DELETE": "delete",
    "RUN": "run_command",
    "WRITE": "external full file access",
}
RULE_RE = re.compile(r"^\s*([A-Za-z_*]+)\s*\((.*)\)\s*$", re.DOTALL)

# Patterns are matched against the path relative to rootDir, so secret files are
# guarded with a "**/" prefix to cover every subfolder, not just the root.
BUILTIN_PERMISSIONS = {
    "allow": ["List(**)", "Read(**)", "Edit(**)", "Create(**)", "Delete(**)"],
    "deny": [
        "*(**/.env)",
        "*(**/.env.*)",
        "*(**/secrets/**)",
        "*(**/*.pem)",
        "*(**/*.key)",
        "Edit(**/.git/**)",
        "Create(**/.git/**)",
        "Delete(**/.git/**)",
    ],
    "defaultMode": "allow",
}


def compile_patterns(patterns: list[str]) -> list[re.Pattern[str]]:
    """Compile globs; "dir/**" also matches the bare "dir" entry."""
    compiled = []
    for pattern in patterns:
        compiled.append(glob_to_regex(pattern))
        trimmed = pattern.strip().replace("\\", "/").rstrip("/")
        if trimmed.endswith("/**"):
            compiled.append(glob_to_regex(trimmed[:-3]))
    return compiled


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a path glob into a regex. Supports **, * and ?."""
    text = pattern.strip().replace("\\", "/")
    if text.startswith("./"):
        text = text[2:]
    out: list[str] = []
    i = 0
    while i < len(text):
        if text.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif text.startswith("**", i):
            out.append(".*")
            i += 2
        elif text[i] == "*":
            out.append("[^/]*")
            i += 1
        elif text[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(text[i]))
            i += 1
    return re.compile("^" + "".join(out) + "/?$", re.IGNORECASE)


def command_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a command glob into a regex; only "*" is special.

    Runs of whitespace are collapsed on both sides, so Run(npm  run dev)
    still matches "npm run dev".
    """
    text = " ".join(pattern.strip().split())
    out = [".*" if char == "*" else re.escape(char) for char in text]
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE)


def parse_rules(
    entries: list, kind: str
) -> tuple[list[tuple[str, re.Pattern[str], str]], list[tuple[re.Pattern[str], str]]]:
    """Split rules into path rules and Run command rules.

    Path rules become (TOOL, regex, original) triples; Run rules become
    (regex, original) pairs matched against command text.
    """
    parsed: list[tuple[str, re.Pattern[str], str]] = []
    commands: list[tuple[re.Pattern[str], str]] = []
    for entry in entries:
        if not isinstance(entry, str):
            fail(f'{CONFIG_PATH.name}: every "{kind}" rule must be a string, got {entry!r}.')
        match = RULE_RE.match(entry)
        if not match:
            fail(
                f'{CONFIG_PATH.name}: cannot parse rule {entry!r}. '
                'Expected the form Tool(path), for example "Read(src/**)".'
            )
        tool = match.group(1).upper()
        if tool not in KNOWN_TOOLS and tool != "*":
            known = ", ".join(sorted(KNOWN_TOOLS))
            fail(f"{CONFIG_PATH.name}: unknown tool {match.group(1)!r} in {entry!r}. Known tools: {known}, *.")
        if tool == "RUN":
            commands.append((command_to_regex(match.group(2)), entry))
            continue
        argument = match.group(2).strip().replace("\\", "/")
        if kind == "allow" and PureWindowsPath(argument).drive and not is_absolute_path(argument):
            fail(f"Drive-relative permission paths are not allowed: {entry!r}.")
        if kind == "allow" and is_absolute_path(argument):
            if tool not in {"READ", "WRITE"}:
                fail(f"External allow rules must use Read or Write: {entry!r}.")
            # External grants are parsed separately, never as relative glob permissions.
            continue
        if tool == "WRITE" and kind == "allow":
            fail(f"Write requires an absolute external directory: {entry!r}.")
        # deny rules also hide the directory itself, allow rules do not
        patterns = compile_patterns([argument]) if kind == "deny" else [glob_to_regex(argument)]
        for pattern in patterns:
            parsed.append((tool, pattern, entry))
    return parsed, commands


def parse_external_rules(entries: list) -> list[tuple[str, Path, Path, str]]:
    grants = []
    for entry in entries:
        match = RULE_RE.match(entry)
        tool, value = match.group(1).upper(), match.group(2).strip().replace("\\", "/")
        if tool not in {"READ", "WRITE"} or not is_absolute_path(value):
            continue
        if value.endswith("/**"):
            value = value[:-3]
        if any(char in value for char in "*?[]"):
            fail(f"External grants require a concrete directory, optionally ending in /**: {entry!r}.")
        try:
            lexical = policy_path(value)
            canonical = lexical.resolve()
            if _is_within(lexical, ROOT) or _is_within(canonical, ROOT):
                raise ValueError("Use relative permissions for directories inside rootDir.")
            if canonical.exists() and not canonical.is_dir():
                raise ValueError("An external grant must name a directory, not a file.")
        except (OSError, RuntimeError, ValueError) as exc:
            fail(f"Invalid external grant {entry!r}: {exc}")
        grants.append((tool, lexical, canonical, entry))
    return grants


def load_permissions() -> dict:
    spec = CONFIG.get("permissions")
    if spec is None:
        spec = BUILTIN_PERMISSIONS
        source = "built-in defaults"
    elif not isinstance(spec, dict):
        fail(f'{CONFIG_PATH.name}: "permissions" must be a JSON object.')
    else:
        source = str(CONFIG_PATH)

    mode = str(spec.get("defaultMode", "allow")).strip().lower()
    if mode not in {"allow", "deny"}:
        fail(f'{CONFIG_PATH.name}: "defaultMode" must be either "allow" or "deny".')

    allow = list(spec.get("allow") or [])
    deny = list(spec.get("deny") or [])

    allow_paths, allow_commands = parse_rules(allow, "allow")
    deny_paths, deny_commands = parse_rules(deny, "deny")

    return {
        "source": source,
        "default": mode,
        "allow": allow_paths,
        "deny": deny_paths,
        "external": parse_external_rules(allow),
        "allowRun": allow_commands,
        "denyRun": deny_commands,
        "raw": {"allow": allow, "deny": deny, "defaultMode": mode},
    }


PERMISSIONS = load_permissions()


def normalize(relative: str) -> str:
    # Do not use lstrip("./") here: it strips every leading '.' and '/',
    # turning ".env" into "env" and silently bypassing deny rules.
    target = relative.replace("\\", "/")
    if target.startswith("./"):
        target = target[2:]
    return target.lstrip("/") or "."


def is_allowed(tool: str, relative: str) -> tuple[bool, str]:
    """Deny wins; broad relative allow/defaultMode never grant external access."""
    wanted = tool.upper()
    try:
        path = policy_path(relative)
        real = path.resolve()
        if not allowed_location(path):
            return False, "path is outside rootDir and explicit external grants"
        if real == ACTIVE_CONFIG:
            return False, "the active config file is protected"
        if wanted == "DELETE" and protected_root(path):
            return False, "project and external grant roots cannot be deleted or moved"
    except (OSError, RuntimeError, ValueError) as exc:
        return False, f"invalid or inaccessible path: {exc}"

    views = {rel(path), rel(real), path.as_posix(), real.as_posix()}
    grants = []
    for rule in PERMISSIONS.get("external", []):
        level, lexical, canonical, entry = rule
        if _is_within(real, canonical):
            views.add(real.relative_to(canonical).as_posix() or ".")
            # Also check the configured drive/UNC spelling, not just its canonical target.
            views.add((lexical / real.relative_to(canonical)).as_posix())
            grants.append(rule)
    # A deny on a directory protects descendants too, including aliased secrets folders.
    deny_views = set(views)
    for view in views:
        parts = view.split("/")
        deny_views.update("/".join(parts[:i]) for i in range(1, len(parts)))
    for rule_tool, pattern, entry in PERMISSIONS["deny"]:
        if rule_tool in (wanted, "*", "WRITE") and any(pattern.match(view) for view in deny_views):
            return False, f"blocked by deny rule {entry}"

    if not (_is_within(path, ROOT) and _is_within(real, ROOT)):
        if not grants:
            return False, "no explicit external grant matches the resolved directory"
        # Most-specific directory wins. Write upgrades Read only on the same directory.
        depth = max(len(rule[2].parts) for rule in grants)
        selected = [rule for rule in grants if len(rule[2].parts) == depth]
        writable = any(rule[0] == "WRITE" for rule in selected)
        if wanted in {"LIST", "READ"} or (writable and wanted in {"EDIT", "CREATE", "DELETE"}):
            return True, f"allowed by external grant {selected[0][3]}"
        return False, "external directory is read-only; an explicit Write grant is required"

    target = normalize(rel(real))
    for rule_tool, pattern, entry in PERMISSIONS["allow"]:
        if rule_tool in (wanted, "*") and pattern.match(target):
            return True, f"allowed by {entry}"
    if PERMISSIONS["default"] == "allow":
        return True, "allowed by defaultMode"
    return False, f"no allow rule matches {tool}({target})"


def protected_root(path: Path) -> bool:
    real = path.resolve()
    return real == ROOT or any(real == rule[2] for rule in PERMISSIONS.get("external", []))


def searchable_files(directory: Path, seen: set[Path] | None = None):
    """Walk permitted aliases without following cycles or entering denied directories."""
    seen = set() if seen is None else seen
    try:
        real = directory.resolve()
        if real in seen or not is_allowed("Read", rel(directory))[0]:
            return
        seen.add(real)
        entries = sorted(directory.iterdir(), key=lambda item: item.name.lower())
    except (OSError, RuntimeError):
        return
    for item in entries:
        if not is_allowed("Read", rel(item))[0]:
            continue
        if item.is_dir():
            if item.name not in SKIP_DIRS and is_allowed("List", rel(item))[0]:
                yield from searchable_files(item, seen)
        elif item.is_file():
            yield item


def ensure_allowed(tool: str, path: Path) -> None:
    relative = rel(path)
    ok, reason = is_allowed(tool, relative)
    if not ok:
        raise ValueError(
            f"Permission denied: {tool}({relative}) — {reason}. "
            f"Rules live in {CONFIG_PATH.name}; ask the owner to change them."
        )


def split_command(command: str) -> list[str]:
    """Split a shell chain into the individual commands it will run.

    "npm ci && npm run build" becomes two segments. Quoted text is kept
    intact, so "echo 'a && b'" stays a single command.
    """
    segments: list[str] = []
    current: list[str] = []
    quote = ""
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in "\"'":
            quote = char
            current.append(char)
            index += 1
            continue
        if command.startswith("&&", index) or command.startswith("||", index):
            segments.append("".join(current))
            current = []
            index += 2
            continue
        if char in "|;&\n\r":
            segments.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1

    if quote:
        raise ValueError("Unbalanced quote in command.")
    segments.append("".join(current))
    return [" ".join(part.split()) for part in segments if part.strip()]


def is_command_allowed(segment: str) -> tuple[bool, str]:
    """Commands are denied unless a Run(...) allow rule matches.

    Unlike file paths, commands never fall back to defaultMode: an empty
    whitelist means no command can be executed.
    """
    for pattern, entry in PERMISSIONS["denyRun"]:
        if pattern.match(segment):
            return False, f"blocked by deny rule {entry}"
    for pattern, entry in PERMISSIONS["allowRun"]:
        if pattern.match(segment):
            return True, f"allowed by {entry}"
    return False, "no Run(...) rule allows it"


def ensure_command_allowed(command: str) -> list[str]:
    """Check every link of a shell chain; returns the parsed segments."""
    segments = split_command(command)
    if not segments:
        raise ValueError("command must not be empty.")
    for segment in segments:
        ok, reason = is_command_allowed(segment)
        if not ok:
            allowed = ", ".join(entry for _, entry in PERMISSIONS["allowRun"]) or "none"
            raise ValueError(
                f"Permission denied: Run({segment}) — {reason}. "
                f"Allowed commands: {allowed}. Rules live in {CONFIG_PATH.name}; "
                "ask the owner to change them."
            )
    return segments


def looks_binary(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return b"\x00" in handle.read(8192)
    except OSError:
        return False


BOM = "\ufeff"


def read_text(path: Path) -> tuple[str, bool]:
    """Read text and strip a UTF-8 BOM.

    Windows editors often prepend a BOM. It is invisible to the model but would
    break exact matching in edit_file, so it is removed on read and restored on
    write. Returns (text_without_bom, had_bom).
    """
    raw = path.read_text(encoding="utf-8", errors="replace")
    if raw.startswith(BOM):
        return raw[len(BOM) :], True
    return raw, False


def atomic_write(path: Path, content: str) -> None:
    # Preserve a file symlink: replace its checked target, not the link itself.
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def clamp(text: str) -> str:
    if len(text) <= MAX_RESPONSE_CHARS:
        return text
    return text[:MAX_RESPONSE_CHARS] + f"\n\n[truncated: response exceeded {MAX_RESPONSE_CHARS} characters]"


def guard_write() -> None:
    if READ_ONLY:
        raise ValueError("Server is running in READ_ONLY mode; write tools are disabled.")


# ------------------------------------------------------------------ audit ---


def ensure_log_dir() -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass


_audit_writes = 0


def trim_audit(keep: int = AUDIT_KEEP_LINES) -> None:
    """Keep only the last `keep` lines of logs/audit.log. Never raises.

    Every interesting call appends a line, so without trimming the journal
    grows until the disk does. It is a rolling tail answering "what happened
    recently", not an archive: trimmed on startup and every AUDIT_TRIM_EVERY
    appends, so a server that stays up for weeks stays bounded as well.
    """
    if not AUDIT:
        return
    try:
        if not AUDIT_PATH.exists():
            return
        with AUDIT_PATH.open("r", encoding="utf-8", errors="replace") as handle:
            tail = deque(handle, maxlen=keep)  # memory stays flat on a huge file
        if len(tail) < keep:
            return
        text = "".join(tail)
        if not text.endswith("\n"):
            text += "\n"
        with AUDIT_PATH.open("w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


def audit(tool: str, detail: str, ok: bool = True) -> None:
    """Append one line per interesting call to logs/audit.log. Never raises."""
    global _audit_writes
    if not AUDIT:
        return
    try:
        ensure_log_dir()
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with AUDIT_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {'ok ' if ok else 'ERR'} {tool}: {detail}\n")
    except OSError:
        pass
    _audit_writes += 1
    if _audit_writes >= AUDIT_TRIM_EVERY:
        _audit_writes = 0
        trim_audit()


# -------------------------------------------------------------- processes ---

# Commands are started by this server, so their lifetime is not tied to one
# tool call: a dev server keeps running after run_command returns. MCP has no
# way to push a notification into the model's turn, so awareness is done the
# same way Claude Code does it - the state of every tracked process is
# appended to the result of every tool call as a short [processes] banner.

PROCESSES: dict[int, dict] = {}
PROCESS_LOCK = threading.Lock()
_process_seq = 0


def command_env() -> dict:
    """Force UTF-8, non-interactive, colourless output so it stays readable."""
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    env["TERM"] = "dumb"
    return env


def wrap_for_shell(command: str) -> str:
    # cmd.exe starts in a legacy codepage, which turns non-ASCII error
    # messages into mojibake before they ever reach the model.
    return f"chcp 65001>nul & {command}" if IS_WINDOWS else command


def log_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def read_log(path: Path, start: int = 0, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """Read a command log from a byte offset, keeping head and tail if huge."""
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
    if len(text) > max_chars:
        half = max_chars // 2
        skipped = len(text) - max_chars
        return f"{text[:half]}\n[... {skipped} characters skipped ...]\n{text[-half:]}"
    return text


def pid_alive(pid: int) -> bool:
    """Liveness check for a pid this process does not own (adopted commands)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if IS_WINDOWS:
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except Exception:
            return False
        return str(pid) in (result.stdout or "")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False
    return True


def process_alive(record: dict) -> bool:
    """True while the command runs. Adopted records have no Popen handle."""
    popen = record.get("popen")
    if popen is not None:
        return popen.poll() is None
    return pid_alive(record.get("pid") or 0)


def save_state() -> None:
    """Mirror the registry to logs/processes.json. Never raises."""
    try:
        ensure_log_dir()
        with PROCESS_LOCK:
            payload = {
                "seq": _process_seq,
                "saved": time.time(),
                "processes": [
                    {
                        "id": item["id"],
                        "command": item["command"],
                        "cwd": item["cwd"],
                        "pid": item["pid"],
                        "log": rel(item["log"]),
                        "started": item["started"],
                        "finished": item["finished"],
                        "status": item["status"],
                        "exitCode": item["exitCode"],
                    }
                    for item in PROCESSES.values()
                ],
            }
        temp = STATE_PATH.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temp.replace(STATE_PATH)
    except OSError:
        pass


def reconcile_processes() -> dict:
    """Recover the registry from logs/processes.json after a restart.

    A hard kill of the server (closed console, Task Manager) never runs the
    atexit cleanup, so children survive: "npm run dev" keeps holding its port
    while the fresh server knows nothing about it and would happily start a
    second one. The saved state is therefore checked against the OS:

    - pid still alive and its log still there -> adopt it back into the
      registry. Output was redirected to a file, not a pipe, so check_process
      keeps working; only the exact exit code is lost (no Popen handle).
    - anything else -> treated as finished and its cmd-NNN.log is removed, so
      logs/ does not grow forever and ids keep counting up.

    A pid can in theory be reused by an unrelated process; the command is kept
    for reporting, but adoption cannot fully prove identity. See README.
    """
    global _process_seq
    report = {"adopted": 0, "dead": 0, "cleaned": 0}
    try:
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    try:
        _process_seq = max(_process_seq, int(raw.get("seq") or 0))
    except (TypeError, ValueError):
        pass

    keep: set[Path] = set()
    for item in raw.get("processes") or []:
        if not isinstance(item, dict):
            continue
        try:
            process_id = int(item.get("id") or 0)
            pid = int(item.get("pid") or 0)
        except (TypeError, ValueError):
            continue
        if process_id <= 0:
            continue
        _process_seq = max(_process_seq, process_id)
        log_path = ROOT / str(item.get("log") or "")
        if item.get("status") != "running" or not log_path.is_file() or not pid_alive(pid):
            report["dead"] += 1
            continue
        command = str(item.get("command") or "")
        try:
            started = float(item.get("started") or time.time())
        except (TypeError, ValueError):
            started = time.time()
        PROCESSES[process_id] = {
            "id": process_id,
            "command": command,
            "key": " ".join(command.split()).lower(),
            "cwd": str(item.get("cwd") or "."),
            "popen": None,  # adopted: liveness comes from the pid
            "pid": pid,
            "log": log_path,
            "handle": None,
            "started": started,
            "finished": None,
            "status": "running",
            "exitCode": None,
            "announced": False,
            "adopted": True,
            "read": 0,
        }
        keep.add(log_path)
        report["adopted"] += 1

    try:
        for path in LOG_DIR.glob("cmd-*.log"):
            if path not in keep:
                path.unlink()
                report["cleaned"] += 1
    except OSError:
        pass

    save_state()
    return report


def refresh_processes() -> None:
    """Poll every tracked process and update its status."""
    changed = False
    with PROCESS_LOCK:
        for record in PROCESSES.values():
            if record["status"] != "running" or process_alive(record):
                continue
            popen = record.get("popen")
            record["status"] = "exited"
            record["exitCode"] = popen.poll() if popen is not None else None
            record["finished"] = time.time()
            changed = True
            handle = record.get("handle")
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
    if changed:
        save_state()


def process_line(record: dict) -> str:
    age = int(time.time() - record["started"])
    log_name = rel(record["log"])
    if record["status"] == "running":
        mark = " (adopted)" if record.get("adopted") else ""
        return (
            f"  #{record['id']} running{mark}   {record['command']}"
            f"  (pid {record['pid']}, {age}s, log {log_name})"
        )
    code = record["exitCode"]
    return (
        f"  #{record['id']} {record['status']} (exit {'unknown' if code is None else code})"
        f"  {record['command']}  (log {log_name})"
    )


def status_banner() -> str:
    """Process summary appended to every tool result; empty when idle."""
    refresh_processes()
    lines: list[str] = []
    stale: list[int] = []
    now = time.time()
    with PROCESS_LOCK:
        for record in PROCESSES.values():
            if record["status"] == "running":
                lines.append(process_line(record))
            elif not record["announced"]:
                record["announced"] = True  # report a finished command once
                lines.append(process_line(record))
            elif now - (record["finished"] or now) > PROCESS_KEEP_SECONDS:
                stale.append(record["id"])
        for key in stale:
            PROCESSES.pop(key, None)
    if not lines:
        return ""
    return "\n\n[processes]\n" + "\n".join(lines)


def find_process(process_id: int) -> dict:
    refresh_processes()
    with PROCESS_LOCK:
        record = PROCESSES.get(int(process_id))
    if not record:
        known = ", ".join(f"#{key}" for key in sorted(PROCESSES)) or "none"
        raise ValueError(f"No process #{process_id}. Known processes: {known}.")
    return record


def find_running(command: str) -> dict | None:
    """Find an identical command that is still running."""
    wanted = " ".join(command.split()).lower()
    refresh_processes()
    with PROCESS_LOCK:
        for record in PROCESSES.values():
            if record["status"] == "running" and record["key"] == wanted:
                return record
    return None


def running_count() -> int:
    refresh_processes()
    with PROCESS_LOCK:
        return sum(1 for record in PROCESSES.values() if record["status"] == "running")


def kill_tree(record: dict) -> None:
    """Kill the process and its children.

    npm spawns node, and it is the child that holds the port, so killing only
    the parent leaves the port busy and the next run fails.
    """
    popen = record.get("popen")
    pid = int(record.get("pid") or 0)
    if process_alive(record):
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    timeout=20,
                )
            else:
                # POSIX (macOS, Linux): the child got its own session via
                # start_new_session, so the whole group must be signalled -
                # otherwise node survives npm. An adopted record has no Popen
                # to wait on, so SIGKILL is escalated by hand.
                try:
                    target = -os.getpgid(pid)
                except OSError:
                    target = pid
                os.kill(target, signal.SIGTERM)
                if popen is None:
                    deadline = time.time() + 10
                    while time.time() < deadline and pid_alive(pid):
                        time.sleep(0.2)
                    if pid_alive(pid):
                        os.kill(target, signal.SIGKILL)
        except Exception:
            pass
        if popen is not None:
            try:
                popen.wait(timeout=10)
            except Exception:
                try:
                    popen.kill()
                except Exception:
                    pass
    with PROCESS_LOCK:
        if record["status"] == "running":
            record["status"] = "stopped"
            record["exitCode"] = popen.returncode if popen is not None else None
            record["finished"] = time.time()
        handle = record.get("handle")
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass
    save_state()


def start_process(command: str, cwd_path: Path) -> dict:
    """Start a command and register it. Output goes to logs/cmd-NNN.log."""
    global _process_seq
    ensure_log_dir()
    with PROCESS_LOCK:
        _process_seq += 1
        process_id = _process_seq

    log_path = LOG_DIR / f"cmd-{process_id:03d}.log"
    handle = log_path.open("wb")
    extra: dict = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if IS_WINDOWS
        else {"start_new_session": True}
    )
    try:
        popen = subprocess.Popen(  # noqa: S602 - shell is intentional, see README
            wrap_for_shell(command),
            shell=True,
            cwd=str(cwd_path),
            stdout=handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=command_env(),
            **extra,
        )
    except BaseException:
        handle.close()
        raise

    normalized = " ".join(command.split())
    record = {
        "id": process_id,
        "command": normalized,
        "key": normalized.lower(),
        "cwd": rel(cwd_path),
        "popen": popen,
        "pid": popen.pid,
        "log": log_path,
        "handle": handle,
        "started": time.time(),
        "finished": None,
        "status": "running",
        "exitCode": None,
        "announced": False,
        "adopted": False,
        "read": 0,
    }
    with PROCESS_LOCK:
        PROCESSES[process_id] = record
    save_state()
    return record


def watch(record: dict, timeout: float, idle_timeout: float, wait_for: str) -> str:
    """Block until the command exits, matches wait_for, goes quiet or times out.

    Returns the reason: "exited", "matched", "idle" or "timeout".
    """
    try:
        pattern = re.compile(wait_for, re.IGNORECASE) if wait_for else None
    except re.error as exc:
        raise ValueError(f"wait_for is not a valid regular expression: {exc}") from exc

    started = time.time()
    last_change = started
    size = 0
    while True:
        if not process_alive(record):
            refresh_processes()
            return "exited"
        current = log_size(record["log"])
        if current != size:
            size = current
            last_change = time.time()
            if pattern and pattern.search(read_log(record["log"])):
                return "matched"
        now = time.time()
        if idle_timeout and size and now - last_change >= idle_timeout:
            return "idle"
        if now - started >= timeout:
            return "timeout"
        time.sleep(0.2)


def stop_all_processes() -> None:
    """Never leave orphaned dev servers behind when the server exits."""
    for record in list(PROCESSES.values()):
        if record["status"] == "running":
            kill_tree(record)
    save_state()


atexit.register(stop_all_processes)

# Done at import time: the registry must be correct before the first tool call.
STARTUP_REPORT = reconcile_processes()


# ------------------------------------------------------------------ tools ---

RULES_FILENAME = "Rules.md"
MAX_RULES_CHARS = 20_000


def find_rules_file() -> Path | None:
    """Locate the owner's project guide.

    Order: the "rulesFile" path from config.json, then Rules.md in the project
    root, then Rules.md next to server.py.
    """
    candidates: list[Path] = []
    configured = str(CONFIG.get("rulesFile") or "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        candidates.append(candidate if candidate.is_absolute() else ROOT / configured)
    candidates.extend([ROOT / RULES_FILENAME, BASE_DIR / RULES_FILENAME])

    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def read_rules() -> tuple[str, str]:
    """Return (guide text, source label). Empty text means there is no guide."""
    path = find_rules_file()
    if path is None:
        return "", f"no {RULES_FILENAME} found"
    try:
        text = path.read_text(encoding="utf-8", errors="replace").lstrip(BOM).strip()
    except OSError as exc:
        return "", f"{rel(path)} is unreadable ({exc})"
    if len(text) > MAX_RULES_CHARS:
        text = text[:MAX_RULES_CHARS] + "\n[truncated: open the file with read_file for the rest]"
    return text, rel(path)


BASE_INSTRUCTIONS = f"""Local filesystem access for one project folder.

All paths are relative to the project root; absolute paths are rejected.
Start with list_files to see the layout, then read_file before editing.
Prefer edit_file (targeted find/replace) over rewriting whole files.
Large files are paginated: use offset/limit with read_file.
Deleting is permanent - there is no trash. Check the path before calling delete,
and pass recursive=True only when a whole folder really has to go.
Use search_text instead of reading whole files to find something, multi_edit to
apply several replacements to one file, and move to rename files.

Commands run through run_command and may be chained with "&&", "||" and "|".
Every link of the chain must match the Run(...) whitelist; commands are denied
unless a rule allows them. Keep background=False for commands that finish, and
use background=True for long-lived ones such as a dev server. Processes started
this way keep running between calls and are listed in the [processes] banner at
the end of every tool result - check it before starting a command again, and use
check_process / stop_process to follow up instead of launching a duplicate.

Some paths are blocked by the owner's permission rules. A "Permission denied"
result is final: do not retry it and do not look for a way around it.

browser_* tools drive the owner's own browser through the Browser MCP extension.
Call browser_snapshot first and pass the element refs it returns to
browser_click / browser_type / browser_hover. If no tab is connected, call
browser_launch (it opens Chrome with the owner's profile and connects its tab
by itself) or ask the user to press "Connect" in the extension; do not retry in
a loop. After work started with browser_launch, call browser_close.

Root directory: {ROOT}
Config file: {CONFIG_PATH.name}
Browser tools: {"on" if BROWSER["enabled"] else "off"}
Read-only mode: {"on" if READ_ONLY else "off"}
Blocked rules: {", ".join(PERMISSIONS["raw"]["deny"]) or "nothing"}
Allowed commands: {", ".join(entry for _, entry in PERMISSIONS["allowRun"]) or "none"}
Default for unmatched paths: {PERMISSIONS["default"]}
"""


DIALOG_INSTRUCTION = (
    "When using Local Access, always call show-dialog-box after completing a task "
    "or asking the user a clarifying question in chat. "
    "Stop on 'Dialog finished.', an explicit stop request, or an unavailable tool."
)


def dialog_instruction() -> str:
    """Optional usage hint; no GUI import is needed during server startup."""
    config = CONFIG.get("dialog", {})
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("config.json: dialog must be an object")
    enabled = config.get("autoPrompt", True)
    if not isinstance(enabled, bool):
        raise ValueError("dialog.autoPrompt must be true or false")
    return DIALOG_INSTRUCTION if enabled else ""


def build_instructions() -> str:
    """Usage notes plus the owner's project guide, delivered on connect."""
    rules, source = read_rules()
    base = "\n".join(filter(None, (BASE_INSTRUCTIONS, dialog_instruction())))
    if not rules:
        return (
            f"{base}\nProject guide: {source}. Create {RULES_FILENAME} in the "
            "project root to have it delivered here automatically.\n"
        )
    return (
        f"{base}\n"
        f"===== Project guide from {source} - written by the owner, follow it =====\n\n"
        f"{rules}\n\n"
        f"===== end of {source} =====\n"
        "This copy was taken when the session started; re-read the file with read_file "
        "if the details matter.\n"
    )


mcp = FastMCP(
    "local-mcp",
    instructions=build_instructions(),
    stateless_http=True,
    json_response=JSON_RESPONSE,
)

_rules_stamp: tuple | None = None


def refresh_instructions() -> None:
    """Re-read the guide when it changes, so a new session gets the current text.

    Called on every request: editing Rules.md is enough, no server restart.
    """
    global _rules_stamp
    path = find_rules_file()
    try:
        info = path.stat() if path else None
        stamp = (str(path), info.st_mtime_ns, info.st_size) if info else None
    except OSError:
        stamp = None
    if stamp == _rules_stamp:
        return
    _rules_stamp = stamp
    mcp._mcp_server.instructions = build_instructions()


# ---------------------------------------------------------- project guide ---

# The guide belongs in the `instructions` field of the MCP handshake, and that
# is where build_instructions() puts it. Some clients - Notion among them -
# never pass that field to the model, so the guide also has to travel with
# something the model always sees: a tool result. It rides on the first result
# of a conversation, the same way the [processes] banner rides on every result.

GUIDE_IDLE_SECONDS = 900  # a gap this long counts as a new conversation

_guide_stamp: tuple | None = None
_guide_sent = False
_last_tool_call = 0.0


def guide_stamp() -> tuple | None:
    """Identity of the guide file, so editing it counts as a new guide."""
    path = find_rules_file()
    try:
        info = path.stat() if path else None
    except OSError:
        return None
    return (str(path), info.st_mtime_ns, info.st_size) if info else None


def guide_text() -> str:
    """The owner's guide wrapped in markers; empty when there is none."""
    rules, source = read_rules()
    if not rules:
        return ""
    return (
        f"===== project guide from {source} - written by the owner, follow it =====\n\n"
        f"{rules}\n\n"
        f"===== end of {source} =====\n"
    )


def mark_guide_delivered() -> None:
    """Remember that the model has just received the guide."""
    global _guide_stamp, _guide_sent, _last_tool_call
    _guide_stamp = guide_stamp()
    _guide_sent = True
    _last_tool_call = time.time()


def guide_banner() -> str:
    """Guide text for the first tool result of a conversation, else empty.

    Stateless HTTP leaves no session to hang this on, so "new conversation" is
    approximated by three triggers: nothing sent since startup, the guide file
    changed, or the calls went quiet for GUIDE_IDLE_SECONDS.
    """
    global _guide_stamp, _guide_sent, _last_tool_call
    now = time.time()
    idle = now - _last_tool_call
    stamp = guide_stamp()
    due = not _guide_sent or stamp != _guide_stamp or idle >= GUIDE_IDLE_SECONDS
    _last_tool_call = now
    if not due:
        return ""
    _guide_stamp = stamp
    _guide_sent = True
    text = "\n\n".join(filter(None, (guide_text(), dialog_instruction())))
    return f"\n\n{text}" if text else ""


@mcp.tool()
def project_guide() -> str:
    """Read the owner's guide for this project: what it is, where things live, how to work here.

    Call it first in a new conversation, before the other tools, unless a
    "project guide" block already arrived with an earlier tool result.
    """
    text = guide_text()
    mark_guide_delivered()
    if not text:
        _, source = read_rules()
        text = f"No project guide: {source}."
    return "\n\n".join(filter(None, (text, dialog_instruction())))


@mcp.tool()
def list_files(path: str = ".", recursive: bool = False, max_depth: int = 3) -> str:
    """List files and folders inside the project.

    Use recursive=False (default) for one directory level. Set recursive=True to
    include nested folders, limited by max_depth. Noise folders such as
    node_modules, .git, dist and __pycache__ are always skipped.

    If no "project guide" block has arrived yet in this conversation, call
    project_guide first: it carries the owner's rules for this project.

    Args:
        path: Relative project directory or explicitly granted external absolute directory. Defaults to the root.
        recursive: Include nested directories.
        max_depth: Maximum depth when recursive is True (1 = direct children).
    """
    target = resolve_path(path)
    ensure_allowed("List", target)
    if not target.exists():
        raise ValueError(f"Directory not found: {rel(target)}")
    if not target.is_dir():
        raise ValueError(f"Not a directory: {rel(target)}. Use read_file for files.")

    lines: list[str] = []
    hidden: list[str] = []
    truncated = False
    seen: set[Path] = set()

    def walk(directory: Path, depth: int) -> None:
        nonlocal truncated
        if truncated:
            return
        try:
            real = directory.resolve()
            if real in seen:
                return
            seen.add(real)
            entries = sorted(
                directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower())
            )
        except (OSError, RuntimeError):
            lines.append(f"[SKIP] {rel(directory)}/ (unreadable directory)")
            return

        for entry in entries:
            if len(lines) >= MAX_LIST_ENTRIES:
                truncated = True
                return
            listable, _ = is_allowed("List", rel(entry))
            readable, _ = is_allowed("Read", rel(entry))
            allowed = listable and readable
            if not allowed:
                hidden.append(rel(entry))
                continue
            if entry.is_dir():
                if entry.name in SKIP_DIRS:
                    continue
                lines.append(f"[DIR ] {rel(entry)}/")
                if recursive and depth < max_depth:
                    walk(entry, depth + 1)
            else:
                try:
                    size = human_size(entry.stat().st_size)
                except OSError:
                    size = "?"
                lines.append(f"[FILE] {rel(entry)} ({size})")

    walk(target, 1)

    if not lines:
        return f"{rel(target)}/ is empty."

    header = f"{rel(target)}/ — {len(lines)} entries" + (
        f" (recursive, max_depth={max_depth})" if recursive else ""
    )
    footer = (
        f"\n\n[truncated: reached the {MAX_LIST_ENTRIES}-entry limit]" if truncated else ""
    )
    if hidden:
        footer += f"\n[{len(hidden)} entries hidden by permission rules]"
    return clamp(header + "\n" + "\n".join(lines) + footer)


@mcp.tool()
def read_file(path: str, offset: int = 1, limit: int = 500) -> str:
    """Read a text file, returning numbered lines.

    For large files read in pages: the footer reports the next offset to use.

    Args:
        path: Relative project file or explicitly granted external absolute file.
        offset: 1-based line number to start from.
        limit: How many lines to return.
    """
    target = resolve_path(path)
    ensure_allowed("Read", target)
    if not target.exists():
        raise ValueError(f"File not found: {rel(target)}")
    if target.is_dir():
        raise ValueError(f"{rel(target)} is a directory. Use list_files instead.")
    if looks_binary(target):
        size = human_size(target.stat().st_size)
        raise ValueError(f"{rel(target)} looks like a binary file ({size}); it cannot be read as text.")

    offset = max(1, int(offset))
    limit = max(1, int(limit))

    content, _ = read_text(target)
    all_lines = content.splitlines()
    total = len(all_lines)

    if offset > total:
        return f"{rel(target)} has {total} lines; offset {offset} is past the end."

    chunk = all_lines[offset - 1 : offset - 1 + limit]
    end = offset + len(chunk) - 1
    width = len(str(end))
    body = "\n".join(f"{offset + i:>{width}}\u2192{line}" for i, line in enumerate(chunk))

    footer = f"\n\n[lines {offset}-{end} of {total}"
    footer += f", next offset: {end + 1}]" if end < total else ", end of file]"
    return clamp(f"{rel(target)}\n{body}{footer}")


@mcp.tool()
def edit_file(path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """Replace exact text inside an existing file and return a diff.

    old_string must match the file byte-for-byte, including indentation. By
    default it must appear exactly once; set replace_all=True to replace every
    occurrence. Pass an empty new_string to delete the matched text.

    Args:
        path: Relative project file or explicitly granted external absolute file.
        old_string: Exact text to find.
        new_string: Replacement text (empty string deletes).
        replace_all: Replace every occurrence instead of requiring uniqueness.
    """
    guard_write()
    target = resolve_path(path)
    ensure_allowed("Edit", target)
    if not target.exists():
        raise ValueError(f"File not found: {rel(target)}. Use create to make a new file.")
    if target.is_dir():
        raise ValueError(f"{rel(target)} is a directory, not a file.")
    if not old_string:
        raise ValueError("old_string must not be empty.")

    original, had_bom = read_text(target)
    count = original.count(old_string)

    if count == 0:
        raise ValueError(
            f"No match found in {rel(target)}. Check whitespace, indentation and line breaks; "
            "read_file returns the exact text."
        )
    if count > 1 and not replace_all:
        raise ValueError(
            f"Found {count} matches in {rel(target)}. Include more surrounding context in "
            "old_string to make it unique, or set replace_all=True."
        )

    updated = original.replace(old_string, new_string) if replace_all else original.replace(old_string, new_string, 1)
    if updated == original:
        return f"No changes: {rel(target)} already matches the requested content."

    atomic_write(target, (BOM if had_bom else "") + updated)

    diff = "".join(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            updated.splitlines(keepends=True),
            fromfile=f"a/{rel(target)}",
            tofile=f"b/{rel(target)}",
            n=3,
        )
    )
    replaced = count if replace_all else 1
    return clamp(f"Updated {rel(target)} ({replaced} replacement(s)).\n\n{diff}")


@mcp.tool()
def create(path: str, type: str = "file", content: str = "", overwrite: bool = False) -> str:
    """Create a new file or directory. Parent folders are created automatically.

    Args:
        path: Path relative to the project root.
        type: Either "file" or "directory".
        content: Initial text content (files only).
        overwrite: Allow replacing an existing file. Defaults to False.
    """
    guard_write()
    kind = (type or "file").strip().lower()
    if kind not in {"file", "directory"}:
        raise ValueError('type must be either "file" or "directory".')

    target = resolve_path(path)
    ensure_allowed("Create", target)

    if kind == "directory":
        if target.exists() and not target.is_dir():
            raise ValueError(f"A file already exists at {rel(target)}.")
        if target.is_dir():
            return f"Directory already exists: {rel(target)}/"
        target.mkdir(parents=True, exist_ok=True)
        return f"Created directory {rel(target)}/"

    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise ValueError("content exceeds the 1 MB limit for a single create call.")
    if target.is_dir():
        raise ValueError(f"{rel(target)} is an existing directory.")
    if target.exists() and not overwrite:
        raise ValueError(
            f"{rel(target)} already exists. Use edit_file to modify it, or pass overwrite=True."
        )

    existed = target.exists()
    atomic_write(target, content)
    action = "Overwrote" if existed else "Created"
    line_count = len(content.splitlines())
    return f"{action} {rel(target)} ({line_count} lines, {human_size(len(content.encode('utf-8')))})"


@mcp.tool()
def delete(path: str, recursive: bool = False) -> str:
    """Delete a file or directory. This is permanent - there is no trash.

    A non-empty directory is removed only when recursive=True. The project root
    itself can never be deleted, and a directory is refused as a whole if it
    contains anything the permission rules protect.

    Args:
        path: Path relative to the project root.
        recursive: Allow deleting a directory together with its contents.
    """
    guard_write()
    target = resolve_path(path)
    if protected_root(target):
        raise ValueError("Refusing to delete the project root or an external grant root itself.")
    ensure_allowed("Delete", target)
    if not target.exists():
        raise ValueError(f"Nothing to delete: {rel(target)}")

    if target.is_symlink():
        target.unlink()
        return f"Deleted symlink {rel(target)}"

    if target.is_dir():
        inside = list(target.rglob("*"))
        if inside and not recursive:
            raise ValueError(
                f"{rel(target)}/ is not empty ({len(inside)} entries inside). "
                "Pass recursive=True to delete it together with its contents."
            )
        protected = [rel(item) for item in inside if not is_allowed("Delete", rel(item))[0]]
        if protected:
            raise ValueError(
                f"Permission denied: {len(protected)} entries inside {rel(target)}/ are "
                f"protected by deny rules, for example {protected[0]}. "
                "Delete the allowed files individually instead."
            )
        shutil.rmtree(target)
        return f"Deleted directory {rel(target)}/ ({len(inside)} entries inside)."

    target.unlink()
    return f"Deleted file {rel(target)}"


@mcp.tool()
def search_text(
    pattern: str,
    path: str = ".",
    glob: str = "*",
    regex: bool = False,
    case_sensitive: bool = False,
    context: int = 0,
    max_results: int = 100,
) -> str:
    """Search for text across the project and return matching lines.

    Much cheaper than reading whole files: use it to locate a symbol, a string
    or a TODO before opening anything.

    Args:
        pattern: Text to look for (a regular expression when regex=True).
        path: Relative project path or explicitly granted external absolute path.
        glob: File filter, e.g. "*.py" or "src/**/*.ts".
        regex: Treat pattern as a regular expression.
        case_sensitive: Match case exactly.
        context: Lines of context to show around each match.
        max_results: Stop after this many matches.
    """
    if not pattern:
        raise ValueError("pattern must not be empty.")
    target = resolve_path(path)
    ensure_allowed("Read", target)
    if not target.exists():
        raise ValueError(f"Path not found: {rel(target)}")

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        needle = re.compile(pattern if regex else re.escape(pattern), flags)
    except re.error as exc:
        raise ValueError(f"pattern is not a valid regular expression: {exc}") from exc

    name_filter = glob_to_regex(glob)
    limit = max(1, min(int(max_results), 500))
    around = max(0, min(int(context), 10))

    candidates: list[Path] = []
    if target.is_file():
        candidates.append(target)
    else:
        for item in searchable_files(target):
            if len(candidates) >= 5000:
                break
            relative = rel(item)
            if not (name_filter.match(relative) or name_filter.match(item.name)):
                continue
            if not is_allowed("Read", relative)[0]:
                continue
            candidates.append(item)

    hits: list[str] = []
    scanned = 0
    files_with_hits = 0
    truncated = False

    for item in candidates:
        if truncated:
            break
        try:
            if item.stat().st_size > MAX_CONTENT_BYTES * 2 or looks_binary(item):
                continue
        except OSError:
            continue
        scanned += 1
        content, _ = read_text(item)
        lines = content.splitlines()
        found_here = False
        for number, line in enumerate(lines, start=1):
            if not needle.search(line):
                continue
            found_here = True
            if around:
                start = max(1, number - around)
                end = min(len(lines), number + around)
                block = [
                    f"{rel(item)}:{index}:{'>' if index == number else ' '} {lines[index - 1]}"
                    for index in range(start, end + 1)
                ]
                hits.append("\n".join(block))
            else:
                hits.append(f"{rel(item)}:{number}: {line.strip()}")
            if len(hits) >= limit:
                truncated = True
                break
        if found_here:
            files_with_hits += 1

    if not hits:
        return f"No matches for {pattern!r} in {rel(target)} ({scanned} files searched)."

    header = (
        f"{len(hits)} match(es) in {files_with_hits} file(s), {scanned} files searched"
        + (f" — stopped at max_results={limit}" if truncated else "")
    )
    separator = "\n\n" if around else "\n"
    return clamp(header + "\n" + separator.join(hits))


@mcp.tool()
def file_info(path: str) -> str:
    """Show size, modification time, line count and type of a file or folder.

    Useful before reading: it tells you whether a file is text, how many lines
    it has and therefore how to page through it.

    Args:
        path: Path relative to the project root.
    """
    target = resolve_path(path)
    ensure_allowed("Read", target)
    if not target.exists():
        raise ValueError(f"Path not found: {rel(target)}")

    info = target.stat()
    modified = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(info.st_mtime))

    if target.is_dir():
        entries = list(target.iterdir())
        files = sum(1 for item in entries if item.is_file())
        folders = len(entries) - files
        return (
            f"{rel(target)}/\n"
            f"  type     : directory\n"
            f"  entries  : {files} files, {folders} folders\n"
            f"  modified : {modified}"
        )

    binary = looks_binary(target)
    lines = "-"
    if not binary:
        content, _ = read_text(target)
        lines = str(len(content.splitlines()))
    return (
        f"{rel(target)}\n"
        f"  type     : {'binary' if binary else 'text'}\n"
        f"  size     : {human_size(info.st_size)}\n"
        f"  lines    : {lines}\n"
        f"  modified : {modified}"
    )


@mcp.tool()
def multi_edit(path: str, edits: list[dict], regex: bool = False) -> str:
    """Apply several replacements to one file in a single atomic call.

    Every edit is {"old_string": ..., "new_string": ..., "replace_all": false}.
    Edits are applied in order and the file is written only if all of them
    succeed, so a failing edit leaves the file untouched.

    Args:
        path: Relative project file or explicitly granted external absolute file.
        edits: List of replacement objects.
        regex: Treat old_string as a regular expression (new_string may use \\1).
    """
    guard_write()
    target = resolve_path(path)
    ensure_allowed("Edit", target)
    if not target.exists():
        raise ValueError(f"File not found: {rel(target)}. Use create to make a new file.")
    if target.is_dir():
        raise ValueError(f"{rel(target)} is a directory, not a file.")
    if not edits:
        raise ValueError("edits must contain at least one replacement.")

    original, had_bom = read_text(target)
    updated = original
    applied: list[str] = []

    for number, edit in enumerate(edits, start=1):
        if not isinstance(edit, dict):
            raise ValueError(f"Edit {number} must be an object with old_string and new_string.")
        old = edit.get("old_string") or ""
        new = edit.get("new_string") or ""
        replace_all = bool(edit.get("replace_all"))
        if not old:
            raise ValueError(f"Edit {number}: old_string must not be empty.")

        if regex:
            try:
                compiled = re.compile(old)
            except re.error as exc:
                raise ValueError(f"Edit {number}: invalid regular expression: {exc}") from exc
            count = len(compiled.findall(updated))
            if count == 0:
                raise ValueError(f"Edit {number}: no match for {old!r}; nothing was written.")
            if count > 1 and not replace_all:
                raise ValueError(
                    f"Edit {number}: {count} matches for {old!r}. Make it unique or set replace_all."
                )
            updated = compiled.sub(new, updated, count=0 if replace_all else 1)
        else:
            count = updated.count(old)
            if count == 0:
                raise ValueError(
                    f"Edit {number}: no match found; nothing was written. Check whitespace and "
                    "indentation, read_file returns the exact text."
                )
            if count > 1 and not replace_all:
                raise ValueError(
                    f"Edit {number}: found {count} matches. Add surrounding context or set "
                    "replace_all=True. Nothing was written."
                )
            updated = updated.replace(old, new) if replace_all else updated.replace(old, new, 1)
        applied.append(f"edit {number}: {count if replace_all else 1} replacement(s)")

    if updated == original:
        return f"No changes: {rel(target)} already matches the requested content."

    atomic_write(target, (BOM if had_bom else "") + updated)
    audit("multi_edit", f"{rel(target)} ({len(edits)} edits)")

    diff = "".join(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            updated.splitlines(keepends=True),
            fromfile=f"a/{rel(target)}",
            tofile=f"b/{rel(target)}",
            n=3,
        )
    )
    return clamp(f"Updated {rel(target)}: " + "; ".join(applied) + f"\n\n{diff}")


@mcp.tool()
def move(source: str, destination: str, overwrite: bool = False) -> str:
    """Move or rename a file or directory inside the project.

    Requires Delete permission on the source and Create permission on the
    destination, so protected files cannot be moved out of their protection.

    Args:
        source: Existing relative project path or explicitly granted external absolute path.
        destination: New relative project path or explicitly granted external absolute path.
        overwrite: Allow replacing an existing destination file.
    """
    guard_write()
    src = resolve_path(source)
    dst = resolve_path(destination)

    if protected_root(src):
        raise ValueError("Refusing to move the project root or an external grant root itself.")
    if not src.exists():
        raise ValueError(f"Source not found: {rel(src)}")
    if src == dst:
        return f"No changes: source and destination are the same ({rel(src)})."

    ensure_allowed("Delete", src)
    ensure_allowed("Create", dst)

    if src.is_dir():
        if _is_within(dst, src):
            raise ValueError("Cannot move a directory into itself.")
        inside = list(src.rglob("*"))
        protected = [
            rel(item)
            for item in inside
            if not is_allowed("Delete", rel(item))[0]
            or not is_allowed("Create", rel(dst / item.relative_to(src)))[0]
        ]
        if protected:
            raise ValueError(
                f"Permission denied: {len(protected)} entries inside {rel(src)}/ are protected "
                f"by deny rules, for example {protected[0]}. Move the allowed files individually."
            )

    if dst.exists():
        if dst.is_dir():
            raise ValueError(f"{rel(dst)}/ already exists as a directory.")
        if not overwrite:
            raise ValueError(f"{rel(dst)} already exists. Pass overwrite=True to replace it.")
        ensure_allowed("Delete", dst)
        dst.unlink()

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    audit("move", f"{rel(src)} -> {rel(dst)}")
    kind = "directory" if dst.is_dir() else "file"
    return f"Moved {kind} {rel(src)} -> {rel(dst)}"


@mcp.tool()
def run_command(
    command: str,
    cwd: str = ".",
    timeout: int = DEFAULT_TIMEOUT,
    background: bool = False,
    wait_for: str = "",
    idle_timeout: int = 0,
    restart: bool = False,
) -> str:
    """Run a shell command inside the project.

    Chains are allowed: "npm ci && npm run build" runs through the shell, but
    every link of the chain must match the Run(...) whitelist in config.json.

    Short commands: keep background=False; the result contains the exit code
    and the output, and the process is always dead when the call returns.

    Long-lived commands such as "npm run dev": pass background=True. The
    process keeps running after the call returns, optionally waiting for
    wait_for or for the output to go quiet. Its state then appears in the
    [processes] banner of every later tool result; follow up with
    check_process and stop_process.

    An identical command that is already running is refused unless
    restart=True, which stops the old process first.

    Args:
        command: Command line to execute.
        cwd: Relative project directory or an external absolute directory granted Write.
        timeout: Seconds to wait (capped by maxCommandTimeout in config.json).
        background: Keep the process running after the call returns.
        wait_for: Regex; stop waiting once it appears in the output.
        idle_timeout: Stop waiting after this many seconds without new output.
        restart: Replace an identical running command instead of refusing.
    """
    guard_write()
    text = (command or "").strip()
    if not text:
        raise ValueError("command must not be empty.")
    if "\n" in text or "\r" in text:
        raise ValueError(
            "command must be a single line: a newline separates commands, so a "
            "multi-line command would only run in part. Join the steps with && "
            "or put the script in a file and run that."
        )

    ensure_command_allowed(text)

    work_dir = resolve_path(cwd)
    ensure_allowed("List", work_dir)
    if not _is_within(work_dir.resolve(), ROOT):
        ensure_allowed("Edit", work_dir)  # Read grants must not enable commands in an external cwd.
    if not work_dir.is_dir():
        raise ValueError(f"cwd is not a directory: {rel(work_dir)}")

    limit = max(1, min(int(timeout or DEFAULT_TIMEOUT), COMMAND_TIMEOUT_CAP))

    existing = find_running(text)
    if existing and not restart:
        raise ValueError(
            f"Already running as #{existing['id']} (pid {existing['pid']}, started "
            f"{int(time.time() - existing['started'])}s ago). Use check_process to see its "
            f"output, stop_process to end it, or pass restart=True to replace it."
        )
    if existing:
        kill_tree(existing)

    if running_count() >= MAX_PROCESSES:
        raise ValueError(
            f"Too many processes are running ({MAX_PROCESSES}). Stop one with stop_process first."
        )

    record = start_process(text, work_dir)
    audit("run_command", f"#{record['id']} {text} (cwd {rel(work_dir)})")

    idle = int(idle_timeout or (DEFAULT_IDLE_TIMEOUT if background else 0))
    reason = watch(record, limit, idle, wait_for)
    if reason != "exited" and not background:
        kill_tree(record)  # synchronous commands never survive the call

    took = int(time.time() - record["started"])
    output = read_log(record["log"])
    record["read"] = log_size(record["log"])

    if reason == "exited":
        record["announced"] = True
        head = f"Finished #{record['id']} with exit code {record['exitCode']} in {took}s."
    elif background:
        why = {
            "matched": f"wait_for matched after {took}s",
            "idle": f"output went quiet after {took}s",
            "timeout": f"still running after {took}s",
        }[reason]
        head = (
            f"Started #{record['id']} in the background (pid {record['pid']}); {why}. "
            f"It keeps running - use check_process(id={record['id']}) or stop_process."
        )
    else:
        record["announced"] = True
        head = (
            f"Timed out after {took}s and the process tree was killed (#{record['id']}). "
            "Use background=True for commands that are supposed to keep running."
        )

    body = output.strip() or "(no output)"
    return clamp(
        f"{head}\n$ {text}\ncwd: {rel(work_dir)}\nlog: {rel(record['log'])}\n\n{body}"
    )


@mcp.tool()
def list_processes() -> str:
    """List commands started by this server: running and recently finished."""
    refresh_processes()
    with PROCESS_LOCK:
        records = sorted(PROCESSES.values(), key=lambda item: item["id"])
    if not records:
        return "No commands have been started in this session."
    return "Processes:\n" + "\n".join(process_line(record) for record in records)


@mcp.tool()
def check_process(id: int, lines: int = 50, wait: int = 0, wait_for: str = "") -> str:
    """Show the state and recent output of a command started earlier.

    Args:
        id: Process number reported by run_command.
        lines: How many trailing log lines to return.
        wait: Seconds to wait for the process to finish or produce output.
        wait_for: Regex; stop waiting once it appears in the output.
    """
    record = find_process(id)
    if wait and record["status"] == "running":
        watch(record, max(1, min(int(wait), COMMAND_TIMEOUT_CAP)), 0, wait_for)
        refresh_processes()

    tail = read_log(record["log"]).splitlines()
    count = max(1, min(int(lines), 500))
    body = "\n".join(tail[-count:]) or "(no output yet)"
    record["announced"] = record["status"] != "running"
    return clamp(
        f"{process_line(record).strip()}\ncwd: {record['cwd']}\n"
        f"showing last {min(count, len(tail))} of {len(tail)} lines\n\n{body}"
    )


@mcp.tool()
def stop_process(id: int = 0, stop_all: bool = False) -> str:
    """Stop a running command together with its child processes.

    Args:
        id: Process number to stop. Ignored when stop_all is True.
        stop_all: Stop every running process instead of a single one.
    """
    guard_write()
    if stop_all:
        refresh_processes()
        with PROCESS_LOCK:
            running = [item for item in PROCESSES.values() if item["status"] == "running"]
        if not running:
            return "Nothing to stop: no running processes."
        for record in running:
            kill_tree(record)
            record["announced"] = True
        audit("stop_process", f"stopped {len(running)} processes")
        return f"Stopped {len(running)} process(es)."

    record = find_process(id)
    if record["status"] != "running":
        return f"#{record['id']} is not running ({record['status']}, exit {record['exitCode']})."
    kill_tree(record)
    record["announced"] = True
    audit("stop_process", f"#{record['id']} {record['command']}")
    return f"Stopped #{record['id']} ({record['command']}). Log: {rel(record['log'])}"


# ----------------------------------------------------------- desktop dialog ---


@mcp.tool(name="show-dialog-box")
async def show_dialog_box() -> str:
    """Open a desktop input dialog on the machine running this MCP server.

    Return the user's message; empty input or Escape ends the dialog.
    The expand/collapse icon toggles a compact window and a full-height right-hand panel.
    On timeout, call again to wait for the same window (no duplicate dialogs).
    Requires an interactive desktop session and Python with Tkinter.
    """
    # import_module supports the hyphenated filename and caches one GUI session.
    from importlib import import_module
    dialog = import_module("dialog-box")
    return await dialog.wait_for_dialog(CONFIG.get("dialog", {}))


# ---------------------------------------------------------------- browser ---

# Replaces "npx @browsermcp/mcp": the Browser MCP extension connects to
# ws://localhost:9009 once "Connect" is pressed on a tab, and this server plays
# the part of that npx process. Wire format, taken from @browsermcp/mcp:
#   request : {"id": "<uuid>", "type": "browser_click", "payload": {...}}
#   response: {"type": "messageResponse",
#              "payload": {"requestId": "<uuid>", "result": ... | "error": "..."}}
# The extension only talks to a local port, which is why a stdio MCP cannot be
# used by cloud agents, while this HTTP server can relay for them.

BROWSER_NO_TAB = (
    "No connection to the browser extension. Open the tab to automate, click the "
    "Browser Control (or Browser MCP) extension icon in the browser toolbar and press "
    "'Connect', then retry. Or call browser_launch to open a Chrome window for the agent "
    "that connects by itself (Browser Control 1.1.0+)."
)
BROWSER_EXTENSION_NO_TAB = "No tab is connected"

# browser_launch opens http://<host>:<port>/bc-launch#<token>. The token sits
# in the fragment, so it never reaches this server in an HTTP request or a log;
# Browser Control reads it from the tab URL and sends it back on the WebSocket
# (?launch=<token>). While an agent session holds the bridge, connections
# without the token are refused, so another browser window or profile with the
# extension cannot take the bridge over ("new connection replaces the old one").
LAUNCH_PAGE_PATH = "/bc-launch"
CLOSE_BAD_TOKEN = 4403   # unknown or expired launch token
CLOSE_AGENT_BUSY = 4409  # an agent session owns the bridge
LAUNCH_PAGE_HTML = (
    "<!doctype html><meta charset=utf-8><title>Browser Control: agent session</title>"
    "<body style=\"font:15px system-ui;margin:3em;color:#444\">"
    "<h3>Local Access: connecting the agent's tab...</h3>"
    "<p>Browser Control picks this tab up by itself; no Connect click is needed. "
    "If nothing happens, check that the extension (1.1.0+) is installed and enabled.</p>"
)


def describe_listen_error(exc: BaseException, port: int) -> str:
    if isinstance(exc, ImportError):
        return "the websockets package is missing; run: pip install -r requirements.txt"
    if isinstance(exc, OSError) and exc.errno in {48, 98, 10048}:
        return (
            f"port {port} is busy - most likely another Browser MCP server "
            "(npx @browsermcp/mcp, e.g. started by Claude Code) is running. Close it and retry."
        )
    return f"cannot listen on port {port}: {exc}"


class BrowserBridge:
    """WebSocket server for the extension on a private event-loop thread.

    uvicorn owns the main loop; a separate loop keeps the bridge independent
    of it, and tool calls hop over with run_coroutine_threadsafe. A new
    extension connection replaces the old one, as in @browsermcp/mcp.
    """

    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.loop: asyncio.AbstractEventLoop | None = None
        self.server = None
        self.ws = None
        self.connected_at = 0.0
        self.pending: dict[str, tuple[asyncio.Future, object]] = {}
        self.error = ""
        self.lock = threading.Lock()
        # Agent browser session (browser_launch): token, process, mode, ...
        self.launch: dict | None = None
        self.ws_launch = False  # the current connection carries the launch token

    # -- lifecycle, called from any thread ---------------------------------

    def start(self) -> bool:
        """Listen on the port once; a failed attempt is retried on the next call."""
        with self.lock:
            if self.server is not None:
                return True
            if self.loop is None:
                self.loop = asyncio.new_event_loop()
                threading.Thread(
                    target=self.loop.run_forever, name="browser-bridge", daemon=True
                ).start()
            future = asyncio.run_coroutine_threadsafe(self._listen(), self.loop)
            try:
                future.result(timeout=15)
            except BaseException as exc:  # noqa: BLE001 - reported to the model
                self.error = describe_listen_error(exc, self.port)
                return False
            self.error = ""
            return True

    def connected(self) -> bool:
        return self.ws is not None

    async def call(self, kind: str, payload=None, timeout: int | None = None):
        """Send one request to the extension and return its result."""
        if not BROWSER["enabled"]:
            raise ValueError(f'Browser tools are disabled ("browser.enabled": false in {CONFIG_PATH.name}).')
        if not self.start():
            raise ValueError(f"Browser bridge is not running: {self.error}")
        request = self._request(kind, payload, timeout or BROWSER["timeout"])
        try:
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(request, self.loop))
        except RuntimeError as exc:
            message = str(exc)
            if message == BROWSER_EXTENSION_NO_TAB:
                message = BROWSER_NO_TAB
            raise ValueError(message) from None

    # -- bridge loop --------------------------------------------------------

    async def _listen(self) -> None:
        extra = {}
        try:
            from websockets.asyncio.server import serve  # websockets >= 13
            extra["process_request"] = self._process_request
        except ImportError:
            from websockets import serve  # older releases: no launch page, the tab shows an HTTP error but still connects
        self.server = await serve(
            self._handle,
            self.host,
            self.port,
            max_size=BROWSER_MAX_MESSAGE,
            ping_interval=20,
            ping_timeout=20,
            **extra,
        )

    @staticmethod
    def _process_request(connection, request):
        """Serve the small browser_launch page; everything else is a WebSocket handshake."""
        path = str(getattr(request, "path", "") or "").split("?", 1)[0].rstrip("/")
        if path != LAUNCH_PAGE_PATH:
            return None
        from http import HTTPStatus
        response = connection.respond(HTTPStatus.OK, LAUNCH_PAGE_HTML)
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = "text/html; charset=utf-8"
        response.headers["Cache-Control"] = "no-store"
        return response

    @staticmethod
    def _launch_params(ws, rest) -> tuple[str, bool]:
        """(token, probe) from the connection path ?launch=<token>[&probe=1]."""
        request = getattr(ws, "request", None)
        path = getattr(request, "path", None) or getattr(ws, "path", None)
        if not path and rest and isinstance(rest[0], str):
            path = rest[0]
        query = str(path or "").partition("?")[2]
        from urllib.parse import parse_qs
        params = parse_qs(query)
        token = (params.get("launch") or [""])[0]
        return token, (params.get("probe") or [""])[0] == "1"

    def launch_alive(self) -> bool:
        """An agent session still holds the bridge (not released, its Chrome not gone)."""
        launch = self.launch
        if not launch or launch.get("released"):
            return False
        process = launch.get("process")
        if launch.get("mode") == "own" and process is not None and process.poll() is not None:
            return False
        return True

    def launch_connected(self) -> bool:
        return self.ws is not None and self.ws_launch and self.launch is not None

    def _admit(self, token: str) -> tuple[int, str] | None:
        """None to accept the connection, or the (code, reason) to close it with."""
        launch = self.launch
        if token:
            if launch and secrets.compare_digest(token, str(launch.get("token") or "")):
                return None
            return CLOSE_BAD_TOKEN, "unknown or expired launch token"
        if self.launch_alive():
            return CLOSE_AGENT_BUSY, "an agent browser session (browser_launch) owns the bridge"
        return None

    async def _handle(self, ws, *rest) -> None:
        token, probe = self._launch_params(ws, rest)
        refusal = self._admit(token)
        if probe:
            # Browser Control checks a launch token before switching tabs; a
            # probe never replaces the current connection.
            try:
                if refusal is None and token:
                    await ws.send(json.dumps({"type": "launchAccepted"}))
                    await ws.close(1000, "probe done")
                else:
                    await ws.close(CLOSE_BAD_TOKEN, "unknown or expired launch token")
            except Exception:
                pass
            return
        if refusal is not None:
            try:
                await ws.close(*refusal)
            except Exception:
                pass
            return
        previous, self.ws = self.ws, ws
        self.ws_launch = bool(token)
        self.connected_at = time.time()
        if token and self.launch is not None:
            self.launch["connected"] = True
            self.launch["released"] = False
        audit("browser", "extension connected" + (" (agent session)" if token else ""))
        if previous is not None:
            try:
                await previous.close()
            except Exception:
                pass
        try:
            async for raw in ws:
                self._dispatch(raw)
        except Exception:
            pass
        finally:
            if self.ws is ws:
                self.ws = None
                self.ws_launch = False
                audit("browser", "extension disconnected")
            # A clean close (Disconnect, the agent's tab closed) ends the lock:
            # manual Connect works again. A dropped link (service-worker
            # restart) keeps it, the extension comes back with the token.
            # Only when no newer connection took over, and only for the
            # current session's token (not one left over from an older launch).
            launch = self.launch
            if (token and launch is not None and self.ws is None
                    and getattr(ws, "close_code", None) == 1000
                    and secrets.compare_digest(token, str(launch.get("token") or ""))):
                launch["released"] = True
            for request_id, (future, owner) in list(self.pending.items()):
                if owner is ws and not future.done():
                    future.set_exception(RuntimeError(BROWSER_NO_TAB))
                    self.pending.pop(request_id, None)

    def _dispatch(self, raw) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(message, dict) or message.get("type") != "messageResponse":
            return
        payload = message.get("payload") or {}
        entry = self.pending.pop(str(payload.get("requestId")), None)
        if entry is None or entry[0].done():
            return
        if payload.get("error"):
            entry[0].set_exception(RuntimeError(str(payload["error"])))
        else:
            entry[0].set_result(payload.get("result"))

    async def _request(self, kind: str, payload, timeout: int):
        ws = self.ws
        if ws is None:
            raise RuntimeError(BROWSER_NO_TAB)
        request_id = secrets.token_hex(16)
        message: dict = {"id": request_id, "type": kind}
        if payload is not None:  # getUrl / getTitle are sent without a payload
            message["payload"] = payload
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = (future, ws)
        try:
            try:
                await ws.send(json.dumps(message))
            except Exception:
                raise RuntimeError(BROWSER_NO_TAB) from None
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"The browser extension did not answer {kind} within {timeout}s."
            ) from None
        finally:
            self.pending.pop(request_id, None)


BRIDGE = BrowserBridge(BROWSER["host"], BROWSER["port"])


def navigation_refusal(url) -> str:
    """Why the server refuses to open a URL in the tab, or "".

    Mirrors Browser Control 1.0.3, so an older extension (or Browser MCP)
    cannot be used to step outside the sandbox through the browser.
    """
    value = str(url or "").strip().lower()
    if value.startswith("javascript:"):
        return "javascript: URLs replace the page with their result; use browser_evaluate to run code in the page."
    if value.startswith("file:") and not BROWSER["allowFileUrls"]:
        return (
            "file:// pages would show the AI any file of this computer, outside rootDir and "
            f'its deny rules. The owner can allow them with "browser.allowFileUrls": true in {CONFIG_PATH.name}.'
        )
    return ""


def guard_browser_action() -> None:
    if READ_ONLY:
        raise ValueError(
            "Server is running in READ_ONLY mode; browser actions and diagnostic "
            "start/stop/clear operations are disabled. Reading diagnostics is allowed."
        )


async def page_snapshot(status: str = "") -> str:
    """URL, title and the ARIA snapshot with element refs, as @browsermcp/mcp does."""
    url = await BRIDGE.call("getUrl")
    title = await BRIDGE.call("getTitle")
    snapshot = await BRIDGE.call("browser_snapshot", {})
    head = f"{status}\n" if status else ""
    return clamp(
        f"{head}\n- Page URL: {url}\n- Page Title: {title}\n- Page Snapshot\n"
        f"```yaml\n{snapshot}\n```\n"
    )


@mcp.tool()
async def browser_status() -> str:
    """Show whether the browser extension (Browser Control or Browser MCP) is connected, with tab/debugger health."""
    if not BROWSER["enabled"]:
        return f'Browser tools are disabled ("browser.enabled": false in {CONFIG_PATH.name}).'
    if not BRIDGE.start():
        return f"Browser bridge is not running: {BRIDGE.error}"
    where = f"ws://{BROWSER['host']}:{BROWSER['port']}"
    agent = launch_summary(BRIDGE.launch)
    if not BRIDGE.connected():
        return f"Listening on {where}; no tab connected; {agent}. {BROWSER_NO_TAB}"
    age = int(time.time() - BRIDGE.connected_at)
    try:
        diagnostic = await BRIDGE.call("browser_diagnostics", {}, timeout=5)
    except Exception as exc:
        return (f"Listening on {where}; WebSocket connected ({age}s ago); {agent}, "
                f"but tab/debugger diagnostics are unavailable: {exc}")
    return (f"Listening on {where}; WebSocket connected ({age}s ago); {agent}.\n"
            + json.dumps(diagnostic, ensure_ascii=False))


# ------------------------------------------------- agent browser session ---


def find_chrome() -> str:
    """Chrome binary for browser_launch: browser.chromePath, else the usual places."""
    configured = BROWSER["chromePath"]
    if configured:
        if Path(configured).is_file():
            return configured
        raise ValueError(f'"browser.chromePath" in {CONFIG_PATH.name} does not point to a file: {configured}')
    candidates: list[str] = []
    if IS_WINDOWS:
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as key:
                        candidates.append(str(winreg.QueryValue(key, None)))
                except OSError:
                    pass
        except ImportError:
            pass
        for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates.append(str(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"))
    elif sys.platform == "darwin":
        app = "Google Chrome.app/Contents/MacOS/Google Chrome"
        candidates += [f"/Applications/{app}", str(Path.home() / "Applications" / app)]
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                candidates.append(found)
    for candidate in candidates:
        if candidate and Path(candidate.strip('"')).is_file():
            return candidate.strip('"')
    raise ValueError(
        f'Chrome was not found. Set "browser.chromePath" in {CONFIG_PATH.name} to the chrome executable.'
    )


def end_process_tree(process: subprocess.Popen, force: bool) -> None:
    """Ask (force=False) or make (force=True) the Chrome that browser_launch started exit.

    Only ever the Popen this server created: its handle pins the PID, so a
    reused PID of someone else's process cannot be hit.
    """
    if process.poll() is not None:
        return
    if IS_WINDOWS:
        # Without /F taskkill sends WM_CLOSE: Chrome shuts down cleanly and
        # keeps the session for "Continue where you left off".
        command = ["taskkill", "/PID", str(process.pid), "/T"] + (["/F"] if force else [])
        subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=False)
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.killpg(process.pid, sig)  # start_new_session: the group is Chrome's own
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill() if force else process.terminate()
        except OSError:
            pass


async def wait_process_exit(process: subprocess.Popen, seconds: float) -> bool:
    deadline = time.monotonic() + max(0.0, seconds)
    while process.poll() is None:
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.25)
    return True


def launch_summary(launch: dict | None) -> str:
    if not launch:
        return "no agent browser session"
    process = launch.get("process")
    alive = process is not None and process.poll() is None
    mode = {
        "own": f"Chrome started by the agent (PID {launch.get('pid')}, {'running' if alive else 'exited'})",
        "shared": "a window in the owner's already running Chrome",
    }.get(str(launch.get("mode")), "starting")
    state = "connected" if BRIDGE.launch_connected() else ("released" if launch.get("released") else "not connected")
    return f"agent browser session: {mode}; tab {state}"


@mcp.tool()
async def browser_launch(url: str = "") -> str:
    """Open Chrome for the agent and connect Browser Control to its tab, no Connect click needed.

    Uses the owner's normal Chrome profile, so sites the owner is signed in to
    stay signed in. Chrome is started with --silent-debugger-extension-api.
    - Chrome not running yet: the agent owns that Chrome; browser_close ends it by PID.
    - Chrome already running: a new tab opens in the owner's last active window
      (Chrome makes it the active tab); the flag only works if the owner started
      Chrome with it too, and browser_close closes only the agent's tab, never
      the owner's browser.
    The tab keeps working when the window is minimized or another tab is active.
    The extension must already be installed by the owner; nothing is installed here.
    url: page to open once connected (optional). Returns the page snapshot.
    """
    guard_browser_action()
    if not BROWSER["enabled"]:
        raise ValueError(f'Browser tools are disabled ("browser.enabled": false in {CONFIG_PATH.name}).')
    url = str(url or "").strip()
    refusal = navigation_refusal(url) if url else ""
    if refusal:
        raise ValueError(refusal)
    if not BRIDGE.start():
        raise ValueError(f"Browser bridge is not running: {BRIDGE.error}")

    previous = BRIDGE.launch
    if previous and BRIDGE.launch_connected():
        if url:
            await BRIDGE.call("browser_navigate", {"url": url})
            audit("browser_navigate", url)
        return await page_snapshot("The agent browser session is already open; reused its tab.")
    # An agent Chrome from an earlier launch that is still running stays ours:
    # the new start is handed over to it, so browser_close may still end it.
    kept = None
    if previous and previous.get("mode") == "own":
        process = previous.get("process")
        if process is not None and process.poll() is None:
            kept = process

    chrome = find_chrome()
    token = secrets.token_urlsafe(24)
    page_host = BROWSER["host"] if BROWSER["host"] not in ("", "0.0.0.0", "::") else "127.0.0.1"
    launch_url = f"http://{page_host}:{BROWSER['port']}{LAUNCH_PAGE_PATH}#{token}"
    args = [chrome, BROWSER_SILENT_FLAG]
    if BROWSER["userDataDir"]:
        args.append(f"--user-data-dir={BROWSER['userDataDir']}")
    if BROWSER["profileDirectory"]:
        args.append(f"--profile-directory={BROWSER['profileDirectory']}")
    # No --new-window: in a running Chrome the page opens as a new tab of the
    # last active window, the way the owner asked for.
    args += BROWSER["launchArgs"] + [launch_url]

    options: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                     "stderr": subprocess.DEVNULL, "close_fds": True}
    if IS_WINDOWS:
        # Detached: Chrome outlives the server and ignores its console's Ctrl+C.
        options["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    launch = {"token": token, "process": None, "pid": None, "mode": "starting",
              "started": time.time(), "connected": False, "released": False}
    BRIDGE.launch = launch  # set before the start, so the connection is admitted
    try:
        process = subprocess.Popen(args, **options)
    except OSError as exc:
        BRIDGE.launch = None
        raise ValueError(f"Cannot start Chrome ({chrome}): {exc}") from None
    launch["process"], launch["pid"] = process, process.pid

    deadline = time.monotonic() + BROWSER["launchTimeout"]
    while not launch["connected"]:
        if time.monotonic() >= deadline:
            launch["mode"] = "own" if process.poll() is None else "shared"
            if kept is not None and launch["mode"] == "shared":
                launch.update(mode="own", process=kept, pid=kept.pid)
            launch["released"] = True  # do not keep manual Connect locked out
            audit("browser_launch", f"no connection in {BROWSER['launchTimeout']}s", ok=False)
            raise ValueError(
                f"Chrome was started, but Browser Control did not connect within "
                f"{BROWSER['launchTimeout']}s. Check that the extension (1.1.0 or newer) is "
                f"installed and enabled in this Chrome profile and uses port {BROWSER['port']}. "
                "browser_close can end what was started."
            )
        await asyncio.sleep(0.2)

    # A start handed over to an already running Chrome exits at once; a Chrome
    # that was not running keeps this process as its browser process.
    if process.poll() is None:
        launch["mode"] = "own"
    elif kept is not None:
        launch.update(mode="own", process=kept, pid=kept.pid)
    else:
        launch["mode"] = "shared"
    audit("browser_launch", f"{launch['mode']} pid {launch['pid']}")
    if launch["mode"] == "own":
        status = (f"Chrome started for the agent (PID {launch['pid']}), tab connected. "
                  "Call browser_close when done.")
    else:
        status = ("Chrome was already running: opened a new tab in the owner's browser and "
                  "connected it. The debugging bar is hidden only if that Chrome was started "
                  f"with {BROWSER_SILENT_FLAG}. browser_close closes only this tab.")
    if url:
        await BRIDGE.call("browser_navigate", {"url": url})
        audit("browser_navigate", url)
    return await page_snapshot(status)


@mcp.tool()
async def browser_close(force: bool = False) -> str:
    """Close the agent's tab opened by browser_launch; end Chrome by PID if the agent started it.

    Never touches a Chrome the owner had running before browser_launch: there
    only the agent's tab is closed. When the agent started Chrome and other
    tabs are open in it (the owner may be using them), Chrome is left running
    unless force=True.
    """
    guard_browser_action()
    launch = BRIDGE.launch
    if not launch:
        raise ValueError("Nothing to close: browser_close only closes what browser_launch opened during this server run.")
    notes: list[str] = []
    report = None
    if BRIDGE.launch_connected():
        try:
            report = await BRIDGE.call("browser_close_tab", {}, timeout=10)
            notes.append("closed the agent's tab")
        except Exception as exc:  # noqa: BLE001 - reported to the model
            notes.append(f"could not close the agent's tab: {exc}")
    else:
        notes.append("the agent's tab was not connected any more (closed already?)")
    others = report.get("remainingTabs") if isinstance(report, dict) else None

    process = launch.get("process")
    if launch.get("mode") != "own" or process is None:
        BRIDGE.launch = None
        audit("browser_close", "tab only (owner's Chrome)")
        return "; ".join(notes) + ". Chrome was already running before browser_launch, so it was left alone."
    if process.poll() is not None:
        BRIDGE.launch = None
        audit("browser_close", f"pid {launch.get('pid')} already exited")
        return "; ".join(notes) + f". Chrome (PID {launch.get('pid')}) has already exited."
    if not force and others != 0:
        launch["released"] = True
        why = (f"{others} other tab(s) are open in it" if others
               else "it is unknown whether other tabs are open in it")
        audit("browser_close", f"pid {launch.get('pid')} left running")
        return ("; ".join(notes) + f". Chrome (PID {launch.get('pid')}) was left running: {why}. "
                "Call browser_close(force=True) to end it anyway.")

    # The last tab is gone: Chrome usually exits by itself (not on macOS).
    exited = await wait_process_exit(process, BROWSER["closeTimeout"] if report else 0)
    how = "exited by itself"
    if not exited:
        await asyncio.to_thread(end_process_tree, process, False)
        exited, how = await wait_process_exit(process, 5), "asked to exit by PID"
    if not exited:
        await asyncio.to_thread(end_process_tree, process, True)
        exited, how = await wait_process_exit(process, 5), "terminated by PID"
    BRIDGE.launch = None
    audit("browser_close", f"pid {launch.get('pid')} {how}", ok=exited)
    if not exited:
        return "; ".join(notes) + f". Chrome (PID {launch.get('pid')}) did not exit even after a forced stop."
    return "; ".join(notes) + f". Chrome (PID {launch.get('pid')}) {how}."


@mcp.tool()
async def browser_navigate(url: str) -> str:
    """Navigate the connected tab to a URL and return the page snapshot.

    Args:
        url: The URL to navigate to.
    """
    guard_browser_action()
    refusal = navigation_refusal(url)
    if refusal:
        raise ValueError(f"Refusing to open {str(url).strip()[:100]}: {refusal}")
    await BRIDGE.call("browser_navigate", {"url": url})
    audit("browser_navigate", url)
    return await page_snapshot()


@mcp.tool()
async def browser_go_back() -> str:
    """Go back to the previous page and return the page snapshot."""
    guard_browser_action()
    await BRIDGE.call("browser_go_back", {})
    return await page_snapshot()


@mcp.tool()
async def browser_go_forward() -> str:
    """Go forward to the next page and return the page snapshot."""
    guard_browser_action()
    await BRIDGE.call("browser_go_forward", {})
    return await page_snapshot()


@mcp.tool()
async def browser_wait(time: float) -> str:
    """Wait for a specified time in seconds (at most 60).

    Args:
        time: The time to wait in seconds.
    """
    seconds = float(time)
    if not 0 <= seconds <= BROWSER_MAX_WAIT:
        raise ValueError(f"time must be finite and between 0 and {BROWSER_MAX_WAIT} seconds")
    await asyncio.sleep(seconds)
    return f"Waited for {seconds:g} seconds"


@mcp.tool()
async def browser_press_key(key: str) -> str:
    """Press a key on the keyboard in the connected tab.

    Args:
        key: Name of the key to press or a character to generate, such as `ArrowLeft` or `a`.
    """
    guard_browser_action()
    await BRIDGE.call("browser_press_key", {"key": key})
    audit("browser_press_key", key)
    return f"Pressed key {key}"


@mcp.tool()
async def browser_snapshot() -> str:
    """Capture accessibility snapshot of the current page.

    Use this for getting references (ref) to elements to interact with.
    """
    return await page_snapshot()


@mcp.tool()
async def browser_click(element: str, ref: str) -> str:
    """Perform click on a web page and return the new snapshot.

    Args:
        element: Human-readable element description used to obtain permission to interact with the element.
        ref: Exact target element reference from the page snapshot.
    """
    guard_browser_action()
    await BRIDGE.call("browser_click", {"element": element, "ref": ref})
    audit("browser_click", f"{element} [{ref}]")
    return await page_snapshot(f'Clicked "{element}"')


@mcp.tool()
async def browser_drag(start_element: str, start_ref: str, end_element: str, end_ref: str) -> str:
    """Perform drag and drop between two elements and return the new snapshot.

    Args:
        start_element: Human-readable source element description.
        start_ref: Exact source element reference from the page snapshot.
        end_element: Human-readable target element description.
        end_ref: Exact target element reference from the page snapshot.
    """
    guard_browser_action()
    await BRIDGE.call(
        "browser_drag",
        {
            "startElement": start_element,
            "startRef": start_ref,
            "endElement": end_element,
            "endRef": end_ref,
        },
    )
    audit("browser_drag", f"{start_element} -> {end_element}")
    return await page_snapshot(f'Dragged "{start_element}" to "{end_element}"')


@mcp.tool()
async def browser_hover(element: str, ref: str) -> str:
    """Hover over element on page and return the new snapshot.

    Args:
        element: Human-readable element description used to obtain permission to interact with the element.
        ref: Exact target element reference from the page snapshot.
    """
    guard_browser_action()
    await BRIDGE.call("browser_hover", {"element": element, "ref": ref})
    return await page_snapshot(f'Hovered over "{element}"')


@mcp.tool()
async def browser_type(element: str, ref: str, text: str, submit: bool = False) -> str:
    """Type text into editable element and return the new snapshot.

    Args:
        element: Human-readable element description used to obtain permission to interact with the element.
        ref: Exact target element reference from the page snapshot.
        text: Text to type into the element.
        submit: Whether to submit entered text (press Enter after).
    """
    guard_browser_action()
    await BRIDGE.call(
        "browser_type", {"element": element, "ref": ref, "text": text, "submit": bool(submit)}
    )
    # The typed text itself is not logged: it may be a password.
    audit("browser_type", f"{element} [{ref}] ({len(text)} chars{', submit' if submit else ''})")
    return await page_snapshot(f'Typed {len(text)} characters into "{element}"')


@mcp.tool()
async def browser_select_option(element: str, ref: str, values: list[str]) -> str:
    """Select an option in a dropdown and return the new snapshot.

    Args:
        element: Human-readable element description used to obtain permission to interact with the element.
        ref: Exact target element reference from the page snapshot.
        values: Values to select in the dropdown: one value or several.
    """
    guard_browser_action()
    await BRIDGE.call(
        "browser_select_option", {"element": element, "ref": ref, "values": list(values)}
    )
    audit("browser_select_option", f"{element} [{ref}]")
    return await page_snapshot(f'Selected option in "{element}"')


@mcp.tool()
async def browser_screenshot() -> Image:
    """Take a screenshot of the current page."""
    data = str(await BRIDGE.call("browser_screenshot", {}) or "")
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    try:
        return Image(data=base64.b64decode(data), format="png")
    except (ValueError, TypeError) as exc:
        raise ValueError(f"The extension returned an unreadable screenshot: {exc}") from None


@mcp.tool()
async def browser_get_console_logs() -> str:
    """Get the console logs from the connected tab."""
    logs = await BRIDGE.call("browser_get_console_logs", {})
    if not logs:
        return "(no console messages)"
    if not isinstance(logs, list):
        logs = [logs]
    return clamp("\n".join(json.dumps(item, ensure_ascii=False) for item in logs))


# Local Access diagnostics v1: requires the companion unpacked extension.
@mcp.tool()
async def browser_diagnostics() -> str:
    """Probe the selected tab's debugger and Runtime/Log subscriptions; report gaps and buffers."""
    result = await BRIDGE.call("browser_diagnostics", {})
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def browser_console(limit: int = 100, level: str = "all", clear: bool = False) -> str:
    """Read structured console/exception/browser logs, or explicitly clear their in-memory buffer.

    Args:
        limit: Maximum messages, 1..500.
        level: all, error, warning, info, log, debug, exception, navigation, or diagnostic.
        clear: Clear captured console messages before returning. Requires writable mode.
    """
    if not 1 <= limit <= 500:
        raise ValueError("limit must be 1..500")
    if level not in {"all", "error", "warning", "info", "log", "debug", "exception", "navigation", "diagnostic"}:
        raise ValueError("Unsupported console level")
    if clear:
        guard_browser_action()
    result = await BRIDGE.call("browser_console", {"limit": limit, "level": level, "clear": clear})
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def browser_network(action: str = "list", request_id: str = "", limit: int = 50,
                          part: str = "response", max_chars: int = 16384) -> str:
    """Opt-in bounded network diagnostics for the selected tab. No automatic body retrieval.

    Args:
        action: start, stop, clear, list, detail, or body. Capture is off by default.
        request_id: Opaque ID returned by list, required for detail/body.
        limit: Number of recent requests in list, 1..300.
        part: request or response for body. Binary/expired bodies are not returned.
        max_chars: Maximum returned body characters, 1..65536.

    Query values and most headers are redacted; bodies use best-effort redaction,
    NOT guaranteed anonymization. Use body only when needed for the user's task.
    """
    if action not in {"start", "stop", "clear", "list", "detail", "body"}:
        raise ValueError("Invalid network action")
    if not 1 <= limit <= 300 or not 1 <= max_chars <= 65536:
        raise ValueError("limit must be 1..300 and max_chars 1..65536")
    if part not in {"request", "response"}:
        raise ValueError("part must be request or response")
    if action in {"detail", "body"} and not request_id:
        raise ValueError("request_id is required; list captured requests first")
    if action in {"start", "stop", "clear"}:
        guard_browser_action()
    result = await BRIDGE.call("browser_network", {"action": action, "request_id": request_id,
                              "limit": limit, "part": part, "max_chars": max_chars})
    audit("browser_network", action)  # Never log headers, URLs, or returned bodies.
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def browser_capture(mode: str = "viewport", scale: str = "original") -> Image:
    """Capture a PNG of the viewport or full web page, not Chrome UI/DevTools.

    Args:
        mode: viewport or full_page.
        scale: original (no forced downscaling) or reduced (fit within 1024x768).
    """
    if mode not in {"viewport", "full_page"} or scale not in {"original", "reduced"}:
        raise ValueError("Invalid screenshot mode/scale")
    data = await BRIDGE.call("browser_capture", {"mode": mode, "scale": scale})
    if not isinstance(data, str) or len(data) > 32000000:
        raise ValueError("Invalid/oversized screenshot payload")
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Unreadable screenshot payload: {exc}") from None
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("The extension did not return a PNG image")
    return Image(data=raw, format="png")


# DevTools protocol access: requires the Browser Control extension (extension/).
# In READ_ONLY mode only CDP methods that read (get*/describe*/query*/search*/
# resolve*) are allowed; evaluate and event subscriptions are actions.
CDP_METHOD_RE = re.compile(r"^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$")
CDP_READ_RE = re.compile(r"^[A-Z][A-Za-z0-9]*\.(get|describe|query|search|resolve)[A-Za-z0-9]*$")
# Refused whatever the mode, also when READ_ONLY lets get* through: they reach
# other sites, the whole browser or the local disk. Browser Control >= 1.0.3
# refuses them as well; the copy here protects against older extensions.
CDP_DENIED_DOMAINS = {"Browser", "Target", "SystemInfo", "Tethering", "Extensions", "PWA"}
CDP_DENIED_METHODS = {
    "Network.getAllCookies": "returns the cookies of every site in the browser",
    "Network.clearBrowserCookies": "deletes the cookies of every site in the browser",
    "Network.clearBrowserCache": "clears the cache of the whole browser",
    "Network.loadNetworkResource": "loads any URL of any site, intranet or localhost past CORS",
    "Storage.getCookies": "returns the cookies of every site in the browser",
    "Storage.setCookies": "writes cookies of any site in the browser",
    "Storage.clearCookies": "deletes the cookies of every site in the browser",
    "Storage.clearDataForOrigin": "wipes storage of an arbitrary origin",
    "Storage.clearDataForStorageKey": "wipes storage of an arbitrary origin",
    "Page.close": "closes the tab",
    "Page.crash": "crashes the renderer",
}


def cdp_refusal(method: str, params: dict) -> str:
    """Why the server refuses a CDP command, or ""."""
    domain = method.split(".", 1)[0]
    if domain in CDP_DENIED_DOMAINS:
        return f"the {domain} domain reaches beyond the connected tab"
    if method in CDP_DENIED_METHODS:
        return CDP_DENIED_METHODS[method]
    if method == "Network.getCookies" and "urls" in params:
        return "the urls parameter reads cookies of any site; call it without urls to get the cookies of this page"
    if method == "Page.navigate":
        reason = navigation_refusal(params.get("url", ""))
        if reason:
            return reason
    return ""


@mcp.tool()
async def browser_cdp(method: str, params: dict | None = None) -> str:
    """Send one Chrome DevTools Protocol command to the connected tab and return its JSON result.

    Use it for what other browser_* tools do not cover, e.g. DOM.getDocument,
    CSS.getComputedStyleForNode, Performance.getMetrics, Emulation.setDeviceMetricsOverride,
    Network.getCookies. Browser.*, Target.* and other cross-tab domains are refused,
    as are Runtime/Log/Page.disable (they would stop console capture), browser-wide
    cookie/storage methods, Network.loadNetworkResource, cookies or storage of other
    sites, and Page.navigate to chrome://, javascript: or file:// pages.

    Args:
        method: CDP method, Domain.command, e.g. "DOM.getDocument".
        params: CDP parameters object, e.g. {"depth": 2}. Omit for none.
    """
    if not CDP_METHOD_RE.match(method or ""):
        raise ValueError("method must look like Domain.command, e.g. DOM.getDocument")
    if params is not None and not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    refusal = cdp_refusal(method, params or {})
    if refusal:
        raise ValueError(f"{method} is not allowed: {refusal}")
    if READ_ONLY and not CDP_READ_RE.match(method):
        raise ValueError(
            "Server is running in READ_ONLY mode; only reading CDP methods "
            "(get*, describe*, query*, search*, resolve*) are allowed."
        )
    result = await BRIDGE.call("browser_cdp", {"method": method, "params": params or {}})
    audit("browser_cdp", method)  # params may hold page data: not logged
    return clamp(json.dumps(result, ensure_ascii=False))


@mcp.tool()
async def browser_evaluate(expression: str, await_promise: bool = True) -> str:
    """Run JavaScript in the connected tab (like the DevTools console) and return the result.

    Top-level await works. The value comes back as JSON when serializable,
    otherwise as a description; exceptions are returned, not raised.

    Args:
        expression: JavaScript to evaluate in the page, e.g. "document.title".
        await_promise: Wait for a returned Promise to settle.
    """
    guard_browser_action()
    if not (expression or "").strip():
        raise ValueError("expression is required")
    result = await BRIDGE.call(
        "browser_evaluate", {"expression": expression, "awaitPromise": bool(await_promise)}
    )
    audit("browser_evaluate", f"{len(expression)} chars")  # the code itself is not logged
    return clamp(json.dumps(result, ensure_ascii=False))


@mcp.tool()
async def browser_cdp_events(action: str = "read", domain: str = "", limit: int = 100) -> str:
    """Subscribe to raw DevTools protocol events of a domain and read them back.

    Args:
        action: subscribe, unsubscribe, read or clear.
        domain: CDP domain such as Performance, DOM, Animation; for read, optional filter.
        limit: Events returned by read, 1..500 (newest last).
    """
    if action not in {"subscribe", "unsubscribe", "read", "clear"}:
        raise ValueError("action must be subscribe, unsubscribe, read or clear")
    if action in {"subscribe", "unsubscribe"} and not re.match(r"^[A-Z][A-Za-z0-9]*$", domain or ""):
        raise ValueError("domain must be a CDP domain name, e.g. Performance")
    if not 1 <= limit <= 500:
        raise ValueError("limit must be 1..500")
    if action != "read":
        guard_browser_action()
    result = await BRIDGE.call("browser_cdp_events", {"action": action, "domain": domain, "limit": limit})
    audit("browser_cdp_events", f"{action} {domain}".strip())
    return clamp(json.dumps(result, ensure_ascii=False))



# --------------------------------------------------------- status banner ---


def attach_status_banner() -> None:
    """Append the project guide and the [processes] banner to tool results.

    Wrapping the tools centrally means the model sees running commands after
    any call, not only after the process tools, which is what keeps it from
    starting a second "npm run dev".
    """
    manager = getattr(mcp, "_tool_manager", None)
    tools = getattr(manager, "_tools", None) if manager else None
    if not tools:
        print("  note: could not attach the process banner to tool results")
        return

    def wrap(inner):
        def append_banner(result):
            if isinstance(result, str):
                return result + guide_banner() + status_banner()
            return result

        if inspect.iscoroutinefunction(inner):
            @functools.wraps(inner)
            async def wrapper(*args, **kwargs):
                return append_banner(await inner(*args, **kwargs))
        else:
            @functools.wraps(inner)
            def wrapper(*args, **kwargs):
                return append_banner(inner(*args, **kwargs))

        wrapper._banner_wrapped = True  # type: ignore[attr-defined]
        return wrapper

    for tool in tools.values():
        if getattr(tool.fn, "_banner_wrapped", False):
            continue
        tool.fn = wrap(tool.fn)


try:
    attach_status_banner()
except Exception as exc:  # the banner is a convenience, never a blocker
    print(f"  note: process banner disabled ({exc})")


# ------------------------------------------------------------------- auth ---


class BearerAuthMiddleware:
    """Enforce a static bearer token and normalise the Host header.

    The MCP SDK ships DNS-rebinding protection that only accepts localhost
    hosts. Behind a tunnel the Host header is the public hostname, which the
    SDK rejects with 421. Since the tunnel is the only way in and the bearer
    token is checked first, we rewrite Host to the local address.
    """

    def __init__(self, app, token: str, port: int) -> None:
        self.app = app
        self.expected = f"Bearer {token}"
        self.local_host = f"127.0.0.1:{port}".encode()

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers") or []}
        provided = headers.get(b"authorization", b"").decode("utf-8", "replace")

        if not secrets.compare_digest(provided, self.expected):
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"text/plain; charset=utf-8"),
                        (b"www-authenticate", b"Bearer"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"Unauthorized"})
            return

        try:
            refresh_instructions()
        except Exception:  # a broken guide file must never break a request
            pass

        patched = dict(scope)
        patched["headers"] = [
            (b"host", self.local_host) if key.lower() == b"host" else (key, value)
            for key, value in scope.get("headers") or []
            if key.lower() != b"origin"
        ]
        await self.app(patched, receive, send)


# ------------------------------------------------------------------- main ---


def main() -> None:
    trim_audit()  # keep the journal bounded across restarts
    app = BearerAuthMiddleware(mcp.streamable_http_app(), TOKEN, PORT)

    print("")
    print("  local-mcp v0.1")
    print(f"  root      : {ROOT}")
    print(f"  endpoint  : http://{HOST}:{PORT}/mcp")
    print(f"  token     : {TOKEN}")
    print(f"  read-only : {'yes' if READ_ONLY else 'no'}")
    rules_path = find_rules_file()
    print(f"  rules     : {rules_path if rules_path else f'no {RULES_FILENAME} (optional)'}")
    audit_note = f" (audit.log: last {AUDIT_KEEP_LINES} lines)" if AUDIT else " (audit off)"
    print(f"  logs      : {LOG_DIR}{audit_note}")
    print(
        f"  processes : adopted {STARTUP_REPORT['adopted']}, "
        f"cleaned {STARTUP_REPORT['cleaned']} old log(s)"
    )
    config_note = "" if CONFIG_PATH.exists() else " (not found, built-in defaults)"
    print(f"  config    : {CONFIG_PATH}{config_note}")
    print(f"  perms     : defaultMode {PERMISSIONS['default']} ({PERMISSIONS['source']})")
    print(f"    allow : {', '.join(PERMISSIONS['raw']['allow']) or '-'}")
    print(f"    deny  : {', '.join(PERMISSIONS['raw']['deny']) or '-'}")
    commands = [entry for _, entry in PERMISSIONS["allowRun"]]
    print(f"    run   : {', '.join(commands) if commands else '- (no command is allowed)'}")
    if not BROWSER["enabled"]:
        print("  browser   : off")
    elif BRIDGE.start():
        print(
            f"  browser   : ws://{BROWSER['host']}:{BROWSER['port']} "
            "- press 'Connect' in the extension, or let the agent call browser_launch"
        )
    else:
        print(f"  browser   : NOT started - {BRIDGE.error}")
    print("")
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print("  WARNING: the server is listening on the whole local network.")
        print('  For a tighter setup set "host": "127.0.0.1" in config.json.')
        print("")
    print("  Publish it with either:")
    print("    tunnel :  cloudflared tunnel --url http://localhost:%d" % PORT)
    print("    proxy  :  proxy_pass http://<this-machine>:%d/mcp;" % PORT)
    print("  Then add https://<public-host>/mcp in Notion with the token above.")
    print("")

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
