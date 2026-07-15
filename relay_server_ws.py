import asyncio
import json
import logging
import os
import random
import time
from collections import defaultdict, deque
from http import HTTPStatus
import websockets

MAX_PAYLOAD_B64_CHARS = 4000
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_ACTIONS = 20
MAX_ROOMS = 5000

_allowed_origins_env = os.environ.get("ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()] or None

logging.basicConfig(level=logging.INFO)

class _SuppressHeadRequestNoise(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return "opening handshake failed" not in msg and "did not receive a valid HTTP request" not in msg

logging.getLogger("websockets").addFilter(_SuppressHeadRequestNoise())

rooms = {}

ws_room = {}

recent_actions = defaultdict(deque)

def rate_limited(ip):
    now = time.monotonic()
    q = recent_actions[ip]
    while q and now - q[0] > RATE_LIMIT_WINDOW_SEC:
        q.popleft()
    if len(q) >= RATE_LIMIT_MAX_ACTIONS:
        return True
    q.append(now)
    return False

CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 5

def generate_room_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(CODE_LENGTH))
        if code not in rooms:
            return code

def process_request(connection, request):
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return connection.respond(HTTPStatus.OK, "Relay server is running.\n")
    return None

def get_partner(websocket):
    code = ws_room.get(websocket)
    if not code:
        return None
    room = rooms.get(code)
    if not room:
        return None
    if room["host"] is websocket:
        return room["guest"]
    if room["guest"] is websocket:
        return room["host"]
    return None

async def cleanup(websocket):
    code = ws_room.pop(websocket, None)
    if not code:
        return
    room = rooms.pop(code, None)
    if not room:
        return

    other = room["guest"] if room["host"] is websocket else room["host"]
    if other:
        ws_room.pop(other, None)
        try:
            await other.send(json.dumps({"type": "partner_left"}))
        except websockets.exceptions.ConnectionClosed:
            pass
    print(f"[-] Room {code} closed")

async def handler(websocket):
    ip = websocket.remote_address[0] if websocket.remote_address else "unknown"
    print(f"[+] Client connected: {websocket.remote_address}")
    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "create_room":
                if rate_limited(ip):
                    await websocket.send(json.dumps({"type": "error", "message": "Too many attempts. Please wait a bit."}))
                    continue
                if len(rooms) >= MAX_ROOMS:
                    await websocket.send(json.dumps({"type": "error", "message": "Server is at capacity. Try again later."}))
                    continue
                code = generate_room_code()
                rooms[code] = {"host": websocket, "guest": None}
                ws_room[websocket] = code
                print(f"[+] Room {code} created")
                await websocket.send(json.dumps({"type": "room_created", "code": code}))

            elif msg_type == "join_room":
                if rate_limited(ip):
                    await websocket.send(json.dumps({"type": "error", "message": "Too many attempts. Please wait a bit."}))
                    continue
                code = (data.get("code") or "").strip().upper()
                room = rooms.get(code)

                if not room or room["host"] is None:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": "Room not found. Check the code and try again."
                    }))
                elif room["guest"] is not None:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": "That room is already full."
                    }))
                else:
                    room["guest"] = websocket
                    ws_room[websocket] = code
                    print(f"[+] Guest joined room {code}")
                    await websocket.send(json.dumps({"type": "room_joined", "code": code}))
                    await room["host"].send(json.dumps({"type": "partner_joined"}))

            elif msg_type == "msg":
                payload = data.get("payload", "")
                if len(payload) > MAX_PAYLOAD_B64_CHARS:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": "Message rejected: payload too large."
                    }))
                    continue

                partner = get_partner(websocket)
                if partner:
                    await partner.send(json.dumps({
                        "type": "from",
                        "payload": payload
                    }))
                else:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": "Your partner isn't connected yet."
                    }))

            elif msg_type == "leave_room":
                await cleanup(websocket)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception:
        import traceback
        print("[!] Handler crashed:")
        traceback.print_exc()
    finally:
        await cleanup(websocket)

async def main():

    port = int(os.environ.get("PORT", 10000))
    if ALLOWED_ORIGINS is None:
        print("[!] ALLOWED_ORIGINS not set - accepting connections from any origin. "
              "Set the ALLOWED_ORIGINS env var on Render to restrict this.")
    async with websockets.serve(
        handler, "0.0.0.0", port,
        process_request=process_request,
        origins=ALLOWED_ORIGINS,
    ):
        print(f"Relay server (WebSocket) running on port {port}")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
