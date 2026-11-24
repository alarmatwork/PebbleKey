// PebbleKey sign-in service (Cloudflare Worker).
//
// Lets people use PebbleKey without their own Volvo developer account: one Volvo API
// application belongs to whoever runs this service, and every user signs in to it with their
// own Volvo ID. Volvo requires the application's client secret for each sign-in and each token
// refresh, and a secret cannot ship inside a public watchapp, so those two calls go through
// here. Car commands do not: the phone sends them straight to Volvo.
//
// Nothing is stored. Tokens pass through in memory and are handed to the phone.
//
//   GET  /          what this is, with a Continue button
//   GET  /start     redirects to the Volvo ID sign-in
//   GET  /callback  Volvo sends the user back here; shows a button that hands a setup code to
//                   the Pebble phone app
//   POST /refresh   swaps a refresh token for a new access token
//
// Flow reference: https://developer.volvocars.com/apis/docs/authorisation

const AUTH_URL = 'https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/auth';
const TOKEN_URL = 'https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/token';
const VEHICLES_URL = 'https://api.volvocars.com/connected-vehicle/v2/vehicles';

// Every scope here must be ticked on the Volvo application, or Volvo rejects the sign-in.
// Override with the VOLVO_SCOPES variable if your application has fewer.
const DEFAULT_SCOPES = [
  'openid',
  'conve:vehicle_relation',
  'conve:lock',
  'conve:unlock',
  'conve:climatization_start_stop',
  'conve:doors_status',
  'conve:lock_status',
  'conve:fuel_status',
  'conve:battery_charge_level',
  'location:read'
].join(' ');

// Second version of the setup code src/pkjs/volvo.js imports: no client secret inside.
const SETUP_PREFIX = 'EX30K2.';
// How long someone may take on Volvo's sign-in page.
const STATE_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_REFRESH_BODY = 8192;
const MAX_VEHICLES = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function basicAuth(env) {
  // Same encoding as tools/volvo_login.py, which is known to work against Volvo.
  return 'Basic ' + btoa(
    encodeURIComponent(env.VOLVO_CLIENT_ID) + ':' + encodeURIComponent(env.VOLVO_CLIENT_SECRET));
}

