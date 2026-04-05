# MemoryVault Phase 2 Batch 1 — Design Spec

> **Scope:** Local experience polish + practical usability gaps.
> Cloud sync, E2EE, Web Dashboard, and IDE plugins are out of scope (future batches).

**Goal:** Make MemoryVault ready for daily production use as a local-first MCP memory server.

**Approach:** Incremental changes on top of the existing codebase. No schema rewrites, no new dependencies.

---

## 1. Data Model Enhancements

### 1.1 Schema Changes (`src/db.ts`)

Add `expires_at` column to `memories` table:

```sql
ALTER TABLE memories ADD COLUMN expires_at TEXT;
```

The `createDatabase` function will add this column via a migration check (use `PRAGMA table_info` to detect if column exists before altering).

New table for version history:

```sql
CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

### 1.2 Type Changes (`src/types.ts`)

```typescript
export interface MemoryEntry {
  // ... existing fields ...
  expires_at?: string;         // ISO 8601, optional expiration
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  content: string;
  reason: string;
  created_at: string;
}

export interface CreateMemoryInput {
  // ... existing fields ...
  expires_at?: string;
}

export interface UpdateMemoryInput {
  // ... existing fields ...
  reason?: string;             // Why this update happened (stored in version history)
  expires_at?: string;
}
```

### 1.3 Store Changes (`src/memory-store.ts`)

- `write()`: Accept and store `expires_at`.
- `update()`: When `content` changes, save the old content to `memory_versions` before updating. Use the `reason` field from input (default: `"updated"`).
- New method: `getVersions(memoryId: string): MemoryVersion[]` — return version history for a memory.
- New method: `forget(id: string, reason?: string): void` — archive a memory (set status to `archived`) and record the reason in a version entry. Unlike `delete()` which hard-deletes, this preserves the data.
- New method: `consolidate(mergeIds: string[], intoContent: string): MemoryEntry` — merge multiple memories into one new memory. Archive the originals with reason "consolidated".
- `list()` and `search()`: Filter out expired memories (where `expires_at` is set and in the past).

### 1.4 MCP Tool Changes (`src/index.ts`)

**Modified tools:**
- `memory_write`: Add optional `expires_at` parameter.
- `memory_update`: Add optional `reason` and `expires_at` parameters.

**New tools:**
- `memory_forget`: Soft-delete with reason. Input: `{ id: string, reason?: string }`. Archives the memory and records why.
- `memory_consolidate`: Merge memories. Input: `{ merge: string[], into: string }`. Archives originals, creates merged memory.
- `memory_versions`: Get version history. Input: `{ id: string }`. Returns the version history for a memory.

**Existing `memory_delete` stays** as a hard delete for when users truly want data gone.

---

## 2. Memory Conflict Detection

### 2.1 Where

Inside `MemoryStore.write()`, before inserting.

### 2.2 Logic

```
1. Semantic search for top-3 similar active memories of the same type
2. If distance < 0.3 (very similar):
   a. If new confidence >= existing confidence:
      - Auto-update the existing memory with new content
      - Save old content to version history with reason "conflict: superseded by newer memory"
      - Return the updated memory with conflict_action: "updated_existing"
   b. If new confidence < existing confidence:
      - Still create the new memory, but set status to "pending_review"
      - Return with conflict_action: "created_pending_review"
3. If no conflict:
   - Normal insert
   - Return with conflict_action: "created"
```

### 2.3 Return Type Change

`write()` return type becomes:

```typescript
export interface WriteMemoryResult {
  memory: MemoryEntry;
  conflict_action: 'created' | 'updated_existing' | 'created_pending_review';
  conflicting_memory_id?: string;  // ID of the memory that conflicted
}
```

MCP tool `memory_write` returns this enriched result.

### 2.4 Conflict Distance Threshold

Use `0.3` as the default threshold. This is configurable but not exposed to MCP — it's an internal constant in `memory-store.ts`.

---

## 3. Memory Organizer (Prompt)

### 3.1 New MCP Prompt: `memory_organize`

A prompt that helps LLMs identify memories that can be consolidated, deduplicated, or expired.

**Input:** None (or optional `project` filter).

**Behavior:**
1. Lists all active memories grouped by type
2. Instructs the LLM to:
   - Identify duplicates or near-duplicates
   - Suggest consolidations (merge related memories)
   - Flag stale or contradictory memories
   - Recommend setting `expires_at` on episode-type memories older than 30 days
3. For each suggestion, tell the LLM which tool to call (`memory_consolidate`, `memory_update`, `memory_forget`)

### 3.2 Implementation

This is a registered MCP Prompt (like the existing `memory_extract` and `memory_review`). It constructs a message with all active memories formatted for analysis.

---

## 4. Project Resource

### 4.1 New MCP Resource: `memoryvault://project/{name}`

