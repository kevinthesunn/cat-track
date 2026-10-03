#!/usr/bin/env bash
# Starts Cat Track and an ngrok HTTPS tunnel, then prints the phone-ready link.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
NGROK_PID=""
PORT="$PORT" node server/index.js "$@" &
SERVER_PID=$!
trap 'kill $SERVER_PID ${NGROK_PID:-} 2>/dev/null || true' EXIT INT TERM
sleep 1.5
if command -v ngrok >/dev/null 2>&1; then
  ngrok http "$PORT" --log=stdout > "${TMPDIR:-/tmp}/cattrack-ngrok.log" 2>&1 &
  NGROK_PID=$!
  URL=""
  for _ in $(seq 1 30); do
    URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=(JSON.parse(d).tunnels||[]).find(x=>String(x.public_url).startsWith('https://'));process.stdout.write(t?t.public_url:'')}catch{}})" || true)
    [ -n "$URL" ] && break
    sleep 0.5
  done
  if [ -n "$URL" ]; then
    echo ""
    echo "  Phone operator panel:  $URL/operator"
    echo "  Hub (QR code):         $URL/"
    echo ""
  else
    echo "  ngrok did not report a tunnel — see ${TMPDIR:-/tmp}/cattrack-ngrok.log"
  fi
else
  echo "  ngrok not installed — running locally only at http://localhost:$PORT"
fi
wait "$SERVER_PID"
