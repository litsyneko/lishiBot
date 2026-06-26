#!/bin/bash
# FullMoon Bot + Lavalink Launcher
# Usage: ./start.sh [--no-lavalink]

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAVALINK_DIR="$ROOT_DIR/lavalink"
NO_LAVALINK=false
LAVALINK_PID=""

# Parse args
for arg in "$@"; do
    case "$arg" in
        --no-lavalink) NO_LAVALINK=true ;;
    esac
done

cleanup() {
    echo ""
    echo "[CLEANUP] Stopping all processes..."
    if [ -n "$LAVALINK_PID" ] && kill -0 "$LAVALINK_PID" 2>/dev/null; then
        echo "[LAVALINK] Stopping Lavalink (PID: $LAVALINK_PID)..."
        kill "$LAVALINK_PID" 2>/dev/null || true
        wait "$LAVALINK_PID" 2>/dev/null || true
    fi
    echo "[CLEANUP] Done."
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${MAGENTA}========================================${NC}"
echo -e "${MAGENTA}  FullMoon Bot + Lavalink Launcher${NC}"
echo -e "${MAGENTA}========================================${NC}"
echo ""

start_lavalink() {
    if [ ! -f "$LAVALINK_DIR/Lavalink.jar" ]; then
        echo -e "${RED}[ERROR] Lavalink.jar not found at: $LAVALINK_DIR/Lavalink.jar${NC}"
        exit 1
    fi

    echo -e "${CYAN}[LAVALINK] Starting Lavalink server...${NC}"
    cd "$LAVALINK_DIR"
    java -jar Lavalink.jar &
    LAVALINK_PID=$!
    cd "$ROOT_DIR"

    # Wait for Lavalink to be ready (port 2333)
    TIMEOUT=30
    ELAPSED=0
    READY=false
    while [ $ELAPSED -lt $TIMEOUT ]; do
        sleep 1
        ELAPSED=$((ELAPSED + 1))
        if command -v curl &>/dev/null; then
            if curl -s -o /dev/null -w "%{http_code}" http://localhost:2333/version 2>/dev/null | grep -q 200; then
                READY=true
                break
            fi
        elif command -v wget &>/dev/null; then
            if wget -q -O /dev/null http://localhost:2333/version 2>/dev/null; then
                READY=true
                break
            fi
        else
            # No curl or wget, just sleep
            sleep 2
            READY=true
            break
        fi
        echo -e "  ${YELLOW}Waiting for Lavalink... ($ELAPSED/$TIMEOUT s)${NC}"
    done

    if [ "$READY" = true ]; then
        echo -e "${GREEN}[LAVALINK] Lavalink is ready! (PID: $LAVALINK_PID)${NC}"
    else
        echo -e "${YELLOW}[WARN] Lavalink may not be ready yet. Check logs if the bot fails to connect.${NC}"
    fi
}

start_bot() {
    echo -e "${CYAN}[BOT] Starting Discord bot...${NC}"
    cd "$ROOT_DIR"
    pnpm start
}

# ── Main ──
if [ "$NO_LAVALINK" = false ]; then
    start_lavalink
else
    echo -e "${YELLOW}[SKIP] Lavalink start skipped (--no-lavalink)${NC}"
fi

start_bot
