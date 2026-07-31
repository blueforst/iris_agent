# Iris Agent

Iris Agent is the runtime and identity project for Iris. It owns the Host, Pi Runtime Capsule, Runtime Session Epochs, Context, Historian, tools, bodies, clients, and the Memory Client boundary.

The active architecture and implementation roadmap live in the Iris Notion knowledge base. Read [`AGENTS.md`](./AGENTS.md) before making changes.

## Project boundary

This repository does **not** own the long-term memory service, Memory Router database, Neo4j, Graphiti internals, stable memory references, RecallDisposition storage, or graph reindexing. Those belong to the separate `iris_memory` project and are accessed only through a versioned memory contract.

## Status

Implementation is at the repository-bootstrap stage. Empty scaffolding does not count as accepted Roadmap progress.

## Local checks

```bash
npm ci
npm run check
```

Node.js `22.19.0` or newer is required.
