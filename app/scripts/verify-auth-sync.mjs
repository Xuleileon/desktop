import WebSocket from 'ws';

const port = Number(process.argv[2]);
const targetId = process.argv[3];
const testUrl = process.argv[4];
const sentinelKey = process.argv[5];
const expectedValue = process.argv[6];
if (!Number.isInteger(port) || port < 1 || port > 65535 || !targetId || !testUrl || !sentinelKey || !expectedValue) {
  throw new Error('Usage: node scripts/verify-auth-sync.mjs <cdp-port> <target-id> <url> <key> <expected-value>');
}

const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
if (!versionResponse.ok) throw new Error(`CDP discovery failed: HTTP ${versionResponse.status}`);
const version = await versionResponse.json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (!message.id) return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result ?? {});
});

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify(payload));
  });
}

const targets = await send('Target.getTargets');
const target = targets.targetInfos?.find((item) => item.type === 'page' && item.targetId === targetId);
if (!target) throw new Error(`Desktop target ${targetId} was not found`);
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
await send('Runtime.enable', {}, attached.sessionId);
await send('Page.enable', {}, attached.sessionId);
await send('Page.navigate', { url: testUrl }, attached.sessionId);

let readback;
let cookieResult = { cookies: [] };
const expectedOrigin = new URL(testUrl).origin;
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const evaluated = await send('Runtime.evaluate', {
    expression: `({
      origin: location.origin,
      ready: document.readyState,
      cookie: document.cookie.split('; ').find((item) => item.startsWith(encodeURIComponent(${JSON.stringify(sentinelKey)}) + '='))?.split('=').slice(1).join('=') ?? null,
      localStorage: localStorage.getItem(${JSON.stringify(sentinelKey)}),
      sessionStorage: sessionStorage.getItem(${JSON.stringify(sentinelKey)}),
    })`,
    returnByValue: true,
  }, attached.sessionId);
  readback = evaluated.result?.value;
  if (readback?.origin === expectedOrigin && readback?.ready === 'complete') {
    cookieResult = await send('Network.getCookies', { urls: [testUrl] }, attached.sessionId);
    const candidate = cookieResult.cookies?.find((item) => item.name === sentinelKey);
    const pageCookie = readback?.cookie ? decodeURIComponent(readback.cookie) : null;
    if (candidate?.value === expectedValue
      && pageCookie === expectedValue
      && readback?.localStorage === expectedValue
      && readback?.sessionStorage === expectedValue) {
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

cookieResult = await send('Network.getCookies', { urls: [testUrl] }, attached.sessionId);
const cookie = cookieResult.cookies?.find((item) => item.name === sentinelKey);
let allCookieResult = { cookies: [] };
try {
  allCookieResult = await send('Network.getAllCookies', {}, attached.sessionId);
} catch {
  // Kept only as a diagnostic for Chromium builds where the deprecated method
  // still exists; URL-scoped Network.getCookies remains the acceptance gate.
}
const allCookie = allCookieResult.cookies?.find((item) => item.name === sentinelKey);
let storageCookieResult = { cookies: [] };
let storageCookieError = null;
try {
  storageCookieResult = await send(
    'Storage.getCookies',
    target.browserContextId ? { browserContextId: target.browserContextId } : {},
  );
} catch (error) {
  storageCookieError = error instanceof Error ? error.message : String(error);
  // Diagnostic only; target-scoped Network readback remains the acceptance gate.
}
const storageCookie = storageCookieResult.cookies?.find((item) => item.name === sentinelKey);
const result = {
  targetId,
  loadedOrigin: readback?.origin ?? '',
  networkCookie: cookie?.value ?? null,
  allCookiesCookie: allCookie?.value ?? null,
  allCookiesCount: allCookieResult.cookies?.length ?? 0,
  storageCookie: storageCookie?.value ?? null,
  storageCookiesCount: storageCookieResult.cookies?.length ?? 0,
  storageCookieError,
  documentCookie: readback?.cookie ? decodeURIComponent(readback.cookie) : null,
  localStorage: readback?.localStorage ?? null,
  sessionStorage: readback?.sessionStorage ?? null,
};
const passed = result.loadedOrigin === expectedOrigin
  && result.networkCookie === expectedValue
  && result.documentCookie === expectedValue
  && result.localStorage === expectedValue
  && result.sessionStorage === expectedValue;

socket.close();
console.log(JSON.stringify({ passed, ...result }, null, 2));
if (!passed) process.exitCode = 1;