A resource template (using `registerResourceTemplate`) that returns all memories associated with a specific project.

**Output format (Markdown):**

```markdown
## Project: {name}

### Architecture & Decisions
- [project-type memories for this project]

### Preferences
- [preference-type memories for this project]

### Rules
- [rule-type memories for this project]

### Recent Episodes
- [episode-type memories for this project, sorted by date]
```

Uses `store.list(undefined, projectName)` to get all memories for a project, then groups by type.

---

## 5. Internationalization (i18n): Chinese → English

### 5.1 Scope

All user-facing strings in `src/index.ts`:
- Server `instructions` block
- All tool `title` and `description` fields
- All prompt `title` and `description` fields
- All resource `title` and `description` fields
- Zod `.describe()` strings on input schemas

### 5.2 Not in Scope

- Code comments (leave as-is, no churn)
- CLI strings in `src/cli.ts` and `src/cli-commands.ts` (already English)
- Test files

---

## 6. Practical Usability

### 6.1 Default DB Path

Change from `./data/memory.db` (relative, breaks depending on CWD) to `~/.memoryvault/memory.db`.

Affected files:
- `src/index.ts`: Update `DB_PATH` default
- `src/cli-commands.ts`: Update `DB_PATH` default
- `.env.example`: Update example

Implementation: Use `os.homedir()` to resolve `~`.

### 6.2 README.md

Create `README.md` with:
- Product tagline and description
- Prerequisites (Node.js, Ollama)
- Installation (npm install, build)
- Configuration (.env)
- MCP integration (Claude Desktop, Claude Code)
- CLI usage
- Available tools/resources/prompts reference
- License

### 6.3 npm Publish Configuration

Update `package.json`:
- Add `files`: `["build", "README.md", "LICENSE"]`
- Add `license`: `"MIT"`
- Add `repository` field
- Add `keywords`
- Add `engines`: `{ "node": ">=18" }`

Create `LICENSE` file (MIT).

### 6.4 .env.example Update

- Remove `OPENAI_API_KEY` (no longer used, switched to Ollama)
- Update `MEMORY_DB_PATH` default comment
- Keep `OLLAMA_BASE_URL`

---

## 7. File Impact Summary

| File | Action |
|------|--------|
| `src/types.ts` | Modify: add `MemoryVersion`, `WriteMemoryResult`, `expires_at`, `reason` |
| `src/db.ts` | Modify: add migration for `expires_at`, create `memory_versions` table |
| `src/memory-store.ts` | Modify: add `forget()`, `consolidate()`, `getVersions()`, conflict detection in `write()`, expire filtering |
| `src/index.ts` | Modify: add 3 new tools, update existing tools, add resource template, i18n all strings |
| `src/cli-commands.ts` | Modify: update DB path default |
| `.env.example` | Modify: update defaults |
| `package.json` | Modify: add publish config |
| `README.md` | Create |
| `LICENSE` | Create |
| `tests/memory-store.test.ts` | Modify: add tests for new methods |
| `tests/conflict.test.ts` | Create: conflict detection tests |
| `tests/consolidate.test.ts` | Create: consolidation tests |
| `tests/versions.test.ts` | Create: version history tests |

---

## 8. Out of Scope

- Web Dashboard (Phase 2 Batch 2)
- End-to-end encryption (Phase 2 Batch 3)
- Cloud sync (Phase 2 Batch 3)
- Cursor / VS Code plugins (Phase 2 Batch 3)
- Knowledge graph (Phase 3)
- E2E tests with real Ollama (nice-to-have, not blocking release)
- Approval mechanism for new memories (PRD §5.5.2 — deferred, requires UI)
