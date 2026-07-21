# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased] - Deathnerd/job-ops fork

### Added

- MCP server at `POST /mcp` (Streamable HTTP, stateless), gated behind `JOBOPS_MCP_ENABLED` (default off). 47 consolidated tools cover every `/api/*` endpoint across jobs, pipeline, ghostwriter, design-resume, profile/settings, watchlist, post-application/workday, and misc domains; a router-walking contract test keeps coverage complete.
- Per-user API keys (SHA-256 hashed at rest) accepted as bearer credentials alongside JWTs; management endpoints at `/api/auth/api-keys` and a Settings -> API Keys card. Keys work for plain REST calls as well as MCP.
- Docs: `docs-site/docs/features/mcp-server.md`.

### Changed

- TypeScript upgraded to 7.0 (native compiler) in the five type-check workspaces; tsconfigs migrated off removed options (`baseUrl`, `importsNotUsedAsValues`).

### Fixed

- `GET /api/auth/me` resolves identity via the request context instead of re-verifying the JWT itself.
- Auth guard fails closed (401) on resolver errors instead of surfacing a 500.

### Security

- `DELETE /api/database` now requires a system-admin account (was reachable by any authenticated user).
- `/mcp` authenticates before body parsing (no 4MB parse for unauthenticated callers).
