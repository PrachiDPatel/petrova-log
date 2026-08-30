// Worker handler — POST /notify
// Sends an FCM push notification via the FCM HTTP v1 API.
//
// Replaces the old Netlify function, which used the `firebase-admin` SDK.
// firebase-admin depends on Node APIs (XMLHttpRequest, etc.) that aren't
// available in the Workers runtime, so this talks to Google's REST APIs
// directly: exchange a service-account JWT for an OAuth access token
// (signed with Web Crypto), then POST the message to FCM.

function base64url(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBinary(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

// Cloudflare Pages Function entry point (POST /notify)
export async function onRequestPost(context) {
  return handleNotify(context.request, context.env);
}

async function handleNotify(request, env) {
  let token, senderName;
  try {
    ({ token, senderName } = await request.json());
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (!token || !senderName) {
    return new Response('Missing token or senderName', { status: 400 });
  }

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT is not configured' }), { status: 500 });
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT is not valid JSON' }), { status: 500 });
  }

  const origin = new URL(request.url).origin;
  const title  = 'The Petrova Log';
  const body   = `${senderName} has logged an entry 🪶`;

  try {
    const accessToken = await getAccessToken(serviceAccount);

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            webpush: {
              notification: { title, body, icon: `${origin}/icon.svg` },
              fcm_options:  { link: origin }
            },
            apns: {
              payload: { aps: { alert: { title, body }, sound: 'default' } }
            }
          }
        })
      }
    );

    if (!res.ok) {
      return new Response(JSON.stringify({ error: await res.text() }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
