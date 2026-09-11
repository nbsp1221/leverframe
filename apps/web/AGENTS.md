<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Leverframe UI system

- Use Tailwind's canonical typography utilities (`text-xs` through `text-3xl`) instead of adding a parallel Leverframe font-size namespace such as `text-metadata` or `text-page`.
- Prefer existing shadcn primitives and variants. Change canonical theme token values only for deliberate system-wide changes after checking their effect across existing shadcn components.
- Treat FHD 1920×1080 as the primary desktop visual QA viewport; keep QHD, mobile, light/dark, and KO/EN as regressions.
- Review list, detail, error, and not-found pages share `ReviewPageFrame`; do not add page-specific outer max-widths. Narrow reading widths may exist inside the shared frame only when they serve a specific reading task.
- Prefer one primary work surface with whitespace/dividers for related review content. Do not introduce nested card surfaces for ordinary internal grouping when a section or disclosure is sufficient.
