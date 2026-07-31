# AGENTS.md

## 1. Authority

The Iris Notion knowledge base is the architecture and specification source of truth.

Before implementing a task, read the relevant Notion pages through the available Notion MCP or connector. Do not infer their contents from titles, cached summaries, old chat messages, or historical change-log pages.

Primary entry points:

- Design root: https://app.notion.com/p/3a4b98338da58121b863edb88e824edd
- Module ownership: https://app.notion.com/p/3a5b98338da581018d36c47276cb4358
- Roadmap and accepted progress: https://app.notion.com/p/3a9b98338da5819a8380f10dfb60932b
- Agent/memory project separation: https://app.notion.com/p/3aeb98338da581538acedc7ca9da57b9
- Pi compatibility manifest: https://app.notion.com/p/3a7b98338da58164888ad211bb08ca98

Pages under 00–06 define the active specification. Page 07 tracks accepted implementation progress. Historical design-evolution and migration pages are evidence, not the current specification.

If Notion is unavailable and a task requires an architecture or contract decision, stop that part of the work and report the missing access. Do not guess.

## 2. Repository responsibility

This repository owns:

- Persona, Host, Ingress/Admin APIs, and clients
- Pi Runtime Capsule and Runtime Session Epochs
- Context and Magic Context parity
- Historian, ContinuitySnapshot, HistorianPublication, and the authoritative publication outbox
- Tool System and Body adapters
- the stateless Memory Client integration boundary

This repository must not:

- open the Memory Router database
- connect directly to Neo4j
- expose or depend on Graphiti SDK objects
- implement stable memoryRef, graph resolution, RecallDisposition storage, or reindex internals
- copy the cross-project memory DTOs instead of consuming their versioned contract

The separate `iris_memory` project owns the long-term memory service.

## 3. Starting a task

Before editing code:

1. Read this file.
2. Read the relevant active Notion specifications.
3. Inspect the repository and existing tests.
4. Inspect locked upstream source when the task concerns Pi, Magic Context, Graphiti, or Numen.
5. Identify the affected Roadmap milestone and Exit Gate.
6. State any specification conflict before adding a new owner, database, protocol, worker, or durable state.

Prefer adapting Iris to verified upstream semantics. Do not create a parallel implementation of an upstream runtime, context engine, graph engine, or protocol.

## 4. Implementation rules

- Preserve one authoritative owner for every durable state.
- Cross-module and cross-project access must use narrow, versioned contracts.
- Do not access another module's database or concrete repository.
- Every database change requires a forward migration and a clean-database smoke test.
- Every public contract change requires compatibility tests.
- Do not weaken an Exit Gate to make work appear complete.
- Label mock-only behavior as mock-only.
- Do not claim checks were run unless they were actually executed.
- Never commit credentials, private Session data, model payloads, or user content.

## 5. Validation

Run the checks that exist for the affected area. At minimum before opening or updating a PR:

- formatting or syntax checks
- type checking when a typed toolchain exists
- relevant unit tests
- relevant contract tests
- migration smoke tests when persistence changes

Run integration, crash-window, or benchmark tests when the relevant Roadmap Exit Gate requires them.

## 6. Git and pull requests

Use one branch per coherent work item. Push work to GitHub and create or update a Draft PR at a meaningful review point.

The PR description must include:

- Roadmap milestone and Exit Gate
- Notion pages and sections consulted
- implementation summary
- durable-state or public-contract changes
- exact commands and checks executed
- known gaps, mocks, failures, and untested paths
- whether the implementation requires a specification update

Do not directly increase accepted Notion progress. The development agent may report a claimed result in the PR; accepted progress is updated only after review of the diff, checks, and Exit Gate.

## 7. When to stop

Pause only the affected work when:

- required Notion content cannot be accessed
- required repository or environment credentials are missing
- an unresolved cross-project ownership conflict would be introduced
- the task requires a destructive, paid, externally published, or irreversible action
- active specifications contain a root contradiction not resolvable by existing precedence rules

Continue unrelated, non-blocked work where possible.
