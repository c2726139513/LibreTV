// /cloud-functions/api/env/password.js
// EdgeOne Cloud Function: Return password hash for frontend auth
// No filesystem dependency — uses only context.env + crypto

import crypto from 'crypto';

export default async function onRequest(context) {
  const { env } = context;
  const password = env.PASSWORD || '';

  // Compute SHA-256 hash
  const hash = password
    ? crypto.createHash('sha256').update(password).digest('hex')
    : '';

  return new Response(JSON.stringify({ hash }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
