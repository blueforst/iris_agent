export const projectBoundary = Object.freeze({
  project: "iris-agent",
  owns: Object.freeze([
    "host",
    "pi-runtime-capsule",
    "runtime-session-epochs",
    "context",
    "historian",
    "tools",
    "bodies",
    "memory-client"
  ]),
  excludes: Object.freeze([
    "memory-router-database",
    "neo4j",
    "graphiti-sdk",
    "stable-memory-ref-registry",
    "graph-reindex"
  ])
});

export function describeProject() {
  return `${projectBoundary.project}: ${projectBoundary.owns.join(", ")}`;
}