// The PKCE verifier has to survive the trip to Volvo and back. Rather than store it, it rides
// along in the `state` parameter, encrypted with a key derived from the client secret, so only
// this service can read it or make one.
async function stateKey(env) {
  const digest = await crypto.subtle.digest(
    'SHA-256', encoder.encode('pebblekey-state:' + env.VOLVO_CLIENT_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealState(env, verifier, now) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await stateKey(env),
    encoder.encode(JSON.stringify({ v: verifier, t: now })));
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return base64url(out);
}

/** @returns {Promise<string|null>} the PKCE verifier, or null if the state is forged or stale */
async function openState(env, state, now) {
  try {
    const bytes = fromBase64url(state);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) }, await stateKey(env), bytes.slice(12));
    const data = JSON.parse(decoder.decode(plain));
    return now - data.t <= STATE_MAX_AGE_MS && now >= data.t ? data.v : null;
  } catch (e) {
    return null;
  }
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 17px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px;
         background: #f4f5f7; color: #16181d; }
  main { max-width: 440px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { margin: 0 0 14px; }
  .button { display: block; margin: 0 0 12px; padding: 14px 16px; border-radius: 10px;
            background: #1c4fd8; color: #fff; text-align: center; text-decoration: none;
            font-weight: 600; border: 0; font-size: 17px; width: 100%; box-sizing: border-box; }
  .button small { display: block; font-weight: 400; opacity: .85; }
  .quiet { background: transparent; color: inherit; border: 1px solid #8a8f98; }
  .note { font-size: 15px; color: #555b66; }
  textarea { width: 100%; box-sizing: border-box; height: 96px; font: 13px/1.4 ui-monospace, monospace;
             border-radius: 8px; border: 1px solid #8a8f98; padding: 8px; margin: 0 0 12px;
             background: transparent; color: inherit; }
  hr { border: 0; border-top: 1px solid #c9ccd2; margin: 22px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #eceef2; }
    .note { color: #a4a9b3; }
    .button { background: #4f7df3; }
    .quiet { background: transparent; }
    hr { border-top-color: #3a3e46; }
  }
`;

function page(status, title, body, script) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // These pages can carry a login token: keep them out of caches, frames and referrers.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

function problem(status, text) {
  return page(status, 'Sign-in did not work',
    `<p>${escapeHtml(text)}</p><a class="button" href="/">Start again</a>`);
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // No cookies are involved, so any origin may call this; the refresh token is the proof.
      'access-control-allow-origin': '*'
    }
  });
}

function landing() {
  return page(200, 'PebbleKey', `
<p>Sign in with your Volvo ID to let PebbleKey on your watch lock, unlock and pre-heat your car.</p>
<p><strong>Tick "Remember me"</strong> on Volvo's sign-in page. Without it the watch is signed
out again within hours.</p>
<a class="button" href="/start">Continue to Volvo</a>
<p class="note">Your password goes only to Volvo. This service passes the finished sign-in to
your phone and stores nothing. Volvo ends every sign-in after 3 months; come back here then.</p>`);
}

async function start(request, env, now) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const target = new URL(AUTH_URL);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', env.VOLVO_CLIENT_ID);
  target.searchParams.set('redirect_uri', new URL('/callback', request.url).href);
  target.searchParams.set('scope', env.VOLVO_SCOPES || DEFAULT_SCOPES);
  target.searchParams.set('state', await sealState(env, verifier, now));
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  return new Response(null, {
    status: 302,
    headers: { location: target.href, 'cache-control': 'no-store' }
  });
}

async function readJson(response) {
  try {
    return (await response.json()) || {};
  } catch (e) {
    return {};
  }
}

/** One line a person recognises their car by, e.g. "EX30 2025, ABC 123, VIN ...123456". */
async function describeVehicle(fetcher, headers, vin) {
  const parts = [];
  try {
    const response = await fetcher(VEHICLES_URL + '/' + encodeURIComponent(vin), { headers });
    const data = response.ok ? (await readJson(response)).data || {} : {};
    const model = data.descriptions && data.descriptions.model;
    if (model || data.modelYear) {
      parts.push([model, data.modelYear].filter(Boolean).join(' '));
    }
    const plate = data.specifications && data.specifications.licensePlate;
    if (plate) {
      parts.push(plate);
    }
  } catch (e) {
    // The VIN alone still identifies the car.
  }
  parts.push('VIN …' + vin.slice(-6));
  return parts.join(', ');
}

async function callback(request, env, fetcher, now) {
  const params = new URL(request.url).searchParams;
  if (params.get('error')) {
    const detail = params.get('error_description') || params.get('error');
    return problem(400, params.get('error') === 'access_denied' ?
      'You declined access on Volvo’s page, so nothing was set up.' :
      'Volvo reported: ' + detail);
  }
  const code = params.get('code');
  const verifier = code && await openState(env, params.get('state') || '', now);
  if (!verifier) {
    return problem(400, 'This sign-in link is not valid any more. It may have taken too long.');
  }

  const tokenResponse = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(env)
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: new URL('/callback', request.url).href,
      code_verifier: verifier
    }).toString()
  });
  const tokens = await readJson(tokenResponse);
  if (!tokenResponse.ok || !tokens.refresh_token || !tokens.access_token) {
    return problem(502, 'Volvo did not complete the sign-in (' +
      (tokens.error || tokenResponse.status) + ').');
  }

  const headers = {
    accept: 'application/json',
    authorization: 'Bearer ' + tokens.access_token,
    'vcc-api-key': env.VOLVO_API_KEY
  };
  const listResponse = await fetcher(VEHICLES_URL, { headers });
  if (!listResponse.ok) {
    return problem(502, 'Signed in, but Volvo would not list your cars (error ' +
      listResponse.status + ').');
  }
  const vins = ((await readJson(listResponse)).data || [])
    .map((entry) => String(entry && entry.vin || '').toUpperCase())
    .filter((vin) => /^[A-Z0-9]{17}$/.test(vin))
    .slice(0, MAX_VEHICLES);
  if (!vins.length) {
    return problem(404, 'Signed in, but this Volvo ID has no connected car.');
  }

  const cars = await Promise.all(vins.map(async (vin) => ({
    label: await describeVehicle(fetcher, headers, vin),
    setupCode: SETUP_PREFIX + base64url(encoder.encode(JSON.stringify({
      k: env.VOLVO_API_KEY, v: vin, r: tokens.refresh_token
    })))
  })));

  // The setup code is base64url, so it can sit in the link unescaped. A tap on the link is what
  // lets a browser hand it to the Pebble app; browsers block doing that without a tap.
  const buttons = cars.map((car) =>
    `<a class="button" href="pebblejs://close#${car.setupCode}">` +
    (cars.length > 1 ? 'Use this car' : 'Finish in the Pebble app') +
    `<small>${escapeHtml(car.label)}</small></a>`).join('\n');
  const fallback = cars.map((car, index) => `
<p class="note">${escapeHtml(car.label)}</p>
<textarea readonly id="code${index}">${escapeHtml(car.setupCode)}</textarea>
<button class="button quiet" data-copy="code${index}">Copy code</button>`).join('\n');

  return page(200, 'Signed in', `
<p>Keep PebbleKey open on your watch, then tap:</p>
${buttons}
<p class="note">The watch buzzes and shows "Setup saved".</p>
<hr>
<p class="note">Nothing happened? Copy the code and paste it under "Setup code" in PebbleKey's
settings in the Pebble app. Treat it like a password; it stops working once the watch has used it.</p>
${fallback}`, `
document.addEventListener('click', function (event) {
  var id = event.target.getAttribute && event.target.getAttribute('data-copy');
  if (!id) { return; }
  var field = document.getElementById(id);
  field.focus();
  field.select();
  var done = function () { event.target.textContent = 'Copied'; };
  var oldWay = function () { if (document.execCommand('copy')) { done(); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(field.value).then(done, oldWay);
  } else {
    oldWay();
  }
});`);
}

async function refresh(request, env, fetcher) {
  const text = await request.text();
  if (text.length > MAX_REFRESH_BODY) {
    return json(413, { error: 'too_large' });
  }
  const refreshToken = new URLSearchParams(text).get('refresh_token');
  if (!refreshToken) {
    return json(400, { error: 'invalid_request' });
  }
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(env)
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
  });
  const tokens = await readJson(response);
  if (response.ok && tokens.access_token) {
    return json(200, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      // Sent every time, so replacing the key here reaches every phone on its next refresh.
      api_key: env.VOLVO_API_KEY
    });
  }
  if (tokens.error === 'invalid_grant') {
    // Expired, already used, or not issued to this application: the user has to sign in again.
    return json(400, { error: 'invalid_grant' });
  }
  // Anything else (a wrong client secret, Volvo being down) is this service's problem, and
  // must not look like an expired login to the phone.
  return json(502, { error: 'upstream', status: response.status });
}

/**
 * @param {Object} [deps]
 * @param {function} [deps.fetch] - used for the calls to Volvo
 * @param {function} [deps.now] - returns the current time in ms
 */
export function createBroker(deps = {}) {
  const fetcher = deps.fetch || ((...args) => fetch(...args));
  const now = deps.now || (() => Date.now());

  return async function handle(request, env) {
    const url = new URL(request.url);
    if (!env.VOLVO_CLIENT_ID || !env.VOLVO_CLIENT_SECRET || !env.VOLVO_API_KEY) {
      return url.pathname === '/refresh' ?
        json(500, { error: 'not_configured' }) :
        page(500, 'Not set up', '<p>This sign-in service has not been given its Volvo keys yet.</p>');
    }
    try {
      if (url.pathname === '/refresh') {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'POST',
              'access-control-allow-headers': 'content-type'
            }
          });
        }
        return request.method === 'POST' ?
          await refresh(request, env, fetcher) : json(405, { error: 'method_not_allowed' });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 });
      }
      if (url.pathname === '/') {
        return landing();
      }
      if (url.pathname === '/start') {
        return await start(request, env, now());
      }
      if (url.pathname === '/callback') {
        return await callback(request, env, fetcher, now());
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      // Deliberately no detail: an error message could quote a token.
      return url.pathname === '/refresh' ?
        json(502, { error: 'upstream' }) :
        problem(502, 'Volvo could not be reached. Try again in a moment.');
    }
  };
}

export default { fetch: createBroker() };
