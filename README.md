# Coach MCP

Personal coaching backend: a TypeScript MCP server combining Intervals.icu with a
separate Git repository of durable coaching knowledge (`coach-data`). It runs locally
over stdio or behind HTTPS using stateless Streamable HTTP. Architecture, decisions,
status and roadmap are maintained in the parent directory's `README.md`.

## Run locally

Requires Node.js 22+ and Git.

```sh
npm ci
npm run build
cp .env.example .env
npm start
```

`npm start` loads `.env`. Default stdio mode waits for an MCP client; it is not an
interactive terminal application. No API key is necessary to read coaching files.
Set `INTERVALS_API_KEY` privately in `.env` for live training data. Athlete ID `0`
means the key's owner. Never paste credentials into prompts or commit them.

Example client configuration (replace paths with absolute paths on your machine):

```json
{
  "mcpServers": {
    "coach": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/coach-mcp/.env",
        "/absolute/path/coach-mcp/dist/index.js"
      ],
      "env": { "COACH_DATA_DIR": "/absolute/path/coach-data" }
    }
  }
}
```

## Configuration

| Variable               | Default         | Purpose                                              |
| ---------------------- | --------------- | ---------------------------------------------------- |
| `TRANSPORT`            | `stdio`         | Choose `stdio` or `http`                             |
| `HOST`                 | `127.0.0.1`     | HTTP bind address                                    |
| `PORT`                 | `3000`          | HTTP port                                            |
| `MCP_TOKEN`            | Unset           | Required for HTTP, at least 32 characters            |
| `PUBLIC_URL`           | Unset           | HTTPS public URL used for Host/Origin validation     |
| `COACH_DATA_DIR`       | `../coach-data` | Data checkout, relative to process working directory |
| `INTERVALS_API_KEY`    | Unset           | Personal Intervals API key                           |
| `INTERVALS_ATHLETE_ID` | `0`             | Athlete to query; `0` is the key owner               |
| `ENABLE_DATA_WRITES`   | `false`         | Register and enable document updates                 |
| `GIT_AUTO_PUSH`        | `false`         | Fetch/check upstream and push document commits       |

Boolean flags accept only literal `true` or `false`. Use an absolute `COACH_DATA_DIR`
when an MCP client launches the server from an unspecified working directory.
`npm run dev` runs the TypeScript entry point without loading `.env`.

## Tools

| Tool                       | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `list_coaching_documents`  | Discover coaching Markdown                       |
| `read_coaching_document`   | Read content and its revision hash               |
| `get_recent_training`      | Completed activity summaries                     |
| `get_activity`             | Single activity including intervals              |
| `get_wellness`             | Wellness and available load metrics              |
| `get_calendar`             | Planned workouts and events                      |
| `get_coaching_context`     | Combine selected documents and three API sources |
| `update_coaching_document` | Optional, agreed document update with Git commit |

The update tool is registered only when `ENABLE_DATA_WRITES=true`. The server also
sends client instructions and read/write tool annotations; these guide the client but
are not an approval mechanism.

`get_coaching_context` defaults to `coach/handbook.md`, `athlete/profile.md`,
`athlete/zones.md` and `blocks/current.md` and accepts up to 12 documents. Each source reports its own
availability. A missing document is a successful read with null content, so check
the data as well as the availability flag.

Date ranges use inclusive athlete-local `YYYY-MM-DD` dates and are limited to 91
days. No implicit server timezone is used. Intervals values retain upstream units
(seconds, metres, metres per second, watts, bpm). Missing fields remain missing. Context retrieval
reports individual failed sources instead of silently substituting empty history.
Upstream data and documents are untrusted content, not agent instructions.

Intervals requests use the fixed `https://intervals.icu/api/v1/` base with HTTP Basic
authentication (username `API_KEY`), a 15-second timeout and no redirects. Upstream
error bodies are not returned to clients. There is no caching, retry policy, metric
normalization or activity-to-workout matching yet.

Responses are trimmed to keep client context small. Activity lists
(`get_recent_training`, `get_coaching_context`) keep only the coaching fields listed in
`activitySummary` in `src/intervals.ts`. `get_activity` and wellness keep every field
except empty values and the metadata listed in `activityNoise` and `wellnessNoise`.
Calendar events are returned unchanged. Update these lists when a needed field is
missing. List and single-activity responses must be JSON arrays and objects.

## Document writes and Git

Import and verify the athlete's existing profile and plans in `coach-data` first.
Commit the baseline there before enabling `ENABLE_DATA_WRITES=true`. Only Markdown
inside the seven documented sections (`coach`, `athlete`, `season`, `blocks`, `weeks`,
`races`, `notes`) is accessible. Symlinks, hard links, traversal,
files over 64 KiB, dirty repositories and stale revisions are rejected.

