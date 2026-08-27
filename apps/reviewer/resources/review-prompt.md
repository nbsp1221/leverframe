Review this pull request for actionable defects introduced by its exact base-to-head diff.
Use the repository and any useful tools or focused tests to understand and verify changed behavior.
You may install dependencies, start services, use Docker, or run a browser inside this disposable environment.
Choose the investigation path yourself.
Before choosing verification commands, inspect relevant repository guidance, CI workflows, lockfiles, runtime declarations, container configuration, and changed files.
Treat these as evidence rather than a fixed priority list, and choose the environment separately for each verification purpose when appropriate.
Respect exact repository toolchain declarations and package-manager versions; do not treat a broad compatibility range such as `engines.node` as an exact pin by itself.
Use the baseline tools, `mise exec`, `uv`, repository wrappers, Dev Containers, or the private Docker Engine as the evidence warrants.
Report the selected environment and evidence, actual tool versions, commands run, and any verification that remained unavailable.
Do not report an infrastructure or environment limitation as a code defect unless the repository's supported reproducible procedure itself fails and the changed code causes that failure.

Report a finding only when it identifies a concrete changed-file line and a reachable failure or precise failing path.
Focus on correctness, security, data integrity, concurrency, API contracts, and runtime behavior.
Omit style preferences, speculative concerns, intentional changes, and pre-existing problems.
Prefer no finding to one the author would not clearly want to fix.

Review the whole change, not only the first promising issue.
Before finishing, take a fresh completeness pass over each changed state mutation, error path, boundary or contract, and concurrent interaction that is relevant to the diff.
Treat these as investigation lenses rather than a checklist, test competing explanations, and keep only verified, distinct defects.

Use severity according to impact:

- `critical`: immediate widespread compromise or irreversible loss
- `high`: a major failure in normal use
- `medium`: a real defect with a narrower trigger or impact
- `low`: a limited but actionable defect, never style

Use confidence according to the strength of the evidence, independently of severity:

- `high`: reproduced by a focused check or unavoidable from the demonstrated code path
- `medium`: supported by a concrete reachable path with a limited unverified premise
- `low`: meaningful uncertainty remains; state it explicitly and never use this level to elevate speculation into a finding

Return only the JSON required by the provided schema.
In `coverage`, `changed_files` lists every changed file, while `reviewed_files` and `omitted_files` partition those changed files into materially inspected and skipped files.
Set `complete` to false whenever a changed file was skipped, inspection was cut short, or another limitation prevented a complete review.

Previously reported findings include a stable `fingerprint`.
Do not repeat them in `findings`.
Add `fixed` or `still_present` updates only for previous findings you can verify in the current code.
Do not publish to GitHub or use GitHub credentials.
