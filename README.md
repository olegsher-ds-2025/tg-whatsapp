# tg-whatsapp

Self-hosted proxy stack for Telegram and WhatsApp, designed to run on an NVIDIA Jetson Nano via Docker Compose. Exposes simple HTTP APIs that other apps can use to send/receive messages in Telegram groups/channels and WhatsApp chats/groups, with file logging and automatic failure alerts.

## Services

| Service | Port | Docs |
|---|---|---|
| `telegram-proxy` | 8080 | [telegram/TELEGRAM_API.md](telegram/TELEGRAM_API.md) |
| `whatsapp-proxy` | 8081 | [whatsapp/WHATSAPP_API.md](whatsapp/WHATSAPP_API.md) |

## Quick start

```bash
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, API_KEY, WHATSAPP_API_KEY, ALERT_CHAT_ID, etc.

docker compose up -d --build
```

Then:
- Telegram: bot must already be added to the target group/channel.
- WhatsApp: `curl http://<host>:8081/qr -o qr.png` and scan it from WhatsApp → Linked Devices.

## Notes

- WhatsApp group support relies on the unofficial Baileys library (no official API supports WhatsApp groups) — see the WhatsApp docs for the ToS/ban-risk tradeoff.
- Both services log to rotating files under `./logs/` and push failure alerts to a predefined Telegram channel (`ALERT_CHAT_ID`).
- `restart: unless-stopped` handles container auto-restart; run `sudo systemctl enable docker` on the Nano so Docker itself starts on boot.