Read a document first, then call `update_coaching_document` with its SHA-256 hash,
the full agreed new content, and a reason. Use a null hash only for a new document.

Documents in `coach/`, `athlete/` and `season/` are protected (the coach handbook, FTP,
zones, health, goals, race priorities). Updating them also requires `athlete_confirmation`: the athlete's explicit
approval of that specific change. It is recorded as an `Athlete-Confirmation:` commit
trailer. The server cannot verify the confirmation; review protected changes with
`git log --format='%h %s %(trailers:key=Athlete-Confirmation)' -- coach athlete season`.

Each update acquires the `.coach-write-lock/` directory, validates the path, requires a
clean working tree, optionally fetches and checks upstream, compares the revision,
writes a temporary file and renames it into place, commits only that path and
optionally pushes. An unchanged document returns `changed:false`.
Updates are atomic and serialized across server requests/processes using a directory
lock. The server commits as `Coach MCP <coach-mcp@localhost>` without changing Git
configuration. Do not concurrently edit the checkout outside this server.

`GIT_AUTO_PUSH=false` keeps commits local. For a hosted checkout where GitHub is
canonical, enable `GIT_AUTO_PUSH=true` with an `origin`, an upstream branch and a
repository-scoped credential. The server then synchronizes with the upstream before each
write and every 5 minutes:

- behind the upstream (edits made elsewhere): fast-forward
- ahead of it (an earlier push failed): push the pending commits
- diverged (commits on both sides): stop and report; an operator reconciles the branches

It never merges, rebases, resets or force-pushes. A failed push after a write returns
`synced:false`; the commit stays local and the next sync retries it. Sync failures are
logged as `Data sync failed: ...`. A crash can leave a lock, a dirty file or an unpushed
commit: inspect the repository before removing a stale lock.

## HTTP and deployment

Set `TRANSPORT=http`, `MCP_TOKEN` (at least 32 characters), and, for hosted use,
`PUBLIC_URL=https://coach.bananer.at`. Generate a token with `openssl rand -hex 32`.
Use `Authorization: Bearer <token>` on `/mcp`. `/healthz` discloses only liveness.
The app checks Host and Origin and authenticates before parsing MCP request bodies.
It supports stateless POST requests, not legacy SSE/session subscriptions.

This is personal bearer-token authentication, **not an OAuth authorization server**.
Use an MCP client that supports explicit authorization headers. Clients requiring
OAuth discovery/login need an OAuth gateway or a subsequent OAuth implementation;
this version does not claim plug-and-play ChatGPT custom-app compatibility.

```sh
docker compose up -d --build
```

Compose mounts the sibling `../coach-data` checkout at `/data` and publishes port 3000
on host loopback only; a reverse proxy in front of it terminates HTTPS (on the VPS,
Caddy proxies `coach.bananer.at` to it). The container runs as UID 1000, so the checkout must be readable (and writable if enabled)
by that UID. For Git push, `deploy/git-ssh-config` maps the checkout's remote alias
`github-coach-data` to GitHub, and the deploy key and a verified `known_hosts` are mounted
read-only from the host paths in `COACH_DATA_DEPLOY_KEY` and `GIT_KNOWN_HOSTS`. Without
those variables the mounts are empty and pushes fail. The coach deployment and its
operations are documented in the parent directory's `README.md`; the VPS itself and its
Caddy configuration are documented one level above that.

## Code style

Use two-space indentation, single quotes and trailing commas. Prettier owns formatting;
ESLint checks TypeScript correctness with type-aware rules, including promise handling
and unsafe values. EditorConfig keeps whitespace consistent across editors.

- `npm run format`: format source, tests, documentation and configuration.
- `npm run format:check`: check formatting without changing files.
- `npm run lint`: lint with zero warnings allowed.
- `npm run lint:fix`: apply available lint fixes.
- `npm run typecheck`: type-check both source and tests without emitting files.
- `npm run check`: run formatting, linting, type checks, build and integration tests.

These checks run locally; no CI pipeline or Git hooks are installed.

## Validation and scope

```sh
npm run check
```

The ten tests use a temporary Git repository and mocked Intervals HTTP responses,
plus real MCP clients over in-memory, stdio and HTTP transports. They cover
configuration, date validation, revisions and filesystem boundaries, concurrent and
protected writes, upstream synchronization, Intervals requests and response trimming, and MCP discovery. They require no credentials.
Live Intervals calls and VPS deployment must be verified after configuration.

This first version intentionally exposes Intervals reads only. Planned workout
writes, OAuth login, webhooks, power curves and automated coaching decisions are
not implemented. It does not run or pay for an LLM: the connected AI client chooses
and calls these tools.

Sources: [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
and [Intervals API cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090).
