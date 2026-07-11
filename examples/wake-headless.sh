#!/usr/bin/env bash

# Example agent-messenger wake adapter: headless resume.
#
# The messenger invokes this command when an idle recipient has new unread mail,
# passing one JSON object on stdin:
#   { recipient_uuid, recipient_name, session_id, session_cwd,
#     unread_count, from_names: [] }
#
# This adapter resumes the recipient's Claude Code session headlessly and asks it
# to read its messages:
#   claude --resume "$session_id" -p "You have unread agent-messenger messages ..."
#
# WARNING: this RESUMES THE CONVERSATION HEADLESSLY in the background. Do NOT use
# it while that session is open interactively in a terminal — two processes
# driving the same conversation will conflict/corrupt it. This adapter is only
# appropriate for sessions that are NOT currently attended by a human. Prefer the
# webhook/tmux adapters when the session is open in a live pane.
#
# Fail-silent by contract: any error just exits 0 without disturbing the sender.

set -u

payload="$(cat)"

command -v jq >/dev/null 2>&1 || exit 0
command -v claude >/dev/null 2>&1 || exit 0

session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty')"
[ -n "$session_id" ] || exit 0

# Run detached in the background so the messenger is never blocked.
nohup claude --resume "$session_id" \
  -p "You have unread agent-messenger messages — read and act on them" \
  >/dev/null 2>&1 &

exit 0
