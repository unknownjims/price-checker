#!/bin/bash
# Price Checker Auto-Start
# Run this once to start the server + tunnel permanently
# The URL is saved to /mnt/d/hermes/price-checker/.tunnel_url

PIDFILE="/mnt/d/hermes/price-checker/.server_pid"
URLFILE="/mnt/d/hermes/price-checker/.tunnel_url"
DIR="/mnt/d/hermes/price-checker"

# Kill existing
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    kill $OLD_PID 2>/dev/null
    kill $(lsof -ti:8081) 2>/dev/null
    sleep 1
fi

# Start Python server
cd "$DIR"
python3 -m http.server 8081 > /dev/null 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PIDFILE"
echo "Server started (PID: $SERVER_PID)"

# Wait for server
sleep 2

# Start cloudflared tunnel and capture URL
CLOUDFLARED="/home/jimia/.local/bin/cloudflared"
if [ ! -f "$CLOUDFLARED" ]; then
    echo "Downloading cloudflared..."
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED"
    chmod +x "$CLOUDFLARED"
fi

# Start tunnel, parse URL, save it
$CLOUDFLARED tunnel --url http://localhost:8081 2>&1 | \
    while IFS= read -r line; do
        echo "$line"
        URL=$(echo "$line" | grep -oP 'https://[a-z-]+\.trycloudflare\.com')
        if [ -n "$URL" ]; then
            echo "$URL" > "$URLFILE"
            echo ""
            echo "============================================"
            echo "  ✅ PRICE CHECKER IS LIVE!"
            echo ""
            echo "  Send this to Amy:"
            echo "  $URL/price-checker-standalone.html"
            echo ""
            echo "  URL also saved to: $URLFILE"
            echo "============================================"
        fi
    done
