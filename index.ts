/**
 * OpenClaw Memory Plugin — MuninnDB Backend
 *
 * Replaces the default file-based memory search with MuninnDB's cognitive
 * memory engine. Provides semantic activation with Ebbinghaus decay,
 * Hebbian learning, and associative graph traversal.
 *
 * memory_search → MuninnDB activate (semantic recall)
 * memory_get    → direct file read (unchanged, delegated to core)
 * memory_store  → MuninnDB write (explicit memory storage)
 *
 * Optionally syncs MEMORY.md + memory/*.md to MuninnDB and auto-captures
 * important information from conversations.
 */

import { readFileSync, readdirSync, statSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// ============================================================================
// Config
// ============================================================================

interface MuninnConfig {
  baseUrl: string;
  token?: string;
  vault: string;
  autoCapture: boolean;
  autoRecall: boolean;
  syncFiles: boolean;
  activateThreshold: number;
  maxResults: number;
}

function parseConfig(raw: unknown): MuninnConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : "http://127.0.0.1:8476",
    token: typeof cfg.token === "string" && cfg.token.length > 0 ? cfg.token : undefined,
    vault: typeof cfg.vault === "string" ? cfg.vault : "openclaw",
    autoCapture: cfg.autoCapture === true,
    autoRecall: cfg.autoRecall !== false,
    syncFiles: cfg.syncFiles !== false,
    activateThreshold: typeof cfg.activateThreshold === "number" ? cfg.activateThreshold : 0.3,
    maxResults: typeof cfg.maxResults === "number" ? cfg.maxResults : 6,
  };
}

// ============================================================================
// MuninnDB HTTP Client (lightweight, no SDK dependency)
// ============================================================================

interface ActivationItem {
  id: string;
  concept: string;
  content: string;
  score: number;
  tags: string[];
  memory_type: string;
  why?: string;
}

interface ActivateResponse {
  query_id: string;
  total_found: number;
  activations: ActivationItem[];
  latency_ms: number;
}

interface WriteResponse {
  id: string;
  created_at: number;
}

interface StatsResponse {
  engram_count: number;
  vault_count: number;
  storage_bytes: number;
}

class MuninnClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly vault: string = "openclaw",
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  async activate(context: string[], opts?: { threshold?: number; maxResults?: number }): Promise<ActivateResponse> {
    const res = await fetch(`${this.baseUrl}/api/activate?vault=${encodeURIComponent(this.vault)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vault: this.vault,
        context,
        threshold: opts?.threshold ?? 0.3,
        max_results: opts?.maxResults ?? 6,
        include_why: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`MuninnDB activate failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<ActivateResponse>;
  }

  async write(concept: string, content: string, tags: string[] = []): Promise<WriteResponse> {
    const res = await fetch(`${this.baseUrl}/api/engrams?vault=${encodeURIComponent(this.vault)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ vault: this.vault, concept, content, tags }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`MuninnDB write failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<WriteResponse>;
  }

  async findByTags(
    tags: string[],
    limit = 10,
  ): Promise<{ engrams: Array<{ id: string; concept: string; tags: string[] }> }> {
    const params = new URLSearchParams({
      vault: this.vault,
      tags: tags.join(","),
      limit: String(limit),
    });
    const res = await fetch(`${this.baseUrl}/api/engrams?${params}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`MuninnDB findByTags failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<{ engrams: Array<{ id: string; concept: string; tags: string[] }> }>;
  }

  async evolve(id: string, newContent: string, reason: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/engrams/${encodeURIComponent(id)}/evolve?vault=${encodeURIComponent(this.vault)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ new_content: newContent, reason }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`MuninnDB evolve failed (${res.status}): ${await res.text()}`);
    }
  }

  async forget(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/engrams/${encodeURIComponent(id)}?vault=${encodeURIComponent(this.vault)}`,
      {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`MuninnDB forget failed (${res.status}): ${await res.text()}`);
    }
  }

  async stats(): Promise<StatsResponse> {
    const res = await fetch(`${this.baseUrl}/api/stats?vault=${encodeURIComponent(this.vault)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`MuninnDB stats failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<StatsResponse>;
  }

  async health(): Promise<{ status: string; version: string }> {
    const res = await fetch(`${this.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`MuninnDB health failed (${res.status})`);
    }
    return res.json() as Promise<{ status: string; version: string }>;
  }

  async listEngrams(
    limit = 100,
    offset = 0,
  ): Promise<{ engrams: Array<{ id: string; concept: string; content: string; tags: string[] }>; total: number }> {
    const res = await fetch(
      `${this.baseUrl}/api/engrams?vault=${encodeURIComponent(this.vault)}&limit=${limit}&offset=${offset}`,
      { headers: this.headers(), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      throw new Error(`MuninnDB listEngrams failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<{
      engrams: Array<{ id: string; concept: string; content: string; tags: string[] }>;
      total: number;
    }>;
  }
}

// ============================================================================
// File sync — index MEMORY.md + memory/*.md as engrams
// ============================================================================

/** Hash content to detect changes without re-uploading unchanged files. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Find all memory markdown files in the workspace. */
function findMemoryFiles(workspace: string): string[] {
  const files: string[] = [];

  // MEMORY.md at root
  const rootMemory = join(workspace, "MEMORY.md");
  if (existsSync(rootMemory)) files.push(rootMemory);

  // memory/*.md
  const memoryDir = join(workspace, "memory");
  if (existsSync(memoryDir)) {
    try {
      for (const entry of readdirSync(memoryDir)) {
        if (entry.endsWith(".md")) {
          const full = join(memoryDir, entry);
          try {
            if (statSync(full).isFile()) files.push(full);
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  return files;
}

/** Split a markdown file into logical chunks by headings. */
function chunkMarkdown(content: string, filePath: string): Array<{ concept: string; content: string; tags: string[] }> {
  const chunks: Array<{ concept: string; content: string; tags: string[] }> = [];
  const fileName = basename(filePath, ".md");
  const lines = content.split("\n");

  let currentHeading = fileName;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch && currentLines.length > 0) {
      const text = currentLines.join("\n").trim();
      if (text.length > 20) {
        chunks.push({
          concept: `${fileName}/${currentHeading}`,
          content: text,
          tags: ["openclaw-sync", `file:${fileName}`],
        });
      }
      currentLines = [line];
      currentHeading = headingMatch[1].trim();
    } else {
      currentLines.push(line);
    }
  }

  // Flush remaining
  const remaining = currentLines.join("\n").trim();
  if (remaining.length > 20) {
    chunks.push({
      concept: `${fileName}/${currentHeading}`,
      content: remaining,
      tags: ["openclaw-sync", `file:${fileName}`],
    });
  }

  return chunks;
}

// ============================================================================
// Plugin Definition
// ============================================================================

export default definePluginEntry({
  id: "memory-muninndb",
  name: "Memory (MuninnDB)",
  description: "Cognitive memory powered by MuninnDB with Ebbinghaus decay, Hebbian learning, and semantic activation",
  kind: "memory" as const,

  register(api) {
    const cfg = parseConfig(api.pluginConfig);
    const client = new MuninnClient(cfg.baseUrl, cfg.token, cfg.vault);

    api.logger.info(`memory-muninndb: registered (vault: ${cfg.vault}, url: ${cfg.baseUrl})`);

    // ========================================================================
    // Tool: memory_search — semantic recall via MuninnDB activate
    // ========================================================================

    api.registerTool(
      {
        name: "memory_search",
        description:
          "Semantically search long-term memory via MuninnDB. Returns memories that are contextually relevant, weighted by recency (Ebbinghaus decay) and usage frequency (Hebbian learning). Use for prior work, decisions, dates, people, preferences, or todos.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query — what you want to recall" },
            maxResults: { type: "number", description: "Max results (default: 6)" },
            minScore: { type: "number", description: "Minimum relevance score 0-1 (default: 0.3)" },
          },
          required: ["query"],
        },
        async execute(_toolCallId, params) {
          const { query, maxResults, minScore } = params as {
            query: string;
            maxResults?: number;
            minScore?: number;
          };

          try {
            const result = await client.activate([query], {
              threshold: minScore ?? cfg.activateThreshold,
              maxResults: maxResults ?? cfg.maxResults,
            });

            if (result.activations.length === 0) {
              return {
                content: [{ type: "text", text: JSON.stringify({ results: [], provider: "muninndb" }) }],
              };
            }

            const results = result.activations.map((a) => ({
              concept: a.concept,
              snippet: a.content.slice(0, 700),
              score: a.score,
              tags: a.tags,
              why: a.why,
              source: "muninndb",
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results,
                    provider: "muninndb",
                    totalFound: result.total_found,
                    latencyMs: result.latency_ms,
                  }),
                },
              ],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            api.logger.warn(`memory-muninndb: search failed: ${msg}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [],
                    provider: "muninndb",
                    error: msg,
                    disabled: true,
                  }),
                },
              ],
            };
          }
        },
      },
      { names: ["memory_search"] },
    );

    // ========================================================================
    // Tool: memory_get — direct file read (delegate to core behavior)
    // ========================================================================

    api.registerTool(
      {
        name: "memory_get",
        description:
          "Read a specific memory file by path (MEMORY.md or memory/*.md) with optional line range. Use after memory_search to pull full context from a specific file.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path relative to workspace (e.g. MEMORY.md, memory/2026-03-24.md)",
            },
            from: { type: "number", description: "Start line (1-indexed)" },
            lines: { type: "number", description: "Number of lines to read" },
          },
          required: ["path"],
        },
        async execute(_toolCallId, params) {
          const {
            path: filePath,
            from,
            lines,
          } = params as {
            path: string;
            from?: number;
            lines?: number;
          };

          // Security: only allow memory files
          const normalized = filePath.replace(/^\.\//, "");
          if (normalized !== "MEMORY.md" && !normalized.startsWith("memory/") && !normalized.startsWith("memory\\")) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "Path must be MEMORY.md or memory/*.md", path: filePath }),
                },
              ],
            };
          }

          try {
            // Resolve against the agent workspace
            const workspace = process.env.OPENCLAW_WORKSPACE ?? join(process.env.HOME ?? "", ".openclaw", "workspace");
            const fullPath = join(workspace, normalized);

            if (!existsSync(fullPath)) {
              return {
                content: [{ type: "text", text: JSON.stringify({ text: "", path: normalized }) }],
              };
            }

            const content = readFileSync(fullPath, "utf-8");
            const allLines = content.split("\n");

            let text: string;
            if (from !== undefined) {
              const startIdx = Math.max(0, from - 1);
              const count = lines ?? allLines.length - startIdx;
              text = allLines.slice(startIdx, startIdx + count).join("\n");
            } else {
              text = content;
            }

            return {
              content: [{ type: "text", text: JSON.stringify({ text, path: normalized }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: JSON.stringify({ error: msg, path: filePath }) }],
            };
          }
        },
      },
      { names: ["memory_get"] },
    );

    // ========================================================================
    // Tool: memory_store — explicitly store a memory in MuninnDB
    // ========================================================================

    api.registerTool(
      {
        name: "memory_store",
        description:
          "Store important information in MuninnDB long-term memory. Use for preferences, decisions, facts, or anything worth remembering across sessions.",
        parameters: {
          type: "object",
          properties: {
            concept: {
              type: "string",
              description: "Short label for this memory (e.g. 'user-preference', 'project-decision')",
            },
            content: { type: "string", description: "The information to remember" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
          },
          required: ["concept", "content"],
        },
        async execute(_toolCallId, params) {
          const { concept, content, tags } = params as {
            concept: string;
            content: string;
            tags?: string[];
          };

          try {
            const result = await client.write(concept, content, tags ?? []);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    stored: true,
                    id: result.id,
                    concept,
                  }),
                },
              ],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            api.logger.warn(`memory-muninndb: store failed: ${msg}`);
            return {
              content: [{ type: "text", text: JSON.stringify({ stored: false, error: msg }) }],
            };
          }
        },
      },
      { names: ["memory_store"], optional: true },
    );

    // ========================================================================
    // Tool: memory_forget — remove a memory from MuninnDB
    // ========================================================================

    api.registerTool(
      {
        name: "memory_forget",
        description: "Remove a specific memory from MuninnDB by its ID.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Engram ID to forget" },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };

          try {
            await client.forget(id);
            return {
              content: [{ type: "text", text: JSON.stringify({ forgotten: true, id }) }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: JSON.stringify({ forgotten: false, error: msg }) }],
            };
          }
        },
      },
      { names: ["memory_forget"], optional: true },
    );

    // ========================================================================
    // System prompt section for memory recall guidance
    // ========================================================================

    api.registerMemoryPromptSection(({ availableTools, citationsMode }) => {
      const hasSearch = availableTools.has("memory_search");
      const hasGet = availableTools.has("memory_get");

      if (!hasSearch && !hasGet) return [];

      let guidance: string;
      if (hasSearch && hasGet) {
        guidance =
          "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.";
      } else if (hasSearch) {
        guidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search and answer from the matching results. If low confidence after search, say you checked.";
      } else {
        guidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines.";
      }

      const lines = ["## Memory Recall", guidance];
      if (citationsMode !== "off") {
        lines.push("Citations: include Source: <path#line> when it helps the user verify memory snippets.");
      }
      lines.push("");
      return lines;
    });

    // ========================================================================
    // File sync — index MEMORY.md + memory/*.md as engrams
    // ========================================================================

    if (cfg.syncFiles) {
      // Only one instance should sync — use a simple process-level singleton
      // The plugin is loaded once per gateway process but register() is called
      // per agent. Use a module-level flag to ensure only the first agent syncs.
      const syncLockKey = "__muninndb_sync_active__";
      const globalAny = globalThis as Record<string, unknown>;
      if (globalAny[syncLockKey]) {
        api.logger.info("memory-muninndb: sync already active from another agent, skipping");
      } else {
        globalAny[syncLockKey] = true;

        // Track synced file hashes — persisted to disk so restarts don't re-sync
        const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(process.env.HOME ?? "", ".openclaw");
        const hashStatePath = join(stateDir, "muninndb-sync-hashes.json");

        // Load persisted hashes
        let syncedHashes = new Map<string, string>();
        try {
          if (existsSync(hashStatePath)) {
            const saved = JSON.parse(readFileSync(hashStatePath, "utf-8"));
            if (saved && typeof saved === "object") {
              syncedHashes = new Map(Object.entries(saved));
            }
          }
        } catch {
          // Start fresh if corrupt
        }

        const persistHashes = () => {
          try {
            const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(hashStatePath, JSON.stringify(Object.fromEntries(syncedHashes), null, 2));
          } catch {
            /* best effort */
          }
        };

        let syncInProgress = false;

        const syncMemoryFiles = async (workspace: string) => {
          if (syncInProgress) return;
          syncInProgress = true;

          try {
            const files = findMemoryFiles(workspace);
            let synced = 0;
            let skipped = 0;

            for (const filePath of files) {
              try {
                const content = readFileSync(filePath, "utf-8");
                const hash = contentHash(content);
                const relPath = relative(workspace, filePath);

                // Skip if unchanged since last sync
                if (syncedHashes.get(relPath) === hash) {
                  skipped++;
                  continue;
                }

                const chunks = chunkMarkdown(content, filePath);
                for (const chunk of chunks) {
                  const chunkHash = contentHash(chunk.content);
                  const tags = [...chunk.tags, `hash:${chunkHash}`];

                  // Check if engram with this hash already exists in MuninnDB
                  try {
                    const existing = await client.findByTags([`hash:${chunkHash}`], 1);
                    if (existing.engrams && existing.engrams.length > 0) {
                      // Already exists — skip
                      continue;
                    }
                  } catch {
                    // If lookup fails, write anyway (safer than skipping)
                  }

                  await client.write(chunk.concept, chunk.content, tags);
                  // Rate limit: delay between writes to avoid 429s
                  await new Promise((r) => setTimeout(r, 250));
                }

                syncedHashes.set(relPath, hash);
                synced++;
              } catch (err) {
                api.logger.warn(
                  `memory-muninndb: failed to sync ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            if (synced > 0) {
              persistHashes();
              api.logger.info(`memory-muninndb: synced ${synced} files (${skipped} unchanged)`);
            }
          } finally {
            syncInProgress = false;
          }
        };

        // Initial sync on startup
        const workspace = process.env.OPENCLAW_WORKSPACE ?? join(process.env.HOME ?? "", ".openclaw", "workspace");
        setTimeout(() => syncMemoryFiles(workspace), 5_000);

        // Watch for changes (poll-based, simpler than fs.watch for cross-platform)
        const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
        const syncTimer = setInterval(() => syncMemoryFiles(workspace), SYNC_INTERVAL_MS);

        // Clean up on stop
        api.registerService({
          id: "memory-muninndb-sync",
          start: () => {
            api.logger.info("memory-muninndb: file sync service started");
          },
          stop: () => {
            clearInterval(syncTimer);
            globalAny[syncLockKey] = false;
            api.logger.info("memory-muninndb: file sync service stopped");
          },
        });
      } // end singleton else block
    }

    // ========================================================================
    // Auto-recall: inject relevant memories before agent turns
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const result = await client.activate([event.prompt], {
            threshold: cfg.activateThreshold,
            maxResults: 3,
          });

          if (result.activations.length === 0) return;

          const memoryLines = result.activations.map(
            (a, i) => `${i + 1}. [${a.concept}] ${a.content.slice(0, 300)} (score: ${(a.score * 100).toFixed(0)}%)`,
          );

          return {
            prependContext: `<relevant-memories source="muninndb">\n${memoryLines.join("\n")}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-muninndb: auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // ========================================================================
    // Auto-capture: store important user messages
    // ========================================================================

    if (cfg.autoCapture) {
      const CAPTURE_TRIGGERS = [
        /remember|zapamatuj|pamatuj/i,
        /prefer|radši|nechci/i,
        /decided|rozhodli/i,
        /always|never|important/i,
        /my .+ is|is my/i,
        /i (like|prefer|hate|love|want|need)/i,
      ];

      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          let captured = 0;
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            if (msgObj.role !== "user") continue;

            const content = typeof msgObj.content === "string" ? msgObj.content : "";
            if (content.length < 10 || content.length > 500) continue;
            if (content.includes("<relevant-memories>")) continue;

            const shouldCapture = CAPTURE_TRIGGERS.some((r) => r.test(content));
            if (!shouldCapture) continue;

            await client.write("auto-capture", content, ["auto-captured", "user-message"]);
            captured++;
            if (captured >= 3) break;
          }

          if (captured > 0) {
            api.logger.info(`memory-muninndb: auto-captured ${captured} memories`);
          }
        } catch (err) {
          api.logger.warn(`memory-muninndb: auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // ========================================================================
    // CLI: muninndb commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("muninndb").description("MuninnDB memory plugin commands");

        cmd
          .command("status")
          .description("Show MuninnDB connection status")
          .action(async () => {
            try {
              const health = await client.health();
              const stats = await client.stats();
              console.log(`MuninnDB: ${health.status} (${health.version})`);
              console.log(`Vault: ${cfg.vault}`);
              console.log(`Engrams: ${stats.engram_count}`);
              console.log(`Storage: ${(stats.storage_bytes / 1024).toFixed(1)} KB`);
            } catch (err) {
              console.error(`MuninnDB unreachable: ${err instanceof Error ? err.message : String(err)}`);
              process.exit(1);
            }
          });

        cmd
          .command("search")
          .description("Search MuninnDB memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "6")
          .action(async (query: string, opts: { limit: string }) => {
            try {
              const result = await client.activate([query], {
                maxResults: parseInt(opts.limit),
                threshold: cfg.activateThreshold,
              });
              if (result.activations.length === 0) {
                console.log("No relevant memories found.");
                return;
              }
              for (const a of result.activations) {
                console.log(`\n[${(a.score * 100).toFixed(0)}%] ${a.concept}`);
                console.log(`  ${a.content.slice(0, 200)}`);
                if (a.tags.length > 0) console.log(`  Tags: ${a.tags.join(", ")}`);
              }
              console.log(`\n(${result.total_found} found, ${result.latency_ms}ms)`);
            } catch (err) {
              console.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exit(1);
            }
          });

        cmd
          .command("sync")
          .description("Force sync memory files to MuninnDB")
          .action(async () => {
            const workspace = process.env.OPENCLAW_WORKSPACE ?? join(process.env.HOME ?? "", ".openclaw", "workspace");
            const files = findMemoryFiles(workspace);
            console.log(`Found ${files.length} memory files`);

            let total = 0;
            for (const filePath of files) {
              try {
                const content = readFileSync(filePath, "utf-8");
                const chunks = chunkMarkdown(content, filePath);
                const relPath = relative(workspace, filePath);
                for (const chunk of chunks) {
                  await client.write(chunk.concept, chunk.content, chunk.tags);
                  total++;
                  // Rate limit: small delay between writes to avoid 429s
                  await new Promise((r) => setTimeout(r, 200));
                }
                console.log(`  ✓ ${relPath} (${chunks.length} chunks)`);
              } catch (err) {
                console.error(`  ✗ ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            console.log(`\nSynced ${total} chunks to MuninnDB (vault: ${cfg.vault})`);
          });
      },
      { commands: ["muninndb"] },
    );

    // ========================================================================
    // Service registration
    // ========================================================================

    api.registerService({
      id: "memory-muninndb",
      start: () => {
        api.logger.info(`memory-muninndb: service started (vault: ${cfg.vault})`);
      },
      stop: () => {
        api.logger.info("memory-muninndb: service stopped");
      },
    });
  },
});
