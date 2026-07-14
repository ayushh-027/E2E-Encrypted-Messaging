import asyncio
import json
import logging
import os
import random
from http import HTTPStatus
import websockets

# Pehle yahan poora "websockets" logger CRITICAL pe silence kar diya tha taaki
# stray HEAD-request warnings na aayein - lekin isse asli crash tracebacks
# (jaise handler() ke andar koi unhandled exception) bhi chhup jaate the,
# jisse Render logs mein kuch dikhta hi nahi tha jab kuch fail hota tha.
# Ab sirf woh specific harmless HEAD-request warning filter karte hain,
# baaki sab (errors, tracebacks) normally print honge.
logging.basicConfig(level=logging.INFO)


class _SuppressHeadRequestNoise(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return "opening handshake failed" not in msg and "did not receive a valid HTTP request" not in msg


logging.getLogger("websockets").addFilter(_SuppressHeadRequestNoise())

# room_code -> {"host": websocket, "guest": websocket or None}
rooms = {}
# websocket -> room_code (reverse lookup, so we know who a socket is paired with)
ws_room = {}

# Ambiguous characters (0/O, 1/I/L) chhod diye hain taaki code type karna aasan rahe
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 5


def generate_room_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(CODE_LENGTH))
        if code not in rooms:
            return code


def process_request(connection, request):
    """Plain HTTP GET requests (browser mein link khola, health check, etc.)
    ko ek simple "OK" response de do, error throw karne ke bajaye."""
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return connection.respond(HTTPStatus.OK, "Relay server is running.\n")
    return None


def get_partner(websocket):
    """Given a socket, find the other socket in its room (or None)."""
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
    """Room ko tear down karo jab koi bhi side disconnect ho jaye - dono
    ko wapas lobby mein bhej do, "half-open" room mein latakne mat do."""
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
    print(f"[+] Client connected: {websocket.remote_address}")
    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "create_room":
                code = generate_room_code()
                rooms[code] = {"host": websocket, "guest": None}
                ws_room[websocket] = code
                print(f"[+] Room {code} created")
                await websocket.send(json.dumps({"type": "room_created", "code": code}))

            elif msg_type == "join_room":
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
                # Ab explicit target username ki zaroorat nahi - sender jis room
                # mein hai, uska partner hi automatically target ban jaata hai
                partner = get_partner(websocket)
                if partner:
                    await partner.send(json.dumps({
                        "type": "from",
                        "payload": data["payload"]
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
    # Render apne aap PORT environment variable set karta hai - isi pe bind karna zaroori hai
    port = int(os.environ.get("PORT", 10000))
    async with websockets.serve(handler, "0.0.0.0", port, process_request=process_request):
        print(f"Relay server (WebSocket) running on port {port}")
        await asyncio.Future()  # hamesha ke liye chalta rahe


if __name__ == "__main__":
    asyncio.run(main())
