#!/usr/bin/env bash
# Coach VPS monitor, run every 5 minutes by coach-monitor.timer outside the container.
# Checks the container, the public endpoint, the coach-data checkout, the certificate and
# the disk. A problem counts once it is seen in two consecutive runs; ntfy gets one push
# when it appears and one when it clears.
set -uo pipefail

dir="${COACH_DIR:-$HOME/coach}"
state="${STATE_DIR:-$HOME/.local/state/coach-monitor}"
env_file="$dir/coach-mcp/.env"
data="$dir/coach-data"
host="coach.bananer.at"
mkdir -p "$state"
touch "$state/previous" "$state/confirmed"

setting() { sed -n "s/^$1=//p" "$env_file" | tail -1; }
token=$(setting NTFY_TOKEN)
url=$(setting NTFY_URL)
topic=$(setting NTFY_TOPIC)
topic=${topic:-coach}

problems=()
health=$(docker inspect -f '{{.State.Health.Status}}' coach-mcp-coach-1 2>/dev/null || echo "not running")
[ "$health" = healthy ] || problems+=("Container coach-mcp is $health")

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/healthz" || true)
[ "$code" = 200 ] || problems+=("https://$host/healthz answers HTTP ${code:-none}")

if [ -d "$data/.coach-write-lock" ] && [ -n "$(find "$data/.coach-write-lock" -maxdepth 0 -mmin +10)" ]; then
  problems+=("Stale write lock in coach-data (older than 10 minutes)")
fi
[ -z "$(git -C "$data" status --porcelain 2>/dev/null)" ] || problems+=("coach-data has uncommitted changes")
read -r ahead behind < <(git -C "$data" rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null || echo "? ?")
if [ "$ahead" = "?" ]; then
  problems+=("coach-data upstream check failed")
elif [ "$ahead" != 0 ] && [ "$behind" != 0 ]; then
  problems+=("coach-data has diverged from GitHub ($ahead local, $behind remote commits)")
elif [ "$ahead" != 0 ]; then
  problems+=("coach-data has $ahead unpushed commit(s)")
fi

end=$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  [ "$days" -ge 14 ] || problems+=("Certificate for $host expires in $days days")
else
  problems+=("Certificate check for $host failed")
fi

used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "${used:-0}" -lt 85 ] || problems+=("Disk usage at ${used}%")

printf '%s\n' "${problems[@]}" | sed '/^$/d' | sort > "$state/current"
comm -12 "$state/current" "$state/previous" > "$state/next_confirmed"
new=$(comm -13 "$state/confirmed" "$state/next_confirmed")
cleared=$(comm -23 "$state/confirmed" "$state/next_confirmed")

push() {
  [ -n "$token" ] && [ -n "$url" ] || return 1
  curl -fsS -o /dev/null --max-time 15 "${url%/}/$topic" \
    -H "Authorization: Bearer $token" -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4"
}
ok=1
if [ -n "$new" ]; then push "Coach server problem" high rotating_light "$new" || ok=0; fi
if [ -n "$cleared" ]; then push "Coach server recovered" default white_check_mark "Resolved: $cleared" || ok=0; fi
# Keep the old confirmed set if a push failed, so the next run tries again.
[ "$ok" = 1 ] && mv "$state/next_confirmed" "$state/confirmed"
mv "$state/current" "$state/previous"
