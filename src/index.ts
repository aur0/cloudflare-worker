export interface Env {
  SUPPORT_ROOM: DurableObjectNamespace;
  AIWP_SIGNING_SECRET: string;
}

type SupportRole = 'customer' | 'agent';

interface SignedSession {
  siteId: string;
  roomId: string;
  threadId: number;
  role: SupportRole;
  userId?: number;
  exp: number;
}

type ClientEvent =
  | { type: 'thread_updated'; threadId?: number }
  | { type: 'threads_updated'; threadId?: number }
  | { type: 'typing_updated'; threadId?: number; typing?: boolean }
  | { type: 'presence_updated'; threadId?: number };

type ServerEvent =
  | { type: 'subscribed'; roomId: string; threadId: number; role: SupportRole }
  | { type: 'thread_updated'; threadId: number }
  | { type: 'threads_updated'; threadId?: number }
  | { type: 'typing_updated'; threadId: number; typing?: boolean }
  | { type: 'presence_updated'; threadId: number }
  | { type: 'error'; message: string };

const inboxRoomId = 'site_inbox';

const allowedEventTypes = new Set([
  'thread_updated',
  'threads_updated',
  'typing_updated',
  'presence_updated',
]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
    },
  });
}

function healthJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'content-type': 'application/json; charset=UTF-8',
    },
  });
}

async function secretFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return bytesToBase64Url(digest).slice(0, 16);
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64Url(bytes: BufferSource): string {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const raw = String.fromCharCode(...view);

  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));

  return bytesToBase64Url(signature);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index++) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}

function isSignedSession(value: unknown): value is SignedSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeSession = value as Partial<SignedSession>;

  return (
    typeof maybeSession.siteId === 'string' &&
    maybeSession.siteId.length > 0 &&
    typeof maybeSession.roomId === 'string' &&
    maybeSession.roomId.length > 0 &&
    Number.isFinite(maybeSession.threadId) &&
    maybeSession.threadId! >= 0 &&
    (maybeSession.role === 'customer' || maybeSession.role === 'agent') &&
    Number.isFinite(maybeSession.exp)
  );
}

async function verifySessionToken(token: string, secret: string): Promise<SignedSession | null> {
  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature || !secret) {
    return null;
  }

  const expectedSignature = await hmacSha256(secret, encodedPayload);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)));
  } catch {
    return null;
  }

  if (!isSignedSession(decoded)) {
    return null;
  }

  if (decoded.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return decoded;
}

function getWebSocketPair(): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  return { client, server };
}

function sendSocket(socket: WebSocket, event: ServerEvent): void {
  try {
    socket.send(JSON.stringify(event));
  } catch {
    socket.close(1011, 'Failed to send event.');
  }
}

function readSessionHeader(request: Request): SignedSession | null {
  const encoded = request.headers.get('x-aiwp-session');
  if (!encoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    return isSignedSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function encodeSessionHeader(session: SignedSession): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(session)));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'OPTIONS') {
      return healthJson(null, 204);
    }

    if (url.pathname === '/health') {
      return healthJson({
        ok: true,
        service: 'aiwp-support-chat-worker',
        version: '2026-06-03-inbox-room',
        hasSigningSecret: Boolean(env.AIWP_SIGNING_SECRET),
        signingSecretFingerprint: env.AIWP_SIGNING_SECRET ? await secretFingerprint(env.AIWP_SIGNING_SECRET) : '',
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'Expected websocket Upgrade request.' }, 426);
    }

    const token = url.searchParams.get('token') || request.headers.get('x-aiwp-token') || '';
    const session = await verifySessionToken(token, env.AIWP_SIGNING_SECRET);

    if (!session) {
      return json({ error: 'Invalid or expired websocket token.' }, 401);
    }

    const roomId = url.searchParams.get('roomId') || session.roomId;
    if (roomId !== session.roomId) {
      return json({ error: 'Room does not match websocket token.' }, 403);
    }

    const objectId = env.SUPPORT_ROOM.idFromName(`${session.siteId}:${session.roomId}`);
    const room = env.SUPPORT_ROOM.get(objectId);
    const roomRequest = new Request(request, {
      headers: new Headers(request.headers),
    });

    roomRequest.headers.set('x-aiwp-session', encodeSessionHeader(session));

    return room.fetch(roomRequest);
  },
};

