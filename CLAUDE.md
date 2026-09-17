# Event Tracker — notes for Claude / Anni

- Producer of `data/<slug>.json`: the `mna-trade-fair-planner` workflow (exhibitor screening → tiering). Write a new event as a new file; never rewrite rows of a live event wholesale — the team edits `status/slot/notes/contact` in the app and those commits must not be overwritten. To change tiering, edit individual rows.
- Confidential: this repo is PRIVATE. Pipeline metadata only (company, why-meet, status). No client documents, no personal emails/phone numbers.
- Push to `main` = live (Render auto-deploys code; `data/**` changes are picked up at next load without deploy). When code changes, update README.md in the same commit.
- Anni's register snapshot lives in `ocmarkl-lab/anni` → `ORIGINATION/EVENTS/`. After an event: summarise Met/Confirmed rows into `ORIGINATION/PIPELINE.md`.
