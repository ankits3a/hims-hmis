---
name: brief-subagent
description: Template and rules for briefing a subagent so it does not re-read the code. Use before delegating any task to a subagent.
---

# Briefing a subagent

Use the template in `docs/agents/BRIEF.md`: goal and owner's words; the lane; read-first order (architecture page →
MAP.md → decisions → named files); what is already known and ruled out; a decided spec; out of scope; verify commands under
the lock; commit by pathspec, no push; shared docs have one writer (the orchestrator); a fixed report shape. Reuse a
finished subagent (SendMessage) when the next step needs what it already read.
