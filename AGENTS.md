# Repository instructions

## Markdown prose

- Do not hard-wrap prose to a fixed column width.
- Keep each prose paragraph on one source line and let editors and renderers soft-wrap it.
- Use physical line breaks only for semantic Markdown structure such as paragraphs, headings, lists, blockquotes, tables, and code blocks.
- Never add width-based line breaks to GitHub issue, pull request, review, or comment bodies because GitHub renders them as visible line breaks.
- The deliberate sentence-per-line formatting in `resources/review-prompt.md` is an exception to the one-line paragraph rule; do not introduce width-based hard wraps elsewhere.

## Internal documentation

- Store private specifications, implementation plans, work logs, research, prototypes, deployment evidence, and other agent-only working documents only under `.internal/`. Do not put internal planning documents under tracked paths such as `docs/plans/`.
- Keep `.internal/` ignored by Git. Never force-add its files. Public product and operator documentation may remain in tracked `docs/` paths when it is intentionally part of the repository deliverable.
- Give every internal work package a root directory named `.internal/<number>-<task>/`, where `<number>` is exactly four decimal digits and `<task>` is a concise kebab-case name.
- When a Multica ticket exists, use its numeric identifier zero-padded to four digits. For example, `PER-50` maps to `.internal/0050-review-sandbox/`. Keep one root package per ticket and place subordinate material inside that package.
- When no Multica ticket exists, assign the next unused local number starting at `0001` and keep that number stable. Ticket-backed numbers take precedence; if a later ticket collides with a local number, move the ticketless package to the next unused local number and update its references.
- Use lowercase canonical names `spec.md`, `plan.md`, and `ledger.md` when those document roles exist. Put supporting evidence under descriptive lowercase filenames or subdirectories such as `artifacts/` and `deployments/`.
- Before creating an internal document, inspect existing `.internal/` packages and Multica for the work item. Reuse the matching package instead of creating a parallel location.
- When a package is linked to Multica, keep the issue metadata and any path references synchronized with its canonical `.internal/` path.

## Live GitHub testing

- Use only the private repository `nbsp1221/skillpin-private-e2e-20260718` and its existing Pull Request `#1` for live webhook, review, Check Run, comment, cancellation, or supersession tests.
- Never select a live test target from recent database history or convenience. Do not write test events or reviews to active repositories such as `nbsp1221/alphalab` unless the user explicitly approves that exact repository for that individual run.
- Confirm that the Skillpin repository is private and Pull Request `#1` is open immediately before every live test.
- Do not create another Pull Request for testing without explicit user approval.