export class SupportRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/internal-broadcast') {
      const event = (await request.json().catch(() => null)) as ServerEvent | null;
      if (!event || typeof event.type !== 'string') {
        return json({ error: 'Invalid broadcast event.' }, 400);
      }

      this.broadcast(event);
      return json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'Expected websocket Upgrade request.' }, 426);
    }

    const session = readSessionHeader(request);
    if (!session) {
      return json({ error: 'Missing room session.' }, 401);
    }

    const { client, server } = getWebSocketPair();

    server.serializeAttachment(session);
    // Prefer hibernation WebSockets to reduce cost when rooms are idle.
    // If the runtime doesn't support it, fall back to the standard API.
    const anyState = this.state as unknown as {
      acceptWebSocket?: (socket: WebSocket) => void;
      acceptWebSocketHibernatable?: (socket: WebSocket) => void;
    };
    if (typeof anyState.acceptWebSocketHibernatable === 'function') {
      anyState.acceptWebSocketHibernatable(server);
    } else {
      this.state.acceptWebSocket(server);
    }
    sendSocket(server, {
      type: 'subscribed',
      roomId: session.roomId,
      threadId: session.threadId,
      role: session.role,
    });

    if (session.roomId !== inboxRoomId) {
      this.broadcast(
        {
          type: 'presence_updated',
          threadId: session.threadId,
        },
        server
      );
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = socket.deserializeAttachment() as SignedSession | null;
    if (!session) {
      socket.close(1008, 'Missing session.');
      return;
    }

    let event: ClientEvent | null = null;
    try {
      event = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as ClientEvent;
    } catch {
      sendSocket(socket, { type: 'error', message: 'Invalid JSON event.' });
      return;
    }

    if (!event || !allowedEventTypes.has(event.type)) {
      sendSocket(socket, { type: 'error', message: 'Unsupported event type.' });
      return;
    }

    const threadId = event.threadId ?? session.threadId;
    if (session.roomId !== inboxRoomId && threadId !== session.threadId) {
      sendSocket(socket, { type: 'error', message: 'Thread does not match room session.' });
      return;
    }

    if (event.type === 'threads_updated') {
      this.broadcast({ type: 'threads_updated', threadId }, socket);
      await this.broadcastToInbox(session, { type: 'threads_updated', threadId });
      return;
    }

    if (event.type === 'typing_updated') {
      this.broadcast({ type: 'typing_updated', threadId, typing: event.typing }, socket);
      return;
    }

    if (event.type === 'presence_updated') {
      this.broadcast({ type: 'presence_updated', threadId }, socket);
      return;
    }

    this.broadcast({ type: 'thread_updated', threadId }, socket);
    await this.broadcastToInbox(session, { type: 'threads_updated', threadId });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const session = socket.deserializeAttachment() as SignedSession | null;
    if (!session) {
      return;
    }

    this.broadcast(
      {
        type: 'presence_updated',
        threadId: session.threadId,
      },
      socket
    );
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, 'Websocket error.');
  }

  private broadcast(event: ServerEvent, sender?: WebSocket): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) {
        continue;
      }

      sendSocket(socket, event);
    }
  }

  private async broadcastToInbox(session: SignedSession, event: ServerEvent): Promise<void> {
    if (session.roomId === inboxRoomId) {
      return;
    }

    const objectId = this.env.SUPPORT_ROOM.idFromName(`${session.siteId}:${inboxRoomId}`);
    const room = this.env.SUPPORT_ROOM.get(objectId);

    await room.fetch('https://internal/internal-broadcast', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
    });
  }
}
