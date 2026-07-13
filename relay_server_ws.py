import asyncio
import json
import logging
import os
from http import HTTPStatus
import websockets

# websockets library sirf HEAD requests parse nahi kar paati (RFC 6455 mein
# sirf GET allowed hai). Aise stray requests (browser ka link preview, external
# monitor, koi bhi bina-websocket-upgrade wala hit) bas ignore kar dete hain -
# yeh harmless hai, actual chat clients hamesha proper GET+Upgrade bhejte hain.
logging.getLogger("websockets").setLevel(logging.CRITICAL)

clients = {}  # username -> websocket connection


def process_request(connection, request):
    """Plain HTTP GET requests (browser mein link khola, health check, etc.)
    ko ek simple "OK" response de do, error throw karne ke bajaye."""
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return connection.respond(HTTPStatus.OK, "Relay server is running.\n")
    return None


async def handler(websocket):
    username = None
    try:
        async for message in websocket:
            data = json.loads(message)

            if data["type"] == "register":
                username = data["username"]
                clients[username] = websocket
                print(f"[+] {username} connected")
                await websocket.send(json.dumps({"type": "ok"}))

            elif data["type"] == "msg":
                target = data["target"]
                if target in clients:
                    await clients[target].send(json.dumps({
                        "type": "from",
                        "sender": username,
                        "payload": data["payload"]
                    }))
                else:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": f"{target} is offline or doesn't exist"
                    }))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if username and clients.get(username) is websocket:
            del clients[username]
        print(f"[-] {username} disconnected")


async def main():
    # Render apne aap PORT environment variable set karta hai - isi pe bind karna zaroori hai
    port = int(os.environ.get("PORT", 10000))
    async with websockets.serve(handler, "0.0.0.0", port, process_request=process_request):
        print(f"Relay server (WebSocket) running on port {port}")
        await asyncio.Future()  # hamesha ke liye chalta rahe


if __name__ == "__main__":
    asyncio.run(main())
