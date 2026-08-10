# IPython Programmatic Context Access — Preliminary Research

**Date:** 2026-08-10

**Status:** Research conclusion; not an implementation specification

**Scope:** Give the Crest agent programmatic access to context outside the current model window without introducing a second context-storage system.

## Executive Summary

Prime Agent's important idea is not IPython persistence by itself. It is the combination of:

1. keeping the complete input outside the model window;
2. letting the model inspect and transform that input with code;
3. returning only a bounded, selected result to the model.

Crest already has the durable input store: each session is an append-only SQLite database with a branchable entry tree. The smallest design that captures Prime's core benefit is therefore:

```text
existing Session SQLite
        ↓
one read-only session_history() host call
        ↓
persistent IPython scratchpad
        ↓
bounded stdout/result returned to the model
```

The initial design should not add a generic Context Workspace, Artifact Store, content-addressed blob store, query language, durable Python namespace, exported conversation file, or model-facing `context` object.

Kernel variables and helper functions are working memory. They may survive ordinary IPython calls and model compaction, but they are intentionally discarded on application restart, runtime disposal, or session-tree navigation. Durable facts remain in the existing session transcript and project files and can be recomputed.

## Research Question

How can Crest gain Prime Agent's programmatic context-management behavior while preserving a small architecture and reusing Crest's existing session model?

The investigation focused on four questions:

1. Why does Prime use IPython?
2. Why does the IPython process need access to conversation history?
3. Should Crest expose that history through a file, direct SQLite access, or a host function?
4. Which state must be durable, and which state can remain disposable?

## What Prime Agent Is Actually Doing

An IPython kernel does not automatically see the model prompt or transcript. A tool call sends code to a separate process; without another input channel, that process knows only its existing Python namespace and the code in the current call.

Prime addresses this by putting the conversation-log path in the agent prompt. The model can read the log with ordinary Python, retain large intermediate values in the kernel, and print only the relevant subset. Prime also exposes typed host operations to Python while keeping provider calls, child-agent lifecycle, persistence, accounting, and policy in the TypeScript host.

This produces the useful RLM loop:

```text
short model context
      │ writes code
      ▼
IPython ── reads/searches/transforms ──> full external context
      │
      └── prints only selected evidence ──> model context
```

The resulting advantage is programmatic composition. One cell can filter thousands of records, aggregate data, or arrange repeated calls without requiring a new model turn for every intermediate operation.

Prime's persistent namespace improves convenience, but it is not a reliable database. Its session revival uses per-variable, best-effort `dill` snapshots and cannot guarantee restoration of open files, sockets, running tasks, native resources, or every library object. Prime also states that its kernel process is not a security sandbox.

## Runtime Alternatives

The research did not find a single runtime that is strictly better than IPython for the initial experiment.

| Runtime or interface | Strength | Limitation | Role in Crest |
| --- | --- | --- | --- |
| IPython | Strong model prior, concise data transformation, top-level async, mature Jupyter protocol and Python ecosystem | Separate runtime, sequential cell execution, not a sandbox | Recommended first programmable context runtime |
| Deno/TypeScript | Same language family as Crest, strong JSON/async ergonomics, npm access | Does not solve hidden kernel state; Deno's Jupyter mode currently runs with `--allow-all` | Possible later adapter if packaging or TypeScript-heavy workloads justify it |
| SQLite/SQL | Efficient durable filtering and indexing | Not a complete control language for arbitrary algorithms or recursive agent calls | Existing data source and possible future query optimization |
| WASM/Pyodide/QuickJS | Better capability isolation and portability | Smaller package/runtime ecosystem and more restricted host integration | Possible future restricted execution mode |
| Typed model tools only | Clear schemas, permissions, and auditability | Complex composition remains in the model turn loop and intermediate results consume context | Keep for common operations, but it does not reproduce the full RLM behavior |

The durable-state problem is independent of the language. Replacing Python with TypeScript does not make a long-lived heap branch-aware or reliably replayable. The initial decision should therefore optimize for the quality of the model-facing programming environment; IPython remains the strongest baseline.

## Prime and Crest: Intended Difference

Both designs externalize large context and let code select what returns to the model. The proposed Crest experiment differs only where the existing session architecture makes a smaller choice possible:

| Concern | Prime Agent | Proposed Crest experiment |
| --- | --- | --- |
| History access | Conversation-log path exposed to the model | One host function backed by the current session tree |
| Durable history | Session transcript and host-owned registries | Existing Session SQLite |
| Kernel revival | Best-effort namespace snapshot | No namespace persistence initially |
| Branch changes | Kernel/session lifecycle handles restoration behavior | Dispose the kernel when the active leaf changes |
| Model-facing context API | Python, files, skills, and host requests | Python plus `session_history()` for the first spike |

