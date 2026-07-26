export default async function onRequest(context) {
  const { env } = context;
  const password = env.PASSWORD || '';

  // Compute SHA-256 using Web Crypto API (no Node.js imports needed)
  let hash = '';
  if (password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return new Response(JSON.stringify({ hash }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
