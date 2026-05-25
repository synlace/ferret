# Context: Workspace Domain

## Glossary

### Workspace
A directory on the filesystem containing all targets, results, logs, and state related to a specific domain or host.

### Live Workspace
A workspace whose associated target host or domain is currently reachable, verified via background HTTP/TCP liveness probes.

### Dead Workspace (Unreachable)
A workspace whose target host or domain has failed the background HTTP/TCP liveness probe and is marked as `unreachable`.

### Workspace Tree
A hierarchical view of workspaces (for example, parent domain `google.com` with child subdomain `admin.google.com`) based on path-prefix or explicit relationships.

### Workspace Sorting
The ability to sort workspaces (both at the root level and children nested within parent workspaces) by name or by HTTP status code to prioritize viewing active, responding targets.
