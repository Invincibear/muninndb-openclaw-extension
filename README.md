# MuninnDB OpenClaw Extension

OpenClaw memory plugin backed by [MuninnDB](https://muninndb.com) — cognitive memory with Ebbinghaus decay, Hebbian learning, and semantic activation.

## What It Does

Replaces OpenClaw's default file-based memory search with MuninnDB's cognitive memory engine:

- **`memory_search`** → MuninnDB `activate` (semantic recall with decay + Hebbian boosting)
- **`memory_get`** → Direct file read (unchanged — reads MEMORY.md / memory/*.md)
- **`memory_store`** → Write engrams to MuninnDB (explicit memory storage)
- **`memory_forget`** → Soft-delete engrams from MuninnDB

### Cognitive Advantages Over Flat Vector Search

- **Ebbinghaus decay** — Memories fade over time unless reinforced, naturally prioritizing recent/relevant info
- **Hebbian learning** — Frequently accessed memories strengthen ("neurons that fire together wire together")
- **Associative graph** — Memories link to each other, enabling multi-hop recall
- **Contradiction detection** — MuninnDB flags conflicting memories for resolution
- **LLM enrichment** — Auto-extracts entities, summaries, and relationships from stored memories

## Prerequisites

- [MuninnDB](https://github.com/scrypster/muninndb) running locally (or remotely)
- OpenClaw >= 2026.3.22

## Installation

```bash
# From the repo
openclaw plugins install ./path/to/muninndb-openclaw-extension

# Or from npm (once published)
openclaw plugins install @muninndb/openclaw-extension
```

## Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    slots: {
      memory: "memory-muninndb"
    },
    entries: {
      "memory-muninndb": {
        config: {
          baseUrl: "http://127.0.0.1:8476",
          // token: "your-api-key",  // optional if auth is disabled
          vault: "openclaw",
          autoRecall: true,          // inject relevant memories into context
          autoCapture: false,        // auto-capture user messages (experimental)
          syncFiles: true,           // sync MEMORY.md + memory/*.md to MuninnDB
          activateThreshold: 0.3,    // minimum relevance score
          maxResults: 6              // max results per search
        }
      }
    }
  }
}
```

## CLI Commands

```bash
# Check MuninnDB connection and stats
openclaw muninndb status

# Search memories
openclaw muninndb search "calendar sync architecture"

# Force sync memory files to MuninnDB
openclaw muninndb sync
```

## How It Works

### File Sync
When `syncFiles` is enabled, the plugin watches `MEMORY.md` and `memory/*.md` files in your workspace. Changes are chunked by markdown headings and written to MuninnDB as engrams tagged with `openclaw-sync`.

### Auto-Recall
When `autoRecall` is enabled, the plugin injects relevant memories from MuninnDB into the agent's context before each turn. This happens transparently — the agent sees memories as `<relevant-memories>` context blocks.

### Auto-Capture
When `autoCapture` is enabled, the plugin analyzes user messages for important information (preferences, decisions, facts) and stores them in MuninnDB automatically.

## License

MIT
