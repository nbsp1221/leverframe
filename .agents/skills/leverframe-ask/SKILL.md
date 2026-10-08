---
name: leverframe-ask
description: Ask the user for a decision through the connected Leverframe request inbox during Codex work. Use when a user decision is needed and this computer is connected to Leverframe.
---

# Ask through Leverframe

Use the bundled script; do not construct HTTP requests or read credentials into the conversation. The installed skill automatically uses its local connector configuration. It gets the original session from `CODEX_THREAD_ID` (or `LEVERFRAME_SESSION_ID` for isolated tests or explicit integrations); the connector verifies that session and routes the response. No project or conversation registration is required. Never invent or replace session identifiers. If no connector is configured or the source cannot be verified, report the failure rather than claiming the question was saved. Explicit user instructions take precedence over this workflow.

An explicit `--config` or `LEVERFRAME_AGENT_CONFIG` remains available for isolated tests and older direct connections. Normal use needs neither.

1. Run `python3 <skill-directory>/scripts/ask.py --help` for the command and input format. `project`, `title`, `question` and `why` must be nonempty. `project` is only a display label: derive it from the current task or working context, without asking the user to register a project. For a connection check, use a label such as `Connection check`.
2. Write a JSON file with the question, decision context, options and their effects. After investigating the user's goal and constraints, recommend the best supported option: set exactly one option's `recommended` to `true` and put the evidence-based reason in `recommendation`. Keep option labels plain; the UI adds the recommendation badge. Do not turn a request for your judgment into an unexplained neutral menu. If a recommendation genuinely depends on missing facts or solely on personal preference, set all options to `false`, keep `recommendation` empty, and provide `recommendationUnavailableReason` explaining what is missing; do not invent a preference to satisfy validation. Use a stable `--key` for this particular question. Retry an uncertain registration with the same key and unchanged file; a changed question needs a new key.
3. Run `python3 <skill-directory>/scripts/ask.py --key <question-key> --file <question.json>`.
4. A successful response contains the saved request ID and URL. Share the URL briefly. For a blocking question, stop dependent work and finish this turn; the pending request outlives the turn. Continue independent work only within existing authorization. Silence is never approval.

Recommendation is advice, not selection or authorization. "The user will decide" is not a reason to withhold your recommendation. When the evidence supports a practical starting point, recommend it for the current goal and state the condition that would change your advice. Do not require certainty about all future product directions. Use `recommendationUnavailableReason` only when you cannot responsibly recommend even conditionally: name the specific missing fact or genuinely subjective preference. Do not use that field merely to remain neutral between the supplied options.

Answers arrive as a new message in this same conversation, identified by request and answer IDs. Interpret the user's full answer, including conditions or a request for more investigation; receiving an answer does not prove implementation. Do not post a duplicate question just because the turn ended. If registration fails, keep dependent work stopped and report the error. This skill does not enforce interruption or grant permission to change policy.
