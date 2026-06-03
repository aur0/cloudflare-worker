# WooPilot Cloudflare Live Chat Worker

This is the first deployable Worker/Durable Object scaffold for WooPilot live support rooms.

It does not store chat messages. WordPress remains the source of truth.

## What It Does

- Accepts websocket requests at the Worker URL.
- Verifies a short-lived HMAC token issued by WordPress.
- Routes the socket to a Durable Object room using `siteId:roomId`.
- Uses Durable Object WebSocket hibernation via `state.acceptWebSocket()`.
- Stores per-socket session metadata with `serializeAttachment()`.
- Broadcasts lightweight events:
  - `thread_updated`
  - `threads_updated`
  - `typing_updated`
  - `presence_updated`

## Local Setup

```bash
cd cloudflare-worker
npm install
```

Create `.dev.vars`:

```bash
AIWP_SIGNING_SECRET="same-secret-as-wordpress"
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
wrangler secret put AIWP_SIGNING_SECRET
npm run deploy
```

## Deploy to Cloudflare Button

Cloudflare can deploy this Worker from a public GitHub or GitLab repository:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/your-org/your-repo/tree/main/cloudflare-worker
```

The deploy flow reads `wrangler.toml`, provisions the Durable Object binding, and configures Workers Builds for future pushes.

Requirements:

- The repository must be public.
- If using a subdirectory URL, this `cloudflare-worker` folder must be self-contained.
- The deployer will still need to set `AIWP_SIGNING_SECRET` to match the WordPress plugin's signing secret.

## Websocket URL

The client connects with:

```text
wss://your-worker.example.workers.dev/?roomId=aiwp_live_abc123&token=TOKEN
```

The `roomId` must match the signed token payload.

## Token Format

The Worker expects:

```text
base64url(json_payload).base64url(hmac_sha256_signature)
```

The HMAC signs only the encoded payload.

Payload:

```json
{
  "siteId": "site_abc123",
  "roomId": "aiwp_live_abc123",
  "threadId": 123,
  "role": "customer",
  "exp": 1790000000
}
```

Agent payload:

```json
{
  "siteId": "site_abc123",
  "roomId": "aiwp_live_abc123",
  "threadId": 123,
  "role": "agent",
  "userId": 5,
  "exp": 1790000000
}
```

WordPress should issue these tokens from a REST endpoint after checking:

- customer thread public token for `customer`
- `manage_options` or `manage_woocommerce` for `agent`

## Client Events

After a browser writes a message to WordPress REST, it should notify the room:

```json
{ "type": "thread_updated", "threadId": 123 }
```

For inbox list refreshes:

```json
{ "type": "threads_updated", "threadId": 123 }
```

For typing:

```json
{ "type": "typing_updated", "threadId": 123, "typing": true }
```

For presence:

```json
{ "type": "presence_updated", "threadId": 123 }
```

## Important Rule

Always write messages to WordPress first.

```text
browser -> WordPress REST save message
browser -> Cloudflare broadcast event
other browser -> WordPress REST reload messages
```

Cloudflare is the realtime signal, not the chat database.