This is intentionally close to Prime's algorithm. The difference is not a new theory of context management; it is a thinner adapter to Crest's already-structured session store.

## Relevant Crest Architecture

### Session SQLite is the durable history

`SqliteSessionStorage` stores one database per session. Its append-only `entries` table records entry ID, parent ID, type, timestamp, target ID, and the exact serialized entry payload:

- `packages/agent/harness/session/sqlite-storage.ts`

The parent chain represents the session tree. `Session.getBranch()` resolves the path from the current leaf to the root:

- `packages/agent/harness/session/session.ts`

This is already the correct durable backing store for programmatic history access. A second history store would duplicate data and introduce synchronization, retention, and migration problems.

### Context Ledger is not the complete transcript store

The current Context Ledger answers what effective context the agent will inherit on its next provider call. It observes model-visible instructions, tools, conversation, and explicitly added references:

- `docs/superpowers/specs/2026-08-03-context-ledger-design.md`

Existing `ContextArtifact` values are immutable conversation-reference snapshots. They are useful for explicit user-selected references, but they are not intended to be a general agent-memory or arbitrary-data system:

- `packages/coding-agent/context/types.ts`
- `packages/coding-agent/context/snapshot.ts`

Programmatic access to complete historical context should therefore read the session tree, not reinterpret the Context Ledger as a new database.

### Compaction must not erase programmatic history

`buildSessionContext()` intentionally constructs the effective model-visible conversation. After compaction, it replaces covered history with the compaction summary.

That behavior is correct for provider requests but incorrect for the proposed RLM data source: the purpose of `session_history()` is to let the model recover details that no longer fit in the provider context.

The host function should therefore start from the complete active branch returned by `Session.getBranch()`, filter uncommitted transaction entries, and normalize durable message/tool content without dropping entries covered by compaction. Compaction entries should remain available as metadata, but they must not replace the original branch content in this API.

## Alternatives Considered

### A. Export an active conversation JSONL file

This most closely resembles Prime's `messagesPath` design.

**Advantages**

- ordinary Python and shell tools can read it;
- easy for a model to understand;
- isolates IPython from Crest's SQLite schema.

**Disadvantages**

- duplicates session content;
- needs regeneration after every relevant append or navigation;
- introduces stale-view and cleanup behavior;
- is unnecessary because the Crest host already owns the session object.

**Conclusion:** viable, but not the smallest Crest-native design.

### B. Let Python query the raw SQLite database

Python could open the session database in read-only mode with `sqlite3`.

**Advantages**

- no copied conversation file;
- SQL can filter before transferring data;
- uses the current source of truth directly.

**Disadvantages**

- exposes internal tables and serialized entry schemas to the model;
- requires Python code to reconstruct the active branch;
- risks duplicating transaction and compaction semantics already implemented in TypeScript;
- makes future storage migrations part of the model-facing contract.

**Conclusion:** useful for a diagnostic spike, but raw SQL should not be the stable model API.

### C. Expose one read-only `session_history()` host function

The IPython bootstrap pre-imports one async function backed by the existing session owner:

```python
history = await session_history()
```

The returned value is a Python list of normalized dictionaries representing the complete durable active branch. The model uses ordinary Python for search, slicing, aggregation, and helper functions.

**Advantages**

- no new storage;
- no exported file;
- no model-visible SQLite schema;
- reuses the authoritative current-leaf and transaction logic;
- keeps the Python API to one operation;
- preserves the RLM benefit because the returned history stays in Python until selected output is printed.

**Disadvantages**

- transfers the active branch to the kernel on first load;
- requires a small typed host bridge;
- very large sessions may eventually need range or query parameters.

**Conclusion:** recommended initial design.

## Recommended Minimal Design

### 1. IPython is a scratchpad

Use one IPython kernel per active agent session runtime. Variables, imports, parsed history, and helper functions persist across ordinary tool calls and model compaction.

The kernel namespace is not durable state:

- application restart discards it;
- runtime eviction discards it;
- navigating to another session-tree leaf must discard it to avoid mixing future-branch variables into an earlier branch;
- no initial namespace snapshot or replay mechanism is required.

### 2. `session_history()` is the only new context primitive

Initial semantics:

