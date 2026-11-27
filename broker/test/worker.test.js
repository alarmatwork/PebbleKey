// Run with: node --test   (from the project root)
// Exercises broker/src/worker.js against a fake Volvo (no network).

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createBroker } from '../src/worker.js';

// The phone-side code that has to understand what the broker hands over.
const createVolvo = createRequire(import.meta.url)('../../src/pkjs/volvo.js');

const ORIGIN = 'https://pebblekey.example.workers.dev';
const ENV = {
  VOLVO_CLIENT_ID: 'client-id',
  VOLVO_CLIENT_SECRET: 's3cr+t/=',
  VOLVO_API_KEY: 'api-key-1'
};
const BASIC = 'Basic ' + Buffer.from('client-id:' + encodeURIComponent('s3cr+t/=')).toString('base64');
const VIN_A = 'YV1ABCDEFGH123456';
const VIN_B = 'YV1ABCDEFGH654321';

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Fake Volvo: records every request and answers the token and vehicle endpoints.
function fakeVolvo(opts = {}) {
  const calls = [];
  async function fetcher(url, init = {}) {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (opts.down) {
      throw new Error('network down, refresh_token=should-never-leak');
    }
    if (call.url.endsWith('/token')) {
      call.form = new URLSearchParams(call.body);
      if (opts.token) {
        return opts.token(call);
      }
      return reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 300 });
    }
    if (call.url.endsWith('/vehicles')) {
      return opts.vehiclesStatus ?
        reply(opts.vehiclesStatus, {}) :
        reply(200, { data: (opts.vins || [VIN_A]).map((vin) => ({ vin })) });
    }
    const vin = call.url.split('/').pop();
    return vin === VIN_B ?
      reply(500, {}) :
      reply(200, { data: { vin, modelYear: 2025, descriptions: { model: 'EX30 <b>' },
        specifications: { licensePlate: 'ABC 123' } } });
  }
  // Shaped like createBroker's deps, so a test can pass it straight in.
  return { calls, fetch: fetcher };
}

function get(broker, path) {
  return broker(new Request(ORIGIN + path), ENV);
}

// Goes through /start and returns what Volvo's sign-in page would have been given.
async function startSignIn(broker) {
  const response = await get(broker, '/start');
  assert.strictEqual(response.status, 302);
  return new URL(response.headers.get('location'));
}

