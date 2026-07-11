#!/usr/bin/env node

// Example agent-messenger wake adapter: generic webhook.
//
// The messenger invokes this command when an idle recipient has new unread mail,
// passing one JSON object on stdin:
//   { recipient_uuid, recipient_name, session_id, session_cwd,
//     unread_count, from_names: [] }
//
// This adapter POSTs { session_id, text, submit: true } to a webhook URL taken
// from the WAKE_WEBHOOK_URL env var, or the first CLI argument. It works with any
// dashboard/bridge that can type text into the recipient's session by id.
//
// It skips silently when there is no session_id (nothing to type into) or no URL.
// Fail-silent by contract: it must never throw back at the messenger.

import process from "node:process";

const URL = process.env.WAKE_WEBHOOK_URL || process.argv[2];

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

try {
  const payload = JSON.parse((await readStdin()) || "{}");

  // No session to type into, or no webhook configured — nothing to do.
  if (!payload.session_id || !URL) {
    process.exit(0);
  }

  const from = (payload.from_names || []).join(", ") || "another agent";
  const text = `You have ${payload.unread_count} unread agent-messenger message(s) from ${from}. Run agent_receive to read and act on them.`;

  await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: payload.session_id, text, submit: true }),
  });
} catch {
  // Fail-silent: a broken wake must never affect the sender.
}

process.exit(0);
