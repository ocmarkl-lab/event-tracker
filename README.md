# Pava Event Tracker

Shared meeting tracker for trade fairs and conferences (ECOC, SEMICON, Laser World of Photonics …) with a team chat that can answer questions, draft outreach and update the tracker.

- **Live:** Render web service `pava-event-tracker` (password-protected, `noindex`)
- **Source of truth:** `data/<event-slug>.json` in this repo. Every edit in the app is committed back here (commit message `tracker(<slug>): … by <name>`), so the history is the audit log.
- **No dependencies:** Node ≥ 20, `node server.js`.

## Environment (Render → Environment)

| Key | Purpose |
|---|---|
| `APP_PASSWORD` | Shared team password (required) |
| `ANTHROPIC_API_KEY` | Enables the chat panel |
| `GITHUB_TOKEN` | Fine-grained PAT, **only this repo**, permission *Contents: Read and write*. Without it edits live in memory only |
| `GITHUB_REPO` / `GITHUB_BRANCH` | Defaults `ocmarkl-lab/event-tracker` / `main` |
| `CLAUDE_MODEL` | Default `claude-opus-5` |
| `HUNTER_API_KEY` | Enables email lookup in the chat (Hunter.io). Without it the chat can still draft emails |
| `HUNTER_DAILY_CAP` | Max Hunter lookups per day across all users (default 60) |

`render.yaml` ignores `data/**` for auto-deploy, so tracker edits don't restart the service.

## Adding an event

Add `data/<slug>.json` (copy `data/ecoc-2026.json`): event header fields, `tiers`, and `rows[]` with
`id, tier, company, country, stand, sector, why, contact, status, slot, notes, updatedBy, updatedAt`.
`status` ∈ `To approach | Attempted | Confirmed | Met | Declined | Skip`. The app lists all files in `data/` automatically — no redeploy needed. URL: `/e/<slug>`.

## API

- `GET /api/events` — list
- `GET /api/events/:slug` — event + rows + `version`
- `POST /api/events/:slug/rows/:id` — `{status?, slot?, notes?, contact?, by}`
- `POST /api/events/:slug/chat` — `{messages:[{role,content}], by}` → `{text, changed[]}`

## Chat scope

Available to anyone logged in, but limited to the event being viewed: the system prompt only contains that event's rows and tells the model to decline anything else. Tools: `update_company` (status/slot/notes/contact of an existing row in that event) and, with `HUNTER_API_KEY`, `find_email` / `find_company_contacts` — both only accept a `row_id` of the current event, and a found address is saved to the row only if the user agrees. Email drafts come back as `To / Subject / body`; the UI shows an "Open in mail app" link (mailto) — the server never sends mail or touches a mailbox. It has no connection to DealTracks, CRM, mail or calendars — it offers paste-ready text instead. Rate limit: 100 chat requests per hour per IP. Requires `ANTHROPIC_API_KEY`; without it the chat button is hidden.

## Local

```
APP_PASSWORD=dev node server.js   # without GITHUB_TOKEN it reads data/ locally, edits stay in memory
```