function setupCodes(html) {
  return [...html.matchAll(/href="pebblejs:\/\/close#(EX30K2\.[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
}

function decodeSetupCode(code) {
  return JSON.parse(Buffer.from(code.slice('EX30K2.'.length), 'base64url').toString());
}

test('landing page explains itself and links to /start', async () => {
  const response = await get(createBroker(fakeVolvo()), '/');
  const html = await response.text();
  assert.strictEqual(response.status, 200);
  assert.match(html, /href="\/start"/);
  assert.match(html, /Remember me/);
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
});

test('/start sends the user to Volvo with PKCE and this service as the redirect', async () => {
  const target = await startSignIn(createBroker(fakeVolvo()));
  assert.strictEqual(target.origin + target.pathname,
    'https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/auth');
  assert.strictEqual(target.searchParams.get('response_type'), 'code');
  assert.strictEqual(target.searchParams.get('client_id'), 'client-id');
  assert.strictEqual(target.searchParams.get('redirect_uri'), ORIGIN + '/callback');
  assert.strictEqual(target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(target.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const scopes = target.searchParams.get('scope').split(' ');
  for (const scope of ['openid', 'conve:vehicle_relation', 'conve:lock', 'conve:unlock', 'energy:state:read', 'location:read']) {
    assert.ok(scopes.includes(scope), scope);
  }
  // The verifier travels inside the state, and must not be readable there.
  assert.ok(!target.href.includes('s3cr'));
});

test('VOLVO_SCOPES overrides the default scope list', async () => {
  const broker = createBroker(fakeVolvo());
  const response = await broker(new Request(ORIGIN + '/start'), { ...ENV, VOLVO_SCOPES: 'openid conve:lock' });
  assert.strictEqual(new URL(response.headers.get('location')).searchParams.get('scope'), 'openid conve:lock');
});

test('/callback exchanges the code and hands a setup code to the Pebble app', async () => {
  const volvo = fakeVolvo();
  const broker = createBroker(volvo);
  const target = await startSignIn(broker);
  const response = await get(broker,
    '/callback?code=the-code&state=' + encodeURIComponent(target.searchParams.get('state')));
  const html = await response.text();
  assert.strictEqual(response.status, 200);

  const exchange = volvo.calls[0];
  assert.strictEqual(exchange.headers.authorization, BASIC);
  assert.strictEqual(exchange.form.get('grant_type'), 'authorization_code');
  assert.strictEqual(exchange.form.get('code'), 'the-code');
  assert.strictEqual(exchange.form.get('redirect_uri'), ORIGIN + '/callback');
  // The verifier sent to Volvo must be the one the challenge was made from.
  const challenge = crypto.createHash('sha256').update(exchange.form.get('code_verifier')).digest('base64url');
  assert.strictEqual(challenge, target.searchParams.get('code_challenge'));

  const list = volvo.calls[1];
  assert.strictEqual(list.headers.authorization, 'Bearer access-1');
  assert.strictEqual(list.headers['vcc-api-key'], 'api-key-1');

  const codes = setupCodes(html);
  assert.strictEqual(codes.length, 1);
  assert.deepStrictEqual(decodeSetupCode(codes[0]), { k: 'api-key-1', v: VIN_A, r: 'refresh-1' });
  assert.match(html, /Finish in the Pebble app/);
  assert.match(html, /EX30 &lt;b&gt; 2025, ABC 123, VIN …123456/);
  // Neither the client secret nor the short-lived access token belongs on the page.
  assert.ok(!html.includes('s3cr') && !html.includes('access-1'));
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
  assert.strictEqual(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
});

test('the phone-side code accepts the broker setup code and refreshes through the broker', async () => {
  const volvo = fakeVolvo();
  const broker = createBroker(volvo);
  const target = await startSignIn(broker);
  const page = await get(broker, '/callback?code=c&state=' + encodeURIComponent(target.searchParams.get('state')));
  const code = setupCodes(await page.text())[0];

  // An XMLHttpRequest that talks to the broker in-process, as the phone would over the network.
  function BrokerXhr() {
    const req = { headers: {} };
    this.open = (method, url) => { req.method = method; req.url = url; };
    this.setRequestHeader = (k, v) => { req.headers[k] = v; };
    this.send = async (body) => {
      const response = await broker(new Request(req.url, { method: req.method, headers: req.headers, body }), ENV);
      this.status = response.status;
      this.responseText = await response.text();
      this.onload();
    };
  }
  const data = {};
  const phone = createVolvo({
    XMLHttpRequest: BrokerXhr,
    storage: { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } },
    brokerUrl: ORIGIN + '/'
  });
  assert.strictEqual(phone.importSetupCode(code), null);
  volvo.calls.length = 0;
  const token = await new Promise((resolve, reject) =>
    phone.getAccessToken((err, value) => (err ? reject(new Error(err)) : resolve(value))));
  assert.strictEqual(token, 'access-1');
  assert.strictEqual(volvo.calls[0].form.get('grant_type'), 'refresh_token');
  assert.strictEqual(volvo.calls[0].form.get('refresh_token'), 'refresh-1');
  assert.strictEqual(volvo.calls[0].headers.authorization, BASIC);
});

test('several cars give one button each; a car without details still shows its VIN', async () => {
  const broker = createBroker(fakeVolvo({ vins: [VIN_A, VIN_B] }));
  const target = await startSignIn(broker);
  const html = await (await get(broker,
    '/callback?code=c&state=' + encodeURIComponent(target.searchParams.get('state')))).text();
  const codes = setupCodes(html);
  assert.deepStrictEqual(codes.map((code) => decodeSetupCode(code).v), [VIN_A, VIN_B]);
  assert.strictEqual((html.match(/Use this car/g) || []).length, 2);
  assert.match(html, /<small>VIN …654321<\/small>/);
});

test('a forged or stale state is refused before anything is sent to Volvo', async () => {
  let time = 1000000;
  const volvo = fakeVolvo();
  const broker = createBroker({ fetch: volvo.fetch, now: () => time });
  const state = (await startSignIn(broker)).searchParams.get('state');

  const forged = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
  assert.strictEqual((await get(broker, '/callback?code=c&state=' + forged)).status, 400);
  assert.strictEqual((await get(broker, '/callback?code=c&state=nonsense')).status, 400);
  assert.strictEqual((await get(broker, '/callback?code=c')).status, 400);

  time += 16 * 60 * 1000;
  assert.strictEqual((await get(broker, '/callback?code=c&state=' + encodeURIComponent(state))).status, 400);
  assert.strictEqual(volvo.calls.length, 0);

  // A state made with a different client secret is not accepted either.
  const other = createBroker({ fetch: volvo.fetch, now: () => time });
  const foreign = await other(new Request(ORIGIN + '/start'), { ...ENV, VOLVO_CLIENT_SECRET: 'other' });
  const foreignState = new URL(foreign.headers.get('location')).searchParams.get('state');
  assert.strictEqual((await get(broker, '/callback?code=c&state=' + encodeURIComponent(foreignState))).status, 400);
});

test('errors from Volvo are shown without being run as HTML', async () => {
  const broker = createBroker(fakeVolvo());
  const response = await get(broker,
    '/callback?error=invalid_scope&error_description=' + encodeURIComponent('<script>alert(1)</script>'));
  const html = await response.text();
  assert.strictEqual(response.status, 400);
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;script&gt;alert/);

  const denied = await (await get(broker, '/callback?error=access_denied')).text();
  assert.match(denied, /declined/);
});

test('a failed exchange, an unlistable account and an account without cars give clear pages', async () => {
  for (const [opts, status, text] of [
    [{ token: () => reply(400, { error: 'invalid_grant' }) }, 502, /invalid_grant/],
    [{ vehiclesStatus: 403 }, 502, /would not list your cars \(error 403\)/],
    [{ vins: [] }, 404, /no connected car/],
    [{ vins: ['not-a-vin'] }, 404, /no connected car/]
  ]) {
    const broker = createBroker(fakeVolvo(opts));
    const target = await startSignIn(broker);
    const response = await get(broker, '/callback?code=c&state=' + encodeURIComponent(target.searchParams.get('state')));
    assert.strictEqual(response.status, status);
    assert.match(await response.text(), text);
  }
});

function postRefresh(broker, body, env = ENV) {
  return broker(new Request(ORIGIN + '/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  }), env);
}

test('/refresh adds the client secret and returns the new tokens with the API key', async () => {
  const volvo = fakeVolvo({
    token: () => reply(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300, id_token: 'x' })
  });
  const response = await postRefresh(createBroker(volvo), 'refresh_token=' + encodeURIComponent('old+token/='));
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(),
    { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300, api_key: 'api-key-1' });
  assert.strictEqual(volvo.calls[0].headers.authorization, BASIC);
  assert.strictEqual(volvo.calls[0].form.get('grant_type'), 'refresh_token');
  assert.strictEqual(volvo.calls[0].form.get('refresh_token'), 'old+token/=');
});

test('/refresh tells an expired login apart from a broken service', async () => {
  const expired = await postRefresh(
    createBroker(fakeVolvo({ token: () => reply(400, { error: 'invalid_grant' }) })), 'refresh_token=x');
  assert.strictEqual(expired.status, 400);
  assert.deepStrictEqual(await expired.json(), { error: 'invalid_grant' });

  const badSecret = await postRefresh(
    createBroker(fakeVolvo({ token: () => reply(401, { error: 'invalid_client' }) })), 'refresh_token=x');
  assert.strictEqual(badSecret.status, 502);

  const down = await postRefresh(createBroker(fakeVolvo({ down: true })), 'refresh_token=x');
  assert.strictEqual(down.status, 502);
  assert.ok(!(await down.text()).includes('should-never-leak'));
});

test('/refresh rejects requests it cannot use', async () => {
  const volvo = fakeVolvo();
  const broker = createBroker(volvo);
  assert.strictEqual((await postRefresh(broker, '')).status, 400);
  assert.strictEqual((await postRefresh(broker, 'refresh_token=' + 'x'.repeat(9000))).status, 413);
  assert.strictEqual((await get(broker, '/refresh')).status, 405);
  assert.strictEqual(volvo.calls.length, 0);

  const preflight = await broker(new Request(ORIGIN + '/refresh', { method: 'OPTIONS' }), ENV);
  assert.strictEqual(preflight.status, 204);
});

test('other paths and an unconfigured service', async () => {
  const broker = createBroker(fakeVolvo());
  assert.strictEqual((await get(broker, '/nope')).status, 404);
  assert.strictEqual((await broker(new Request(ORIGIN + '/start', { method: 'POST' }), ENV)).status, 405);

  const empty = await broker(new Request(ORIGIN + '/'), {});
  assert.strictEqual(empty.status, 500);
  assert.strictEqual((await postRefresh(broker, 'refresh_token=x', {})).status, 500);
});
