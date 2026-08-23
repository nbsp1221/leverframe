# Repository instructions

## Markdown prose

- Do not hard-wrap prose to a fixed column width.
- Keep each prose paragraph on one source line and let editors and renderers soft-wrap it.
- Use physical line breaks only for semantic Markdown structure such as paragraphs, headings, lists, blockquotes, tables, and code blocks.
- Never add width-based line breaks to GitHub issue, pull request, review, or comment bodies because GitHub renders them as visible line breaks.
- The deliberate sentence-per-line formatting in `resources/review-prompt.md` is an exception to the one-line paragraph rule; do not introduce width-based hard wraps elsewhere.

## Change workflow

- Create and continuously synchronize a Multica issue for planned feature work.
- Start a work branch from an up-to-date `main`, then obtain plan approval before implementation.
- On a work branch with no pull request, commits created through the `commit` skill and pushes are pre-authorized.
- Creating a pull request requires explicit user approval. After a pull request exists, every additional push also requires explicit user approval.
- Keep the Multica status and high-signal metadata aligned with the actual work state without waiting for a separate user request.

## Live GitHub testing

- Use only the private repository `nbsp1221/skillpin-private-e2e-20260718` and its existing Pull Request `#1` for live webhook, review, Check Run, comment, cancellation, or supersession tests.
- Never select a live test target from recent database history or convenience. Do not write test events or reviews to active repositories such as `nbsp1221/alphalab` unless the user explicitly approves that exact repository for that individual run.
- Confirm that the Skillpin repository is private and Pull Request `#1` is open immediately before every live test.
- Do not create another Pull Request for testing without explicit user approval.
