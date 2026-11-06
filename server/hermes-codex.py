"""Bounded inference through this device's existing Hermes Codex connection.

No shell/tools, credential export, token refresh, or auth-store writes. Only the
selected conversation is sent; credentials remain in this short-lived process.
"""
import contextlib
import io
import json
import sys
from urllib.parse import urlparse


def run(request):
    sys.path.insert(0, request['hermesRoot'])
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        import hermes_bootstrap  # noqa: F401
        from hermes_cli.auth_codex import resolve_codex_runtime_credentials
        from hermes_cli.config import load_config_readonly
        from agent.codex_headers import codex_cloudflare_headers
        credentials = resolve_codex_runtime_credentials(read_only=True)
        configured = load_config_readonly().get('model', {})
    token = credentials.get('api_key')
    base = str(credentials.get('base_url', '')).rstrip('/')
    # Never forward this login to a configurable gateway or a redirect.
    url = urlparse(base)
    if (url.scheme != 'https' or url.hostname != 'chatgpt.com' or
            url.port not in (None, 443) or url.path != '/backend-api/codex' or
            url.username or url.password or url.query or url.fragment):
        return {'ok': False, 'error': '仅支持 Hermes 已绑定的官方 Codex 连接；不会将登录凭据转发给其他主机'}
    if not token:
        return {'ok': False, 'error': 'Hermes 尚未登录 Codex，请先在 Hermes 完成登录'}
    if request.get('action') == 'status':
        return {'ok': True, 'available': True, 'model': configured.get('default', ''),
                'provider': 'hermes-codex', 'base': base, 'message': '已检测到本机 Hermes 登录；请测试所选模型的实际可用性'}
    payload = request['payload']
    instructions, messages = [], []
    for message in payload.get('messages', []):
        role, content = message.get('role'), message.get('content')
        if role in ('system', 'developer'):
            if isinstance(content, str):
                instructions.append(content)
            continue
        if role not in ('user', 'assistant'):
            raise ValueError('unsupported role')
        if isinstance(content, str):
            messages.append({'role': role, 'content': content})
        else:
            parts = []
            for part in content:
                if part.get('type') == 'text':
                    parts.append({'type': 'input_text', 'text': part['text']})
                elif part.get('type') == 'image_url':
                    image_url = part['image_url']['url']
                    if not image_url.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
                        raise ValueError('only inline images supported')
                    parts.append({'type': 'input_image', 'image_url': image_url})
                else:
                    raise ValueError('unsupported content')
            messages.append({'role': role, 'content': parts})
    body = {'model': payload['model'], 'instructions': '\n'.join(instructions),
            'input': messages, 'store': False, 'stream': True}
    if payload.get('reasoning_effort'):
        body['reasoning'] = {'effort': payload['reasoning_effort']}
    import httpx
    headers = codex_cloudflare_headers(token, base_url=base)
    headers.update({'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                    'Accept': 'text/event-stream', 'originator': 'laike-ai', 'User-Agent': 'LaikeAI/0.2.0 HermesConnection'})
    with httpx.Client(timeout=httpx.Timeout(90, connect=15), follow_redirects=False) as client:
        with client.stream('POST', base + '/responses', headers=headers, json=body) as response:
            if response.status_code != 200:
                reasons = {401: 'Hermes 登录已过期，请在 Hermes 重新登录后再试',
                           403: '当前账号没有该模型的使用权限', 429: '当前账号额度或请求频率受限，请稍后重试'}
                return {'ok': False, 'error': reasons.get(response.status_code, 'Codex 接口返回 HTTP ' + str(response.status_code))}
            size = 0
            for line in response.iter_lines():
                size += len(line)
                if size > 10_000_000:
                    raise ValueError('response too large')
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if not data or data == '[DONE]':
                    continue
                event = json.loads(data)
                if event.get('type') in ('response.failed', 'response.incomplete', 'error'):
                    return {'ok': False, 'error': 'Codex 未完成本次生成，请重试或检查模型权限与额度'}
                if event.get('type') == 'response.completed':
                    result = event.get('response', {})
                    if result.get('status') != 'completed':
                        break
                    text = ''.join(part.get('text', '') for item in result.get('output', [])
                                   if item.get('type') == 'message' for part in item.get('content', [])
                                   if part.get('type') == 'output_text')
                    if not text.strip():
                        break
                    usage = result.get('usage', {})
                    return {'ok': True, 'choices': [{'message': {'content': text}}],
                            'usage': {'total_tokens': usage.get('total_tokens', 0)}}
    return {'ok': False, 'error': 'Codex 连接中断或没有完整文本；未将部分输出当成成功'}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(9_000_001)
        if len(raw) > 9_000_000:
            raise ValueError('request too large')
        result = run(json.loads(raw))
    except Exception:
        # Third-party exception messages can contain credentials or request bodies.
        result = {'ok': False, 'error': 'Hermes Codex 连接不可用或已超时，请确认 Hermes 登录状态与网络'}
    print(json.dumps(result, ensure_ascii=False))
