---
name: serena
description: Optional language-server code navigation (Serena MCP) for cross-module reading or renames, with its RAM cost and safe setup in a lane. Use only for heavy cross-module reading or a rename.
---

# Serena (optional, on demand)

Measured 2026-10-07 (two trials): ~15% cheaper, ~28% fewer tokens read, no reliable quality gain; ~2 GB RAM while running,
~4 GB while indexing. One lane at a time, never during someone's jest run.

```
cd /opt/hmis-lanes/<lane>/hmis          # do this as its own statement — never `cd X && (…) &`
serena project create --language typescript --index
# set read_only: true and exclude memory/shell tools in .serena/project.yml, then start the session with --mcp-config
# pointing at: serena start-mcp-server --context claude-code --project /opt/hmis-lanes/<lane>/hmis --enable-web-dashboard false
```

`.serena/` is git-ignored; never create it in `/opt/hmis` (it blocks auto-deploy). `lane.sh drop` unregisters the project.
