---
name: context-governance
description: Monitor Antigravity session context usage via `context_status`, guard against 240K/328K prompt-cache cliffs, and recommend `/compact` before heavy full-context recomputation stalls.
---

# Context Governance

1. Call MCP tool `context_status` before starting large multi-file refactors in an already long session.
2. When `used >= 240000` or `cacheDropDetected === true`, finish the current atomic verification step cleanly and advise running `/compact`.
3. Do not dump large source files blindly; read bounded line ranges (`<= 150` lines) to keep cache footprint compact.
