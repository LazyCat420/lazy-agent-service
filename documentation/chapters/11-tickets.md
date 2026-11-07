---
part: Governance
type: ledger
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:documentation/tickets.jsonl
---

# Ticket ledger

This page is generated from `documentation/tickets.jsonl` by `build_docs.py`. Do not edit it
here: edit the ledger. Every milestone, verified bug fix, and open roadmap item for
lazy-agent-service lives in that file, with its owner repo, severity, execution node
(`documentation/execution_graph.json`), verification command, and covered code paths.

A ticket is only `closed` with a `verified_by` naming the command that proved it and the date it
ran, and a `closed_by.commit` that exists in this repo's git history. Closed tickets stay in the
file as searchable history. Trading-cycle-side problems are **not** filed here — they live in
`finance/trading/trading-client/documentation/tickets.jsonl` with
`owner: lazy-agent-service`.
