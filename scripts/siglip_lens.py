#!/usr/bin/env python
"""JSON-lines driver for the SigLIP2 verifier, spoken over stdin/stdout.

Imports the ai-eyes engine DIRECTLY (`ai_eyes_mcp.engine.SigLIPEngine`) --
not over MCP, no `fastmcp`/`pydantic` import -- so the SigLIP2 model loads
exactly once per lens process and this script has no dependency beyond
ai-eyes-mcp's own (torch, transformers, pillow, numpy). See design law §3
and BUILD_SPEC.md Builder B, src/gate/lenses.ts / scripts/siglip_lens.py.

Run long-lived: `src/gate/lenses.ts`'s `createSiglipLens` spawns this once
and sends one JSON object per stdin line for the process's whole lifetime,
matching requests to responses by `id`.

Request shapes:
  {"id": "...", "op": "verify",  "image": "<path>", "target": "<phrase>", "alternatives": ["<phrase>", ...]}
  {"id": "...", "op": "compare", "image_a": "<path>", "image_b": "<path>"}
  {"id": "...", "op": "status"}

Response shapes (exactly one line per request line, same order):
  {"id": "...", "result": {...}}
  {"id": "...", "error": "<message>"}
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

from ai_eyes_mcp.engine import SigLIPEngine

_engine: Optional[SigLIPEngine] = None


def _get_engine() -> SigLIPEngine:
    global _engine
    if _engine is None:
        _engine = SigLIPEngine()
    return _engine


def _handle(request: dict) -> Any:
    op = request.get("op")
    engine = _get_engine()
    if op == "verify":
        # engine.verify already returns {"present", "target_score", ...} --
        # the exact shape src/gate/lenses.ts's siglip lens expects.
        return engine.verify(request["image"], request["target"], request["alternatives"])
    if op == "compare":
        similarity = engine.compare(request["image_a"], request["image_b"])
        return {"similarity": similarity}
    if op == "status":
        return engine.status()
    raise ValueError(f"unknown op: {op!r}")


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request: Optional[dict] = None
        try:
            request = json.loads(line)
            result = _handle(request)
            response: dict = {"id": request.get("id"), "result": result}
        except Exception as exc:  # noqa: BLE001 -- must always answer, never crash the pipe
            req_id = request.get("id") if isinstance(request, dict) else None
            response = {"id": req_id, "error": str(exc)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
