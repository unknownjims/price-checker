#!/bin/bash
# Get the current Price Checker URL
URLFILE="/mnt/d/hermes/price-checker/.tunnel_url"
PIDFILE="/mnt/d/hermes/price-checker/.server_pid"

if [ -f "$URLFILE" ]; then
    URL=$(cat "$URLFILE")
    echo "$URL/price-checker-standalone.html"
else
    echo "NOT_RUNNING"
fi

if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 $PID 2>/dev/null; then
        exit 0
    else
        echo "(Server PID $PID exists but process is dead)"
        exit 2
    fi
else
    echo "Not running. Run: bash /mnt/d/hermes/price-checker/start-tunnel.sh"
    exit 1
fi
