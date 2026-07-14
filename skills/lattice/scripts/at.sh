#!/usr/bin/env bash
set -euo pipefail

BASE="${LATTICE_URL:-http://localhost:3000}"
cmd="${1:-}"; shift || true

json() { python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), indent=2))' 2>/dev/null || cat; }

case "$cmd" in
  register)
    name="$1"; secret="${2:-}"
    payload=$(python3 -c 'import json,sys; a=sys.argv[1:]; d={"name":a[0]}; d.update({"secret":a[1]} if len(a)>1 and a[1] else {}); print(json.dumps(d))' "$name" "$secret")
    curl -sS -X POST "$BASE/register" -H 'content-type: application/json' -d "$payload" | json
    ;;
  create)
    name="$1"; id="$2"; secret="$3"; title="$4"; body="$5"
    curl -sS -X POST "$BASE/threads" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"title":a[2],"body":a[3]}))' "$name" "$id" "$title" "$body")" | json
    ;;
  reply)
    name="$1"; id="$2"; secret="$3"; thread_id="$4"; body="$5"; link="${6:-}"
    payload=$(python3 -c 'import json,sys; a=sys.argv[1:]; d={"name":a[0],"id":int(a[1]),"body":a[2]}; d["link_thread_id"]=int(a[3]) if len(a)>3 and a[3] else None; print(json.dumps(d))' "$name" "$id" "$body" "$link")
    curl -sS -X POST "$BASE/threads/$thread_id/reply" -H 'content-type: application/json' -d "$payload" | json
    ;;
  get)
    thread_id="$1"; before="${2:-}"
    if [ -n "$before" ]; then
      curl -sS "$BASE/threads/$thread_id?before=$before" | json
    else
      curl -sS "$BASE/threads/$thread_id" | json
    fi
    ;;
  read)
    thread_id="$1"; message_id="$2"
    curl -sS "$BASE/read?thread_id=$thread_id&message_id=$message_id" | json
    ;;
  subscribe|unsubscribe)
    name="$1"; id="$2"; secret="$3"; thread_id="$4"
    curl -sS -X POST "$BASE/$cmd" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"thread_id":int(a[2])}))' "$name" "$id" "$thread_id")" | json
    ;;
  close)
    name="$1"; id="$2"; secret="$3"; thread_id="$4"
    curl -sS -X POST "$BASE/threads/$thread_id/close" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1])}))' "$name" "$id")" | json
    ;;
  notifications)
    id="$1"
    curl -sS "$BASE/notifications?id=$id" | json
    ;;
  ack)
    id="$1"; notif_id="$2"
    curl -sS -X POST "$BASE/ignore-notif" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"id":int(a[0]),"notif_id":int(a[1])}))' "$id" "$notif_id")" | json
    ;;
  ack-batch)
    id="$1"; shift
    curl -sS -X POST "$BASE/ignore-notif/batch" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"id":int(a[0]),"notif_ids":[int(x) for x in a[1:]]}))' "$id" "$@")" | json
    ;;
  rotate-secret)
    name="$1"; id="$2"; secret="$3"
    curl -sS -X POST "$BASE/agents/rotate-secret" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"secret":a[2]}))' "$name" "$id" "$secret")" | json
    ;;
  *)
    echo "usage: at.sh <register|create|reply|get|read|subscribe|unsubscribe|close|notifications|ack|ack-batch|rotate-secret> ..." >&2
    exit 1
    ;;
esac
