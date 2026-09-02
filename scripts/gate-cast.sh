#!/usr/bin/env bash
# Gate every entity of a cast whose candidates sit under <out>/<entityId>/ --
# sequential (one GPU), logging per entity, never stopping on a silhouette.
# Usage: scripts/gate-cast.sh <cast-dir-with-per-entity-json> <candidates-root> [--registry <dir>]
# Env: SIGLIP_PYTHON, OLLAMA_VISION_MODEL (default qwen3.6:27b -- the 35b-a3b
# plus SigLIP2 plus image buffers crossed this rig's 31.2 GB VRAM ceiling on
# 2026-09-02), PORTRAIT_FORGE_OLLAMA_KEEP_ALIVE (default 5m).
set -u
CAST_DIR="$1"; CAND_ROOT="$2"; shift 2
REGISTRY="registry"
if [ "${1:-}" = "--registry" ]; then REGISTRY="$2"; fi
export SIGLIP_PYTHON="${SIGLIP_PYTHON:-E:/AI/ai-eyes-mcp/.venv/Scripts/python.exe}"
export OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-qwen3.6:27b}"
export PORTRAIT_FORGE_OLLAMA_KEEP_ALIVE="${PORTRAIT_FORGE_OLLAMA_KEEP_ALIVE:-5m}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in "$CAST_DIR"/*.json; do
  id="$(basename "$f" .json)"
  dir="$CAND_ROOT/$id"
  [ -d "$dir" ] || { echo "$id: no candidates dir $dir -- skipped"; continue; }
  echo "== $id ($(date +%H:%M:%S))"
  node "$ROOT/dist/cli.js" accept --entity "$f" --candidates "$dir" --registry "$REGISTRY" 2>&1 | tee "$dir/accept.log" | tail -3
  echo "exit=${PIPESTATUS[0]}"
done
echo "== done ($(date +%H:%M:%S))"
