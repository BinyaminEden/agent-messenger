#!/usr/bin/env node

// Example agent-messenger wake adapter: Zellij, with no external service.
//
// The messenger invokes this command when an idle recipient has new unread mail,
// passing one JSON object on stdin:
//   { recipient_uuid, recipient_name, session_id, session_cwd,
//     session_ppid, unread_count, from_names: [] }
//
// Unlike the webhook/dashboard adapters, this one needs NOTHING running in the
// background. It uses `session_ppid` — the pid of the recipient's `claude`
// process — to find which Zellij pane that session lives in, then types a
// "check your messages" nudge straight into that pane.
//
// How it locates the pane (macOS + same-user only):
//   `ps eww -o command= -p <session_ppid>` prints the target process's command
//   line WITH its environment appended. A process started inside a Zellij pane
//   carries ZELLIJ_SESSION_NAME and ZELLIJ_PANE_ID in its env; we scrape both
//   out of that output. If they're absent, the session isn't in Zellij and we
//   exit silently (some OTHER adapter, or none, is responsible for it).
//
// Two typing modes:
//
//   1. PLUGIN MODE (preferred, no focus stealing) — enabled when the env var
//      WAKE_ZELLIJ_PIPE_PLUGIN is set to a Zellij pipe-plugin URL (e.g.
//      "file:/abs/path/to/plugin.wasm"). We invoke:
//         zellij --session <s> pipe --plugin <plugin-url> --name <name> -- <payload>
//      where <name> comes from WAKE_ZELLIJ_PIPE_NAME (default "type_chars").
//
//      PLUGIN PAYLOAD CONTRACT — the plugin named by --name must accept a single
//      pipe-message string of the form:
//         <pane_id>|<submit>|<text>
//      · pane_id — the ZELLIJ_PANE_ID of the target pane (as seen in the env).
//      · submit  — "0" to type <text> without pressing Enter; "1" to press Enter
//                  (with <text> empty this is a bare Enter / submit).
//      · text    — the characters to write into that pane, WITHOUT changing focus.
//      We send the text first (submit 0), pause ~300ms, then a bare submit
//      (empty text, submit 1). The split-and-pause works around Claude Code's TUI
//      swallowing an Enter that arrives in the same instant as the pasted text.
//
//   2. FALLBACK MODE (generic, no plugin) — when WAKE_ZELLIJ_PIPE_PLUGIN is unset
//      we use only stock Zellij actions:
//         zellij --session <s> action write-chars -- <text>
//         zellij --session <s> action write 13          # carriage return = Enter
//      CAVEAT: `write-chars`/`write` target the CURRENTLY FOCUSED pane of that
//      session — they cannot address a pane by id — so this types into whatever
//      pane has focus and does NOT guarantee the text lands in the recipient's
//      pane. For reliable, focus-preserving delivery, run in PLUGIN MODE above.
//
// Everything is fail-silent (a broken wake must never affect the sender) and
// bounded by a hard ~8s overall timeout. Child processes are spawned with stdin
// closed so a plugin/action that reads stdin can never hang this adapter.

import process from "node:process";
import { spawn } from "node:child_process";

// Hard ceiling on the whole adapter — never let a wedged child keep us alive.
const OVERALL_TIMEOUT_MS = 8000;
const overallTimer = setTimeout(() => process.exit(0), OVERALL_TIMEOUT_MS);
overallTimer.unref();

const PLUGIN_URL = process.env.WAKE_ZELLIJ_PIPE_PLUGIN;
const PIPE_NAME = process.env.WAKE_ZELLIJ_PIPE_NAME || "type_chars";
const SUBMIT_DELAY_MS = 300;

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a command with args, stdin closed, stdout captured, per-call timeout.
// Resolves { code, stdout } and NEVER rejects — callers stay fail-silent.
function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let stdout = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ code: null, stdout: "" });
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    killTimer.unref?.();
    child.on("error", () => {
      clearTimeout(killTimer);
      resolve({ code: null, stdout });
    });
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (stdout += c));
    }
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout });
    });
  });
}

// Pull a ZELLIJ_* value out of `ps eww` output. Values are appended as KEY=VALUE
// tokens; zellij session names / pane ids never contain whitespace, so a simple
// anchored match is robust.
function scrapeEnv(psOutput, key) {
  const match = psOutput.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return match ? match[1] : null;
}

async function main() {
  const payload = JSON.parse((await readStdin()) || "{}");

  // Need a live session (something to type into) AND its process pid.
  const sessionId = payload.session_id;
  const ppid = payload.session_ppid;
  if (!sessionId || typeof ppid !== "number" || !Number.isFinite(ppid)) {
    return; // plain agent / no live session — nothing to wake here.
  }

  // Read the target process's command + env (same-user only on macOS).
  const { stdout: psOut } = await run("ps", ["eww", "-o", "command=", "-p", String(ppid)]);
  const zellijSession = scrapeEnv(psOut, "ZELLIJ_SESSION_NAME");
  const paneId = scrapeEnv(psOut, "ZELLIJ_PANE_ID");
  if (!zellijSession || !paneId) {
    return; // not a Zellij pane (or process gone) — silently defer.
  }

  const from = (payload.from_names || []).join(", ") || "another agent";
  const text = `You have ${payload.unread_count} unread agent-messenger message(s) from ${from}. Run agent_receive to read and act on them.`;

  if (PLUGIN_URL) {
    // Plugin mode: type text without stealing focus, then a bare submit.
    // Payload contract: "<pane_id>|<submit>|<text>" (see header).
    await run("zellij", [
      "--session", zellijSession,
      "pipe", "--plugin", PLUGIN_URL, "--name", PIPE_NAME,
      "--", `${paneId}|0|${text}`,
    ]);
    await sleep(SUBMIT_DELAY_MS);
    await run("zellij", [
      "--session", zellijSession,
      "pipe", "--plugin", PLUGIN_URL, "--name", PIPE_NAME,
      "--", `${paneId}|1|`,
    ]);
  } else {
    // Fallback mode: types into the session's FOCUSED pane (see CAVEAT above).
    await run("zellij", ["--session", zellijSession, "action", "write-chars", "--", text]);
    await sleep(SUBMIT_DELAY_MS);
    await run("zellij", ["--session", zellijSession, "action", "write", "13"]);
  }
}

try {
  await main();
} catch {
  // Fail-silent: a broken wake must never affect the sender.
}
process.exit(0);
