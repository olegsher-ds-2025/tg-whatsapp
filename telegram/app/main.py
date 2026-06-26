import logging
import os
import time
from logging.handlers import RotatingFileHandler
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ---- Config ----
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
API_KEY = os.environ.get("API_KEY")
ALERT_CHAT_ID = os.environ.get("ALERT_CHAT_ID")  # predefined channel for failure alerts
ALERT_COOLDOWN_SECONDS = int(os.environ.get("ALERT_COOLDOWN_SECONDS", "60"))
LOG_FILE = os.environ.get("LOG_FILE", "/app/logs/app.log")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ---- Logging: file (rotating) + console (so `docker logs` still works) ----
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

logger = logging.getLogger("telegram_proxy")
logger.setLevel(LOG_LEVEL)

_formatter = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

_file_handler = RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=5)
_file_handler.setFormatter(_formatter)
logger.addHandler(_file_handler)

_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_formatter)
logger.addHandler(_console_handler)

app = FastAPI(title="Telegram Proxy")

# ---- Alerting: push failures to a predefined Telegram channel, with cooldown to avoid storms/loops ----
_last_alert_at: dict[str, float] = {}


async def send_alert(message: str, key: Optional[str] = None) -> None:
    """Best-effort alert to ALERT_CHAT_ID. Never raises, never blocks the request lifecycle."""
    if not ALERT_CHAT_ID:
        return
    throttle_key = key or message
    now = time.monotonic()
    last = _last_alert_at.get(throttle_key, 0)
    if now - last < ALERT_COOLDOWN_SECONDS:
        return
    _last_alert_at[throttle_key] = now
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{TELEGRAM_API}/sendMessage",
                json={"chat_id": ALERT_CHAT_ID, "text": f"⚠️ telegram-proxy: {message}"},
            )
    except Exception:
        logger.exception("Failed to deliver alert to Telegram (content: %s)", message)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    await send_alert(
        f"Unhandled error on {request.method} {request.url.path}: {exc}",
        key=f"unhandled:{request.url.path}",
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


def check_auth(x_api_key: Optional[str]) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


class SendMessageRequest(BaseModel):
    chat_id: str
    text: str
    parse_mode: Optional[str] = None
    reply_to_message_id: Optional[int] = None


class RawMethodRequest(BaseModel):
    method: str
    params: dict[str, Any] = {}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/send")
async def send_message(req: SendMessageRequest, x_api_key: Optional[str] = Header(None)):
    check_auth(x_api_key)
    payload = req.model_dump(exclude_none=True)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(f"{TELEGRAM_API}/sendMessage", json=payload)
        data = resp.json()
    except httpx.HTTPError as e:
        logger.error("Network error calling sendMessage: %s", e)
        await send_alert(f"Network error calling sendMessage: {e}", key="net:sendMessage")
        raise HTTPException(status_code=502, detail="Telegram unreachable")

    if not data.get("ok"):
        logger.error("Telegram rejected sendMessage to %s: %s", req.chat_id, data)
        await send_alert(
            f"sendMessage to {req.chat_id} failed: {data.get('description')}",
            key=f"send_fail:{req.chat_id}",
        )
        raise HTTPException(status_code=502, detail=data)

    logger.info("Sent message to %s", req.chat_id)
    return data["result"]


@app.get("/messages")
async def get_messages(
    chat_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    offset: Optional[int] = None,
    x_api_key: Optional[str] = Header(None),
):
    check_auth(x_api_key)
    params: dict[str, Any] = {"limit": limit}
    if offset is not None:
        params["offset"] = offset
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{TELEGRAM_API}/getUpdates", params=params)
        data = resp.json()
    except httpx.HTTPError as e:
        logger.error("Network error calling getUpdates: %s", e)
        await send_alert(f"Network error calling getUpdates: {e}", key="net:getUpdates")
        raise HTTPException(status_code=502, detail="Telegram unreachable")

    if not data.get("ok"):
        logger.error("Telegram rejected getUpdates: %s", data)
        await send_alert(f"getUpdates failed: {data.get('description')}", key="getUpdates_fail")
        raise HTTPException(status_code=502, detail=data)

    updates = data["result"]
    if chat_id:
        updates = [
            u for u in updates
            if str(u.get("message", {}).get("chat", {}).get("id")) == str(chat_id)
            or str(u.get("channel_post", {}).get("chat", {}).get("id")) == str(chat_id)
        ]
    return updates


@app.post("/call")
async def call_raw_method(req: RawMethodRequest, x_api_key: Optional[str] = Header(None)):
    """Generic passthrough for any Telegram Bot API method."""
    check_auth(x_api_key)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(f"{TELEGRAM_API}/{req.method}", json=req.params)
        data = resp.json()
    except httpx.HTTPError as e:
        logger.error("Network error calling %s: %s", req.method, e)
        await send_alert(f"Network error calling {req.method}: {e}", key=f"net:{req.method}")
        raise HTTPException(status_code=502, detail="Telegram unreachable")

    if not data.get("ok"):
        logger.warning("Telegram method %s returned error: %s", req.method, data)
        await send_alert(f"{req.method} failed: {data.get('description')}", key=f"call_fail:{req.method}")

    return data
