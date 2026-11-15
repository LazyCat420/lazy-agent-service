---
part: Governance
type: ledger
status: verified
updated: 2026-11-15
last-verified: 2026-11-15
review-by: 2026-12-15
covers: lazy-agent-service:documentation/tickets.jsonl
---

# Ticket ledger

This page is generated from `documentation/tickets.jsonl` by `build_docs.py`. Do not edit it
here: edit the ledger. Every milestone, verified bug fix, and open roadmap item for the Agent
Platform — lazy-agent-service, scraper-service, spark-console and tts-service — lives in that
file, with its owner repo, severity, execution node (`documentation/execution_graph.json`;
the siblings are `scraper_service`, `spark_console` and `tts_service`), verification command,
and covered code paths (`<repo>:<path>`).

A ticket is only `closed` with a `verified_by` naming the command that proved it and the date it
ran (run from the owner repo's root), and a `closed_by.commit` (`<repo>:<sha>`) that exists in
the owner repo's git history. Closed tickets stay in the
file as searchable history. Trading-cycle-side problems are **not** filed here — they live in
`finance/trading/trading-client/documentation/tickets.jsonl` with
`owner: lazy-agent-service`.
