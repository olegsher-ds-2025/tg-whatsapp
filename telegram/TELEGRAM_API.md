# Telegram Proxy API

Base URL: `http://<jetson-ip>:9080`

## Authentication

If `API_KEY` is set in `.env`, every request must include:

```
X-API-Key: <your-api-key>
```

If `API_KEY` is not set, the proxy is open to anyone who can reach it on the network.

---

## `GET /health`

Health check.

**Response `200`**
```json
{ "status": "ok" }
```

---

## `POST /send`

Send a message to a group, channel, or chat.

**Headers**
```
Content-Type: application/json
X-API-Key: <your-api-key>      (if configured)
```

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `chat_id` | string | yes | Group/channel/chat id, e.g. `-1001234567890`, or `@channelusername` |
| `text` | string | yes | Message text |
| `parse_mode` | string | no | `"Markdown"` or `"HTML"` |
| `reply_to_message_id` | int | no | Reply to a specific message |

**Example**
```bash
curl -X POST http://10.0.0.X:9080/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: changeme-shared-secret" \
  -d '{"chat_id": "-1001234567890", "text": "Deploy finished ✅"}'
```

**Response `200`** — returns the sent [Telegram Message object](https://core.telegram.org/bots/api#message).

**Errors**
- `401` — missing/invalid `X-API-Key`
- `502` — Telegram rejected the request (e.g. bad chat_id, bot not in chat); body contains Telegram's raw error

---

## `GET /messages`

Fetch recent incoming updates, optionally filtered to one chat.

**Query params**
| Param | Type | Required | Notes |
|---|---|---|---|
| `chat_id` | string | no | Filter to this group/channel id |
| `limit` | int | no | 1–100, default 50 |
| `offset` | int | no | Telegram update offset, for pagination/ack |

**Example**
```bash
curl "http://10.0.0.X:8080/messages?chat_id=-1001234567890&limit=20" \
  -H "X-API-Key: changeme-shared-secret"
```

**Response `200`** — array of [Telegram Update objects](https://core.telegram.org/bots/api#update).

**Note:** Telegram's `getUpdates` only returns messages since the bot's last poll/offset, and stops working once a webhook is set. This endpoint is meant for simple polling use cases, not a full message archive.

---

## `POST /call`

Generic passthrough to **any** [Telegram Bot API method](https://core.telegram.org/bots/api#available-methods) — covers anything not wrapped above (e.g. `getChat`, `pinChatMessage`, `sendPhoto`, `getChatMember`, `setChatTitle`, etc.).

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `method` | string | yes | Exact Telegram method name |
| `params` | object | no | Method parameters as JSON, per Telegram docs |

**Example — get chat info**
```bash
curl -X POST http://10.0.0.X:9080/call \
  -H "Content-Type: application/json" \
  -H "X-API-Key: changeme-shared-secret" \
  -d '{"method": "getChat", "params": {"chat_id": "-1001234567890"}}'
```

**Example — pin a message**
```bash
curl -X POST http://10.0.0.X:9080/call \
  -H "Content-Type: application/json" \
  -H "X-API-Key: changeme-shared-secret" \
  -d '{"method": "pinChatMessage", "params": {"chat_id": "-1001234567890", "message_id": 42}}'
```

**Response `200`** — raw Telegram API response: `{"ok": true/false, "result": ..., "description": ...}`. The proxy does not unwrap or validate this one — check `ok` yourself.

---

## Quick integration notes for client apps

- Always pass the target group/channel as `chat_id` per request — the proxy itself is chat-agnostic.
- The bot must already be added to the group/channel (and be admin, for actions like pinning).
- Treat `/call` as an escape hatch; prefer `/send` and `/messages` for the common path.
- No rate limiting is enforced by the proxy — Telegram's own limits (~30 msg/sec global, 20 msg/min per group) still apply.

---

## Monitoring, logging & alerting

This is operational behavior of the proxy itself, not an endpoint apps call.

**Logging**
- All requests, Telegram errors, and unhandled exceptions are logged to a rotating file at `LOG_FILE` (default `/app/logs/app.log`, 5MB × 5 backups) and also to stdout (visible via `docker logs telegram-proxy`).
- Set verbosity with `LOG_LEVEL` (`DEBUG` / `INFO` / `WARNING` / `ERROR`).
- The log file lives on the host at `./logs/app.log` via the compose volume mount, so it survives container restarts/rebuilds.

**Failure alerts**
- If `ALERT_CHAT_ID` is set, the proxy automatically sends a message to that Telegram chat/channel whenever:
  - Telegram returns an error for `sendMessage`, `getUpdates`, or `/call`
  - the proxy can't reach Telegram at all (network error)
  - any unhandled exception occurs inside the proxy
- Alerts are throttled per error type via `ALERT_COOLDOWN_SECONDS` (default 60s) so a repeated failure doesn't flood the channel.
- Alert delivery failures are only logged locally — they never raise or loop back into the alert system.
- Leave `ALERT_CHAT_ID` unset to disable alerting entirely (logging still works).
