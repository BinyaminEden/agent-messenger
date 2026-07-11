#!/usr/bin/env bash

# Example agent-messenger wake adapter: tmux.
#
# The messenger invokes this command when an idle recipient has new unread mail,
# passing one JSON object on stdin:
#   { recipient_uuid, recipient_name, session_id, session_cwd,
#     unread_count, from_names: [] }
#
# This adapter finds a tmux pane whose current path matches session_cwd and types
# a "check your agent messages" prompt into it. It is illustrative: matching a
# session to a pane by cwd is heuristic (it wakes the first pane in that
# directory) — adapt the matching to however your setup maps sessions to panes.
#
# Fail-silent by contract: any error just exits 0 without disturbing the sender.

set -u

# Read the whole stdin payload.
payload="$(cat)"

# Extract fields with the JSON tool you have; jq shown here. Bail out quietly if
# jq is missing or the payload is unparseable.
command -v jq >/dev/null 2>&1 || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

session_cwd="$(printf '%s' "$payload" | jq -r '.session_cwd // empty')"
unread="$(printf '%s' "$payload" | jq -r '.unread_count // 0')"
[ -n "$session_cwd" ] || exit 0

prompt="You have ${unread} unread agent-messenger message(s). Run agent_receive to read and act on them."

# Find the first pane whose current path matches session_cwd, then send-keys.
tmux list-panes -a -F '#{pane_current_path} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | while read -r pane_path pane_target; do
      if [ "$pane_path" = "$session_cwd" ]; then
        tmux send-keys -t "$pane_target" "$prompt" Enter
        break
      fi
    done

exit 0
