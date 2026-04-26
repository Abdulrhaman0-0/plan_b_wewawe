import asyncio
import json
import logging
import os
import time
import websockets
from gpiozero import Motor

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

WS_URL = os.getenv('WS_URL', 'ws://localhost:3000')
DASHBOARD_USER = os.getenv('DASHBOARD_USER', 'admin')
DASHBOARD_PASS = os.getenv('DASHBOARD_PASS', 'admin123')

WATCHDOG_TIMEOUT = 1.0  # seconds

# ---------------------------------------------------------------------------
# BTS7960 Motor Driver GPIO Mappings
# Each BTS7960 has two PWM inputs: RPWM (forward) and LPWM (backward).
# gpiozero's Motor(forward, backward) drives them via software PWM.
# ---------------------------------------------------------------------------
# Left Motor:  RPWM (forward) = GPIO 17,  LPWM (backward) = GPIO 27
left_motor = Motor(forward=17, backward=27)

# Right Motor: RPWM (forward) = GPIO 23,  LPWM (backward) = GPIO 24
right_motor = Motor(forward=23, backward=24)

last_command_time = time.time()
running = True


def stop_motors():
    """Halt both motors immediately."""
    left_motor.stop()
    right_motor.stop()
    logging.info("Motors STOPPED")


def handle_movement(command: str, speed: float):
    """
    Drive the motors according to *command* at the given *speed* (0.0–1.0).

    Commands:
        forward  – both motors drive forward.
        backward – both motors drive backward.
        left     – left motor backward, right motor forward  (pivot left).
        right    – left motor forward,  right motor backward (pivot right).
        stop     – halt both motors.
    """
    global last_command_time
    last_command_time = time.time()

    if command == 'forward':
        left_motor.forward(speed)
        right_motor.forward(speed)
        logging.info(f"Motors -> FORWARD  (speed={speed:.2f})")

    elif command == 'backward':
        left_motor.backward(speed)
        right_motor.backward(speed)
        logging.info(f"Motors -> BACKWARD (speed={speed:.2f})")

    elif command == 'left':
        left_motor.backward(speed)
        right_motor.forward(speed)
        logging.info(f"Motors -> LEFT     (speed={speed:.2f})")

    elif command == 'right':
        left_motor.forward(speed)
        right_motor.backward(speed)
        logging.info(f"Motors -> RIGHT    (speed={speed:.2f})")

    elif command == 'stop':
        stop_motors()

    else:
        logging.warning(f"Unknown command: '{command}'")


async def watchdog_task():
    """Stop the motors if no command is received within WATCHDOG_TIMEOUT seconds."""
    global running, last_command_time
    while running:
        motors_active = (left_motor.value != 0) or (right_motor.value != 0)
        if motors_active and (time.time() - last_command_time > WATCHDOG_TIMEOUT):
            logging.warning(
                f"Watchdog trigger! No message received for >{WATCHDOG_TIMEOUT}s. Forcing STOP."
            )
            stop_motors()
        await asyncio.sleep(0.1)


async def wss_client():
    """
    Connect to the WebSocket server, authenticate, then listen for JSON
    command packets in the format:
        {"command": "<direction>", "speed": <0-100>}
    """
    global last_command_time, running

    while running:
        try:
            logging.info(f"Connecting to {WS_URL}...")
            async with websockets.connect(WS_URL) as ws:
                logging.info("Connected. Sending auth...")

                auth_msg = {
                    "type": "auth",
                    "data": {
                        "username": DASHBOARD_USER,
                        "password": DASHBOARD_PASS,
                    },
                }
                await ws.send(json.dumps(auth_msg))

                # Wait for auth acknowledgement
                resp_json = json.loads(await ws.recv())
                if resp_json.get('type') != 'auth_ok':
                    logging.error(f"Auth failed: {resp_json}")
                    await asyncio.sleep(5)
                    continue

                logging.info("Authenticated. Listening for commands...")

                async for message in ws:
                    try:
                        packet = json.loads(message)

                        # -------------------------------------------------------
                        # Expected payload: {"command": "forward", "speed": 75}
                        # Falls back to legacy {"type": "emergency_stop"} packet.
                        # -------------------------------------------------------
                        if 'command' in packet:
                            command = packet.get('command', 'stop').strip().lower()

                            # Convert 0-100 integer to 0.0-1.0 float; default 50
                            raw_speed = packet.get('speed', 50)
                            speed = max(0.0, min(1.0, int(raw_speed) / 100.0))

                            handle_movement(command, speed)

                        elif packet.get('type') == 'emergency_stop':
                            logging.error("EMERGENCY STOP received via WS!")
                            stop_motors()
                            last_command_time = time.time()

                        else:
                            logging.debug(f"Unhandled packet: {packet}")

                    except (json.JSONDecodeError, ValueError) as exc:
                        logging.error(f"Bad message ({exc}): {message}")

        except Exception as exc:
            logging.error(f"WebSocket error: {exc}")
            stop_motors()
            await asyncio.sleep(3)


async def main():
    stop_motors()

    tasks = [
        asyncio.create_task(wss_client()),
        asyncio.create_task(watchdog_task()),
    ]

    try:
        await asyncio.gather(*tasks)
    except KeyboardInterrupt:
        logging.info("Shutting down...")
    finally:
        global running
        running = False
        stop_motors()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
