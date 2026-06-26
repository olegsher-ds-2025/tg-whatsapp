# WhatsApp Proxy API

Base URL: `http://<jetson-ip>:8081`

Built on [Baileys](https://github.com/WhiskeySockets/Baileys) — an **unofficial** WhatsApp Web protocol library. It logs in as a real WhatsApp account (via QR code), which is the only way to read/send messages in WhatsApp **Groups**. This is against WhatsApp's Terms of Service; use a non-critical number and avoid high message volume to reduce ban risk.

## Authentication
Same pattern as the Telegram proxy:
```
X-API-Key: <WHATSAPP_API_KEY>
```

---

## First-time setup: linking the account

1. Start the stack: `docker compose up -d`
2. `GET /qr` — returns a PNG QR code (open it in a browser, or `curl http://<ip>:8081/qr -o qr.png`)
3. Open WhatsApp on the phone you want to link → **Settings → Linked Devices → Link a Device** → scan the PNG
4. Once linked, `GET /qr` returns `{"status": "linked"}` and the session is saved to the `whatsapp-auth` volume, so a container restart won't require re-scanning.

---

## `GET /health`
```json
{ "status": "ok", "connected": true }
```

## `GET /qr`
Returns a PNG image of the current pairing QR code, or:
- `{"status": "linked"}` if already connected
- `503 {"status": "qr_not_ready"}` if no QR has been generated yet (wait a few seconds after startup)

## `POST /send`
**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string | yes | Phone number (digits, country code, no `+`) for 1:1, e.g. `"972501234567"`. For groups, the full JID, e.g. `"1203630xxxxx@g.us"` |
| `text` | string | yes | Message text |

```bash
curl -X POST http://10.0.0.X:8081/send \
  -H "Content-Type: application/json" -H "X-API-Key: <key>" \
  -d '{"to": "972501234567", "text": "Hello from the proxy"}'
```

## `GET /messages`
Recent incoming/outgoing messages from an **in-memory buffer** (last `MAX_BUFFERED_MESSAGES`, default 500 — cleared on restart, not persisted to disk).

| Param | Notes |
|---|---|
| `chat_id` | filter to one chat/group JID |
| `limit` | default 50, max 200 |

## `GET /chats`
Lists JIDs the proxy has seen messages from/to since startup, with last-seen name and timestamp — use this to discover a group's JID for `/send`.

---

## Notes
- No equivalent of Telegram's generic `/call` passthrough — Baileys' feature surface (read receipts, media, presence, etc.) is much larger; ask if you need a specific one wired up.
- Failures (send errors, disconnects, logout) are alerted through the existing **telegram-proxy**, to `ALERT_CHAT_ID`, via `TELEGRAM_PROXY_URL` — no separate alert channel needed.
- Logs: rotating file at `LOG_FILE` (mounted to `./logs/whatsapp` on the host) plus `docker logs whatsapp-proxy`.
