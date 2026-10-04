---
name: leverframe-ask
description: Ask the user for a decision through the connected Leverframe request inbox during Codex work. Use when this workflow is enabled for the current conversation and a user decision is needed.
---

# Ask through Leverframe

Use the bundled script; do not construct HTTP requests or read credentials into the conversation. It requires Python 3, a session identifier (`LEVERFRAME_SESSION_ID`, or `CODEX_THREAD_ID` in Codex), and a supplied connection file path (`--config` or `LEVERFRAME_AGENT_CONFIG`). The connection file binds this environment to a configured Leverframe `connectionId`; the script supplies the session source. Do not invent or replace session identifiers. Existing files without `connectionId` retain the legacy Codex input format. If no connection is configured, report that limitation instead of claiming a question was saved.

1. Run `python <skill-directory>/scripts/ask.py --help` for the command and input format.
2. Write a JSON file with the question, decision context, options and their effects. After investigating the user's goal and constraints, recommend the best supported option: set exactly one option's `recommended` to `true` and put the evidence-based reason in `recommendation`. Keep option labels plain; the UI adds the recommendation badge. Do not turn a request for your judgment into an unexplained neutral menu. If a recommendation genuinely depends on missing facts or solely on personal preference, set all options to `false`, keep `recommendation` empty, and provide `recommendationUnavailableReason` explaining what is missing; do not invent a preference to satisfy validation. Use a stable `--key` for this particular question. Retry an uncertain registration with the same key and unchanged file; a changed question needs a new key.
3. Run `python <skill-directory>/scripts/ask.py --config <connection-file> --key <question-key> --file <question.json>`.
4. A successful response contains the saved request ID and URL. Share the URL briefly. For a blocking question, stop dependent work and finish this turn; the pending request outlives the turn. Continue independent work only within existing authorization. Silence is never approval.

Recommendation is advice, not selection or authorization. "The user will decide" is not a reason to withhold your recommendation. When the evidence supports a practical starting point, recommend it for the current goal and state the condition that would change your advice. Do not require certainty about all future product directions. Use `recommendationUnavailableReason` only when you cannot responsibly recommend even conditionally: name the specific missing fact or genuinely subjective preference. Do not use that field merely to remain neutral between the supplied options.

Answers arrive as a new message in this same conversation, identified by request and answer IDs. Interpret the user's full answer, including conditions or a request for more investigation; receiving an answer does not prove implementation. Do not post a duplicate question just because the turn ended. If registration fails, keep dependent work stopped and report the error. This skill does not enforce interruption or grant permission to change policy.