- read-only;
- no arguments;
- returns the complete durable active branch in chronological order;
- includes original content covered by compaction;
- excludes uncommitted transaction entries;
- returns normalized JSON-compatible values rather than internal class instances;
- includes stable entry IDs and types so later analysis can cite its source.

Example:

```python
history = await session_history()

matches = [
    entry
    for entry in history
    if "websocket timeout" in str(entry).lower()
]

print(matches[:20])
```

There is no initial `context_search`, `context_read`, `context_attach`, ContextQL, or `context` object. Python implements the search and transformation. Printing or returning a bounded value is the attach operation.

### 3. The host remains authoritative

The TypeScript host owns:

- session and active-leaf selection;
- transaction filtering;
- normalization of durable entries;
- kernel creation, reset, interrupt, and disposal;
- output limits and tool-result shaping.

IPython owns only disposable computation. It must not become a second implementation of session-tree semantics.

### 4. Large-history behavior is deferred until measured

The first version loads the active branch on demand and lets the model retain it in a Python variable. This is deliberately simple and matches the external-context premise of RLMs.

Only if real Crest sessions show unacceptable transfer time or memory use should the same function gain bounded parameters such as an entry range or simple text query. SQLite FTS, semantic search, cross-session search, and streaming are optimizations behind the same boundary, not prerequisites for the first experiment.

## Explicit Non-Goals

The preliminary design does not include:

- persistent arbitrary Python variables or functions;
- automatic cell replay;
- a generic Workspace Manifest;
- a new Artifact or blob-storage system;
- a conversation JSONL mirror;
- direct raw SQLite access as the model contract;
- cross-session or project-wide retrieval;
- semantic/vector search;
- durable background workflow orchestration;
- replacement of the current user-facing context-reference feature.

## Failure and Lifecycle Semantics

- If history loading fails, the Python call returns a typed error and does not mutate session state.
- If the kernel dies, the host starts a clean kernel; the agent may call `session_history()` again.
- If the active leaf changes, the existing kernel must be disposed before subsequent execution.
- A history read is a consistent observation of one leaf revision. A concurrent append may appear on the next call rather than the current result.
- IPython output must be bounded. Oversized values remain in Python; the model receives a truncation notice and can print a narrower selection.
- Model-generated Python has the same trust implications as other local code execution. The kernel boundary is lifecycle isolation, not a security sandbox.

## Validation Plan

The smallest useful spike should validate the algorithm rather than build a platform.

1. Create a session containing messages, tool results, a committed context transaction, and compaction.
2. Verify `session_history()` returns the complete active branch, including original pre-compaction content, while excluding uncommitted transaction entries.
3. Create a second branch and verify navigation resets the kernel and returns only the newly active branch.
4. Load a large history into Python, search it locally, and confirm only printed matches enter the model tool result.
5. Kill and restart the kernel and verify history remains recoverable even though temporary variables are gone.
6. Compare a few long-history tasks against the existing tool-only agent using task success, model input tokens, wall time, and number of model turns.

The experiment succeeds if it demonstrates meaningful long-context retrieval or aggregation benefits without requiring another persistence subsystem.

## Decision Summary

The research converged on the following principles:

1. The valuable Prime idea is programmatic access to external context, not durable interpreter state.
2. Crest's existing Session SQLite database is already the durable context source.
3. A generated conversation file is unnecessary in Crest.
4. Raw SQLite is an implementation detail, not a good long-term model contract.
5. One read-only `session_history()` function is sufficient for the first experiment.
6. Python variables are disposable working memory; session history and project files remain durable.
7. Additional indexing, persistence, and retrieval abstractions must be justified by measured failures of this minimal design.

## Sources

### Prime Agent and RLM

- [Prime Agent RLM prompt](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/prompts/rlm.ts)
- [Prime Agent IPython tool](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/tools/ipython.ts)
- [Prime Agent RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [Prime Agent RLM runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- [Recursive Language Models](https://arxiv.org/abs/2512.24601)
- [Prime Intellect RLM research note](https://www.primeintellect.ai/blog/rlm)
- [Deno Jupyter kernel](https://docs.deno.com/runtime/reference/cli/jupyter/)

### Crest

- `packages/agent/harness/session/sqlite-storage.ts`
- `packages/agent/harness/session/session.ts`
- `packages/agent/harness/session/entry-transaction.ts`
- `packages/coding-agent/context/journal.ts`
- `packages/coding-agent/context/types.ts`
- `docs/superpowers/specs/2026-08-03-context-ledger-design.md`
- `docs/specs/2026-07-20-cross-session-context-reference-design.md`
