import asyncio
import json
import logging
import os
import time
import websockets
from gpiozero import PWMOutputDevice, DigitalOutputDevice

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

WS_URL = os.getenv('WS_URL', 'ws://localhost:3000')
DASHBOARD_USER = os.getenv('DASHBOARD_USER', 'admin')
DASHBOARD_PASS = os.getenv('DASHBOARD_PASS', 'admin123')

WATCHDOG_TIMEOUT = 1.0  # seconds

# Initialize motors with the specified MDD10A GPIO mappings
# Left Motor: PWM: 17, DIR: 27
pwm_left = PWMOutputDevice(17)
dir_left = DigitalOutputDevice(27)

# Right Motor: PWM: 23, DIR: 24
pwm_right = PWMOutputDevice(23)
dir_right = DigitalOutputDevice(24)

last_command_time = time.time()
running = True

def stop_motors():
    pwm_left.value = 0
    pwm_right.value = 0
    logging.info("Motors STOPPED")


def handle_movement(direction):
    global last_command_time
    last_command_time = time.time()
    
    current_speed = 1.0
    
    if direction == 'forward':
        dir_left.off()
        dir_right.off()
        pwm_left.value = current_speed
        pwm_right.value = current_speed
        logging.info("Motors -> FORWARD")
    elif direction == 'backward':
        dir_left.on()
        dir_right.on()
        pwm_left.value = current_speed
        pwm_right.value = current_speed
        logging.info("Motors -> BACKWARD")
    elif direction == 'left':
        dir_left.on()
        dir_right.off()
        pwm_left.value = current_speed
        pwm_right.value = current_speed
        logging.info("Motors -> LEFT")
    elif direction == 'right':
        dir_left.off()
        dir_right.on()
        pwm_left.value = current_speed
        pwm_right.value = current_speed
        logging.info("Motors -> RIGHT")
    elif direction == 'stop':
        stop_motors()
    else:
        logging.warning(f"Unknown direction command: {direction}")


async def watchdog_task():
    global running, last_command_time
    while running:
        if pwm_left.value > 0 or pwm_right.value > 0:
            if time.time() - last_command_time > WATCHDOG_TIMEOUT:
                logging.warning(f"Watchdog trigger! No message received for > {WATCHDOG_TIMEOUT}s. Forcing STOP.")
                stop_motors()
        await asyncio.sleep(0.1)


async def wss_client():
    global last_command_time, running
    
    while running:
        try:
            logging.info(f"Connecting to {WS_URL}...")
            async with websockets.connect(WS_URL) as ws:
                logging.info("Connected to WS. Sending auth...")
                auth_msg = {
                    "type": "auth",
                    "data": {
                        "username": DASHBOARD_USER,
                        "password": DASHBOARD_PASS
                    }
                }
                await ws.send(json.dumps(auth_msg))
                
                # Receive auth response
                resp = await ws.recv()
                resp_json = json.loads(resp)
                
                if resp_json.get('type') != 'auth_ok':
                    logging.error(f"Auth failed: {resp_json}")
                    await asyncio.sleep(5)
                    continue
                
                logging.info("Authenticated successfully. Listening for commands...")
                
                # Command listening loop
                async for message in ws:
                    try:
                        packet = json.loads(message)
                        msg_type = packet.get('type')
                        
                        if msg_type == 'manual_cmd':
                            direction = packet.get('data', {}).get('direction')
                            if direction:
                                handle_movement(direction)
                                
                        elif msg_type == 'emergency_stop':
                            logging.error("EMERGENCY STOP received via WS!")
                            stop_motors()
                            last_command_time = time.time() # Reset watchdog so it doesn't immediately complain
                            
                    except json.JSONDecodeError:
                        logging.error(f"Invalid JSON received: {message}")
                        
        except Exception as e:
            logging.error(f"WebSocket Error: {e}")
            stop_motors()
            await asyncio.sleep(3)


async def main():
    stop_motors()
    
    # Start tasks
    tasks = [
        asyncio.create_task(wss_client()),
        asyncio.create_task(watchdog_task())
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
