import asyncio
import json
import base64
import rsa
import websockets

# Is client ko relay_server_ws.py ke room-code protocol se match karne ke
# liye rewrite kiya gaya hai (pehle wala register/target-username wala
# protocol server se match nahi karta tha).


async def main():
    server_url = input("Relay server WebSocket URL (e.g.  wss://e2e-encrypted-messaging-2.onrender.com/): ").strip()
    mode = input("Room banani hai ya join karni hai? [create/join]: ").strip().lower()

    public_key, private_key = rsa.newkeys(2048)
    partner_public_key = None
    partner_key_ready = asyncio.Event()
    room_ready = asyncio.Event()

    async with websockets.connect(server_url) as ws:

        async def send_payload(payload_bytes):
            encoded = base64.b64encode(payload_bytes).decode()
            await ws.send(json.dumps({"type": "msg", "payload": encoded}))

        async def send_public_key():
            await send_payload(public_key.save_pkcs1("PEM"))

        async def receiver():
            nonlocal partner_public_key
            async for message in ws:
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "error":
                    print(f"\n{data['message']}")

                elif msg_type == "room_created":
                    print(f"\n[Room bana di gayi. Code: {data['code']} - isse partner ko bhejo]")

                elif msg_type == "room_joined":
                    print(f"\n[Room {data['code']} join ho gaya. Partner ka wait kar rahe hain...]")

                elif msg_type == "partner_joined":
                    print("\n[Partner room mein aa gaya. Public key exchange shuru...]")
                    room_ready.set()
                    await send_public_key()

                elif msg_type == "partner_left":
                    print("\n[Partner room chhod gaya.]")

                elif msg_type == "from":
                    raw = base64.b64decode(data["payload"])
                    if partner_public_key is None:
                        try:
                            partner_public_key = rsa.PublicKey.load_pkcs1(raw)
                            partner_key_ready.set()
                            print("\n[Partner ki public key mil gayi. Chat shuru kar sakte ho.]")
                        except Exception:
                            print("\n[Public key parse nahi ho paayi]")
                    else:
                        try:
                            decrypted = rsa.decrypt(raw, private_key).decode()
                            print(f"\nPartner: {decrypted}\nYou: ", end="", flush=True)
                        except Exception:
                            print("\n[Message decrypt nahi ho paaya]")

        receiver_task = asyncio.create_task(receiver())

        if mode == "create":
            await ws.send(json.dumps({"type": "create_room"}))
        else:
            code = input("Room code daalo: ").strip().upper()
            await ws.send(json.dumps({"type": "join_room", "code": code}))

        await room_ready.wait()
        print("Partner ki public key ka wait kar rahe hain...")
        await partner_key_ready.wait()

        loop = asyncio.get_event_loop()
        while True:
            msg = await loop.run_in_executor(None, input, "You: ")
            if msg.lower() == "exit":
                break
            try:
                encrypted = rsa.encrypt(msg.encode(), partner_public_key)
                await send_payload(encrypted)
            except Exception as e:
                print(f"Error: {e} (message bahut lamba ho sakta hai, ~245 bytes limit hai)")

        await ws.send(json.dumps({"type": "leave_room"}))
        receiver_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
