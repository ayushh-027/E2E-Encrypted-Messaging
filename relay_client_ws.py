import asyncio
import json
import base64
import rsa
import websockets


async def main():
    server_url = input("Relay server WebSocket URL (e.g. wss://your-app.onrender.com): ").strip()
    my_username = input("Apna username choose karo: ").strip()
    target_username = input("Kisse chat karni hai (unka username): ").strip()

    public_key, private_key = rsa.newkeys(2048)
    partner_public_key = None
    partner_key_ready = asyncio.Event()

    async with websockets.connect(server_url) as ws:
        await ws.send(json.dumps({"type": "register", "username": my_username}))

        async def send_payload(payload_bytes):
            encoded = base64.b64encode(payload_bytes).decode()
            await ws.send(json.dumps({
                "type": "msg",
                "target": target_username,
                "payload": encoded
            }))

        async def receiver():
            nonlocal partner_public_key
            async for message in ws:
                data = json.loads(message)

                if data["type"] == "error":
                    print(f"\n{data['message']}")

                elif data["type"] == "from":
                    raw = base64.b64decode(data["payload"])

                    if partner_public_key is None:
                        # Pehla incoming message partner ki public key honi chahiye
                        partner_public_key = rsa.PublicKey.load_pkcs1(raw)
                        partner_key_ready.set()
                        print(f"\n[{data['sender']} ki public key mil gayi. Chat shuru kar sakte ho.]")
                    else:
                        try:
                            decrypted = rsa.decrypt(raw, private_key).decode()
                            print(f"\n{data['sender']}: {decrypted}\nYou: ", end="", flush=True)
                        except Exception:
                            print(f"\n[Message decrypt nahi ho paaya]")

        receiver_task = asyncio.create_task(receiver())

        # Apni public key partner ko bhejo
        await send_payload(public_key.save_pkcs1("PEM"))
        print("Apni public key bhej di, partner ki public key ka wait kar rahe hain...")
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

        receiver_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
