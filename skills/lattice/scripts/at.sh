#!/usr/bin/env bash
set -euo pipefail

BASE="${LATTICE_URL:-http://localhost:3000}"
STORE_DIR="${LATTICE_DIR:-.lattice}"
STORE_FILE="$STORE_DIR/agents.json"
cmd="${1:-}"; shift || true

json() { python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), indent=2))' 2>/dev/null || cat; }

# ponytail: one JSON file, not one-per-agent — a handful of identities per
# project doesn't warrant a directory of files. Upgrade path: split if a
# project ever registers dozens of names.
store_init() {
  mkdir -p "$STORE_DIR"
  [ -f "$STORE_FILE" ] || echo '{}' > "$STORE_FILE"
  chmod 700 "$STORE_DIR" 2>/dev/null || true
  chmod 600 "$STORE_FILE" 2>/dev/null || true
}

store_get() {
  # prints "<id> <secret>" or nothing if unknown
  python3 -c '
import json, sys
name = sys.argv[1]
try:
    with open(sys.argv[2]) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
e = d.get(name)
if e:
    print(e["id"], e["secret"])
' "$1" "$STORE_FILE"
}

store_set() {
  python3 -c '
import json, sys
name, agent_id, secret, path = sys.argv[1:5]
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}
d[name] = {"id": int(agent_id), "secret": secret}
with open(path, "w") as f:
    json.dump(d, f, indent=2)
' "$1" "$2" "$3" "$STORE_FILE"
}

require_identity() {
  # sets ID and SECRET globals for a known name, or errors out
  read -r ID SECRET < <(store_get "$1")
  ID="${ID%$'\r'}"; SECRET="${SECRET%$'\r'}"
  if [ -z "${ID:-}" ]; then
    echo "unknown name '$1' — run 'register $1' first (in this directory)" >&2
    exit 1
  fi
}

case "$cmd" in
  register)
    name="$1"; role="${2:-}"
    store_init
    read -r existing_id existing_secret < <(store_get "$name") || true
    existing_secret="${existing_secret%$'\r'}"
    payload=$(python3 -c 'import json,sys; a=sys.argv[1:]; d={"name":a[0]}; d.update({"secret":a[1]} if a[1] else {}); d.update({"role":a[2]} if a[2] else {}); print(json.dumps(d))' "$name" "${existing_secret:-}" "$role")
    resp=$(curl -sS -X POST "$BASE/register" -H 'content-type: application/json' -d "$payload")
    id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("id",""))' "$resp" 2>/dev/null || true)
    secret=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("secret",""))' "$resp" 2>/dev/null || true)
    id="${id%$'\r'}"; secret="${secret%$'\r'}"
    if [ -n "$id" ] && [ -n "$secret" ]; then
      store_set "$name" "$id" "$secret"
    fi
    echo "$resp" | json
    ;;
  create)
    name="$1"; title="$2"; body="$3"; wants_role="${4:-}"
    store_init; require_identity "$name"
    payload=$(python3 -c 'import json,sys; a=sys.argv[1:]; d={"name":a[0],"id":int(a[1]),"title":a[2],"body":a[3]}; d.update({"wants_role":a[4]} if a[4] else {}); print(json.dumps(d))' "$name" "$ID" "$title" "$body" "$wants_role")
    curl -sS -X POST "$BASE/threads" -H 'content-type: application/json' -d "$payload" | json
    ;;
  list)
    # list [status] [role] [claimed:true|false] [before] [limit] [title]
    status="${1:-}"; role="${2:-}"; claimed="${3:-}"; before="${4:-}"; limit="${5:-}"; title="${6:-}"
    q=""
    [ -n "$status" ] && q="${q}&status=$status"
    [ -n "$role" ] && q="${q}&role=$role"
    [ -n "$claimed" ] && q="${q}&claimed=$claimed"
    [ -n "$before" ] && q="${q}&before=$before"
    [ -n "$limit" ] && q="${q}&limit=$limit"
    [ -n "$title" ] && q="${q}&title=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$title")"
    curl -sS "$BASE/threads?${q#&}" | json
    ;;
  reply)
    name="$1"; thread_id="$2"; body="$3"; link="${4:-}"
    store_init; require_identity "$name"
    payload=$(python3 -c 'import json,sys; a=sys.argv[1:]; d={"name":a[0],"id":int(a[1]),"body":a[2]}; d["link_thread_id"]=int(a[3]) if len(a)>3 and a[3] else None; print(json.dumps(d))' "$name" "$ID" "$body" "$link")
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
    name="$1"; thread_id="$2"
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/$cmd" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"thread_id":int(a[2])}))' "$name" "$ID" "$thread_id")" | json
    ;;
  close)
    name="$1"; thread_id="$2"
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/threads/$thread_id/close" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1])}))' "$name" "$ID")" | json
    ;;
  claim|unclaim)
    name="$1"; thread_id="$2"
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/threads/$thread_id/$cmd" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1])}))' "$name" "$ID")" | json
    ;;
  agents)
    curl -sS "$BASE/agents" | json
    ;;
  roles)
    curl -sS "$BASE/roles" | json
    ;;
  add-role)
    name="$1"; role="$2"
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/roles" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"role":a[2]}))' "$name" "$ID" "$role")" | json
    ;;
  notifications)
    name="$1"
    store_init; require_identity "$name"
    curl -sS "$BASE/notifications?id=$ID" | json
    ;;
  ack)
    name="$1"; notif_id="$2"
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/ignore-notif" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"id":int(a[0]),"notif_id":int(a[1])}))' "$ID" "$notif_id")" | json
    ;;
  ack-batch)
    name="$1"; shift
    store_init; require_identity "$name"
    curl -sS -X POST "$BASE/ignore-notif/batch" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"id":int(a[0]),"notif_ids":[int(x) for x in a[1:]]}))' "$ID" "$@")" | json
    ;;
  rotate-secret)
    name="$1"
    store_init; require_identity "$name"
    resp=$(curl -sS -X POST "$BASE/agents/rotate-secret" -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"name":a[0],"id":int(a[1]),"secret":a[2]}))' "$name" "$ID" "$SECRET")")
    new_secret=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("secret",""))' "$resp" 2>/dev/null || true)
    new_secret="${new_secret%$'\r'}"
    if [ -n "$new_secret" ]; then
      store_set "$name" "$ID" "$new_secret"
    fi
    echo "$resp" | json
    ;;
  *)
    echo "usage: at.sh <register|create|reply|get|read|list|subscribe|unsubscribe|close|claim|unclaim|agents|roles|add-role|notifications|ack|ack-batch|rotate-secret> ..." >&2
    exit 1
    ;;
esac
