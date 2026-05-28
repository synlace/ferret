import json
import asyncio
import logging
from fastapi import WebSocket, WebSocketDisconnect
from services.remote_shell import RunnerShellSession

_log = logging.getLogger(__name__)

class TerminalFrameBroker:
    def __init__(self, websocket: WebSocket, session: RunnerShellSession):
        self.websocket = websocket
        self.session = session
        self.active = True

    async def run(self) -> None:
        loop = asyncio.get_running_loop()

        # Define output reader callback
        def on_output(data: bytes) -> None:
            if not self.active:
                return
            if not data:
                # EOF reached, stop
                self.active = False
                # Try to close websocket cleanly from loop
                asyncio.run_coroutine_threadsafe(self.websocket.close(), loop)
                return
            
            # Send to websocket
            asyncio.run_coroutine_threadsafe(self.websocket.send_bytes(data), loop)

        # Set read callback on the shell session
        self.session.read_output(on_output)

        try:
            while self.active:
                # Receive input from browser terminal (keystrokes or control frames)
                message = await self.websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break

                text_data = message.get("text")
                bytes_data = message.get("bytes")

                if text_data is not None:
                    # Try to parse as JSON control frame (e.g. resize)
                    try:
                        parsed = json.loads(text_data)
                        if isinstance(parsed, dict) and parsed.get("type") == "resize":
                            cols = parsed.get("cols")
                            rows = parsed.get("rows")
                            if isinstance(cols, int) and isinstance(rows, int):
                                try:
                                    await self.session.resize(cols, rows)
                                except Exception as resize_err:
                                    _log.error(f"Failed to resize terminal: {resize_err}")
                                continue
                    except json.JSONDecodeError:
                        pass

                    # Otherwise, treat as raw keystroke data
                    await self.session.send_input(text_data.encode("utf-8"))

                elif bytes_data is not None:
                    await self.session.send_input(bytes_data)

        except WebSocketDisconnect:
            pass
        except Exception as e:
            _log.error(f"Error in TerminalFrameBroker loop: {e}")
        finally:
            self.active = False
            try:
                await self.session.close()
            except Exception:
                pass
