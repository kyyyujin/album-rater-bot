// The browser never calls this function. Render authenticates the user and
// looks up the saved thread before forwarding the image and bot credential.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// SHA-256 of a separate 256-bit relay credential stored only in Render.
const RELAY_KEY_HASH = '7ad5f700b1f876eaf31c8e04ec27f04126797e88ce4aa245c0d4ebbb3d50a7c7';
const RATE_HEADERS = [
  'date', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'x-ratelimit-reset-after', 'x-ratelimit-bucket',
  'x-ratelimit-global', 'x-ratelimit-scope'
];

function equalSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function responseFromDiscord(response: Response, body: string): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'x-discord-relay-result': 'discord' });
  for (const name of RATE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: response.status, headers });
}

function relayError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'x-discord-relay-error': 'true' } });
}

Deno.serve(async (request: Request) => {
  const provided = request.headers.get('x-discord-relay-key') || '';
  if (!/^[a-f0-9]{64}$/.test(provided)) return relayError(403, 'Forbidden');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided));
  const actualHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (!equalSecret(actualHash, RELAY_KEY_HASH)) return relayError(403, 'Forbidden');

  const botToken = request.headers.get('x-discord-bot-token');
  if (!botToken) return relayError(400, 'Missing bot credential');

  try {
    if (request.method === 'GET') {
      // Read-only connectivity check. Never return the bot profile.
      const result = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(10000)
      });
      return Response.json({ discord_status: result.status });
    }
    if (request.method !== 'POST') return relayError(405, 'Method not allowed');

    const threadId = request.headers.get('x-discord-thread-id') || '';
    if (!/^\d{17,20}$/.test(threadId) || request.headers.get('content-type') !== 'image/png') {
      return relayError(400, 'Invalid request');
    }
    const declaredSize = Number(request.headers.get('content-length'));
    if (declaredSize > MAX_IMAGE_BYTES) return relayError(413, 'Image too large');
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
      return relayError(413, 'Invalid image size');
    }
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ attachments: [{ id: '0', filename: 'rating.png' }] }));
    form.append('files[0]', new Blob([bytes], { type: 'image/png' }), 'rating.png');
    const result = await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}` },
      body: form,
      signal: AbortSignal.timeout(20000)
    });
    return responseFromDiscord(result, await result.text());
  } catch (error) {
    console.error('[discord-post-relay]', error instanceof Error ? error.name : 'unknown_error');
    return relayError(502, 'Discord relay unavailable');
  }
});
