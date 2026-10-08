"""Register a decision with the configured local Leverframe; no third-party dependencies."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RecommendationError(ValueError):
    pass


class QuestionInputError(ValueError):
    pass


def validate_required_text(payload):
    for field, maximum in (('project', 100), ('title', 200), ('question', 4000), ('why', 4000)):
        value = payload.get(field)
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
            raise QuestionInputError(f'{field} must contain 1–{maximum} characters. project is a display label from the current task, not a project registration.')


def validate_recommendation(payload):
    options = payload.get('options', [])
    if not isinstance(options, list) or any(not isinstance(option, dict) or not isinstance(option.get('recommended'), bool) for option in options):
        raise RecommendationError('Each option needs a boolean recommended field.')
    count = sum(option['recommended'] for option in options)
    reason = payload.get('recommendation', '')
    unavailable = payload.get('recommendationUnavailableReason')
    if count == 1 and isinstance(reason, str) and reason.strip() and 'recommendationUnavailableReason' not in payload:
        return
    if count == 0 and isinstance(reason, str) and not reason.strip() and isinstance(unavailable, str) and unavailable.strip():
        return
    raise RecommendationError('Mark exactly one option recommended with a nonempty recommendation reason and omit recommendationUnavailableReason entirely (not null), or provide recommendationUnavailableReason with no recommended option and an empty recommendation.')


def default_config():
    adjacent = Path(__file__).resolve().parent.parent / 'connection.json'
    return os.environ.get('LEVERFRAME_AGENT_CONFIG') or str(adjacent if adjacent.exists() else Path.home() / '.agents' / 'skills' / 'leverframe-ask' / 'connection.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='''Input JSON fields:
project, title, goal, question, why, waitingFor, continuing, recommendation: strings;
mode: "blocking" or "nonblocking"; assumption: string or null;
constraints: string[]; facts: [{label, detail}];
options: [{id, label, effect, recommended: boolean}].
project (1–100), title (1–200), question and why (1–4000) must be nonempty.
project is a display label from the current task; no project registration is needed.
Recommend exactly one option and explain why in recommendation. Labels stay plain.
If evidence cannot support a recommendation, mark none, keep recommendation empty,
and provide recommendationUnavailableReason explaining the missing basis.
Advice is not approval: the user retaining final choice is not a reason to withhold advice.
Use empty arrays/strings for genuinely absent optional context, not invented facts.
Nonblocking requires an already authorized assumption and independent continuing work.
The script supplies key and threadId. It cannot submit answers on the user's behalf.''')
    parser.add_argument('--config', default=default_config(), help='Local connection JSON file; never print its contents')
    parser.add_argument('--key', required=True, help='Stable identity for this question, reused on retries')
    parser.add_argument('--file', required=True, help='Question JSON file')
    args = parser.parse_args()
    thread = os.environ.get('LEVERFRAME_SESSION_ID') or os.environ.get('CODEX_THREAD_ID')
    if not thread or not args.config:
        parser.error('A session ID (LEVERFRAME_SESSION_ID or CODEX_THREAD_ID) and a connection configuration are required')
    try:
        config = json.loads(Path(args.config).read_text())
        base = config['url'].rstrip('/')
        parsed = urlparse(base)
        if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
            raise ValueError('invalid connection URL')
        if parsed.scheme == 'http' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('plain HTTP is restricted to loopback')
        raw = Path(args.file).read_bytes()
        if len(raw) > 48000:
            raise ValueError('question exceeds 48 KB')
        payload = json.loads(raw)
        if not isinstance(payload, dict) or any(field in payload for field in ('threadId', 'source', 'key')):
            raise ValueError('the script supplies key and session source')
        validate_recommendation(payload)
        validate_required_text(payload)
        payload.update(key=args.key)
        if config.get('connectionId'):
            payload['source'] = {'connectionId': config['connectionId'], 'sessionId': thread}
        else:
            payload['threadId'] = thread
        request = Request(base + '/api/v1/decisions', data=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token'],
        }, method='POST')
        opener = build_opener(NoRedirect(), ProxyHandler({}))
        with opener.open(request, timeout=25) as response:
            item = json.load(response)
        print(json.dumps({'id': item['id'], 'status': item['status'], 'url': config['uiUrl'].rstrip('/') + '?request=' + item['id']}, ensure_ascii=False))
        return 0
    except RecommendationError as error:
        print(json.dumps({'error': 'recommendation_required', 'next': str(error)}), file=sys.stderr)
        return 1
    except QuestionInputError as error:
        print(json.dumps({'error': 'invalid_question', 'next': str(error)}), file=sys.stderr)
        return 1
    except HTTPError as error:
        # Do not echo server payloads or credentials. A 409 requires inspecting the original request.
        print(json.dumps({'error': 'registration_rejected', 'httpStatus': error.code}), file=sys.stderr)
        return 1
    except (TimeoutError, URLError, OSError):
        print(json.dumps({'error': 'registration_unconfirmed', 'next': 'Retry the same file and key; do not create a new identity.'}), file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError):
        print(json.dumps({'error': 'invalid_input_or_configuration'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
