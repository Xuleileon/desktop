import http from 'node:http';

const port = Number(process.argv[2] ?? 18777);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Usage: node scripts/auth-sync-probe-server.mjs [port]');
}

const observations = new Map();

function pageScript(mode, key, value) {
  const encodedMode = JSON.stringify(mode);
  const encodedKey = JSON.stringify(key);
  const encodedValue = JSON.stringify(value);
  return `<!doctype html><meta charset="utf-8"><title>Browser Use Auth Sync Probe</title>
<body><pre id="result">working</pre><script>
(async () => {
  const mode = ${encodedMode};
  const key = ${encodedKey};
  const value = ${encodedValue};
  if (mode === 'source') {
    document.cookie = encodeURIComponent(key) + '=' + encodeURIComponent(value) + '; Path=/; SameSite=Lax';
    localStorage.setItem(key, value);
    sessionStorage.setItem(key, value);
  } else if (mode === 'cleanup') {
    document.cookie = encodeURIComponent(key) + '=; Path=/; Max-Age=0; SameSite=Lax';
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
  const payload = {
    mode,
    key,
    cookie: document.cookie.split('; ').find((item) => item.startsWith(encodeURIComponent(key) + '='))?.split('=').slice(1).join('=') ?? null,
    localStorage: localStorage.getItem(key),
    sessionStorage: sessionStorage.getItem(key),
  };
  await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  document.querySelector('#result').textContent = JSON.stringify(payload, null, 2);
})().catch((error) => { document.querySelector('#result').textContent = String(error); });
</script></body>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (request.method === 'POST' && url.pathname === '/report') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const report = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof report.key === 'string') observations.set(`${report.mode}:${report.key}`, report);
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/status') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(Object.fromEntries(observations)));
    return;
  }
  if (['/source', '/probe', '/cleanup'].includes(url.pathname)) {
    const key = url.searchParams.get('key') ?? '';
    const value = url.searchParams.get('value') ?? '';
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(pageScript(url.pathname.slice(1), key, value));
    return;
  }
  response.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Auth sync probe listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
