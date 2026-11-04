#!/bin/sh
# The demo computer's one command (installed as `threadlines-demo`).
#
#   threadlines-demo serve    the container's main process: the Threadlines
#                             server with the scripted agent, fixtures rebuilt
#                             once it answers (DEMO_RESET_ON_START=0 skips that)
#   threadlines-demo reset    rebuild the fake projects and threads now
#   threadlines-demo status   list the fake projects' threads and their states
#
# Run the last two with `docker exec <container> threadlines-demo reset`.
set -eu

DEMO_DIR=/opt/threadlines-demo
SETTINGS="$THREADLINES_HOME/userdata/settings.json"

fixtures() {
  node "$DEMO_DIR/demo-fixtures.ts" "$@"
}

case "${1:-serve}" in
  reset)
    fixtures reset
    ;;
  status)
    fixtures status
    ;;
  serve)
    # Written on every start, so every real provider stays off whatever was
    # changed in the app.
    fixtures settings --agent "$DEMO_DIR/demo-agent.ts" --out "$SETTINGS"

    threadlines &
    server=$!
    trap 'kill -TERM "$server" 2>/dev/null || true' TERM INT

    until curl -fsS "http://127.0.0.1:$THREADLINES_PORT/api/auth/session" >/dev/null 2>&1; do
      if ! kill -0 "$server" 2>/dev/null; then
        wait "$server"
        exit $?
      fi
      sleep 1
    done

    # A restart ends every live agent session, so the threads that were
    # waiting or working would come back idle: rebuild them.
    if [ "${DEMO_RESET_ON_START:-1}" = "1" ]; then
      fixtures reset || echo "[demo] the fixtures failed; the server keeps running. Retry with: threadlines-demo reset" >&2
    fi

    code=0
    wait "$server" || code=$?
    # A stop signal ends the first wait early: let the server finish shutting down.
    if kill -0 "$server" 2>/dev/null; then
      wait "$server" || code=$?
    fi
    exit "$code"
    ;;
  *)
    echo "Usage: threadlines-demo [serve|reset|status]" >&2
    exit 2
    ;;
esac
