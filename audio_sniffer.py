#!/usr/bin/env python3
"""
Immersive Lyric Engine - Audio Sniffer & Lyric Forwarder Service
Two roles:
1. Listens to system audio via PulseAudio, performs FFT, streams frequency data
2. Receives lyric updates from Tampermonkey via WebSocket, forwards to local-player
"""

import sys
import asyncio
import numpy as np
import websockets
import logging
from datetime import datetime
import json

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('AudioLyricService')

try:
    import pulsectl
    PULSECTL_AVAILABLE = True
except ImportError:
    PULSECTL_AVAILABLE = False
    log.warning("pulsectl not available")

try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False
    log.warning("sounddevice not available")

HOST = 'localhost'
PORT = 8765
LYRIC_PORT = 8766
FPS = 60
CHUNK_DURATION_MS = 50
SAMPLE_RATE = 44100
N_FFT = 1024
N_FREQ_BANDS = 32

def compute_frequency_bands(fft_data, sample_rate, n_bands):
    freqs = np.fft.rfftfreq(len(fft_data), 1.0 / sample_rate)
    band_size = len(fft_data) // n_bands
    bands = []
    for i in range(n_bands):
        start = i * band_size
        end = start + band_size if i < n_bands - 1 else len(fft_data)
        band_energy = np.mean(np.abs(fft_data[start:end]))
        bands.append(float(band_energy))
    return bands

async def broadcast_to_players(message):
    """Broadcast message to all connected local-player clients."""
    if broadcast_to_players.players:
        await asyncio.gather(
            *[p.send(message) for p in broadcast_to_players.players],
            return_exceptions=True
        )
broadcast_to_players.players = set()

async def register_player(websocket):
    broadcast_to_players.players.add(websocket)
    log.info(f"Player registered. Total players: {len(broadcast_to_players.players)}")
    try:
        await websocket.wait_closed()
    finally:
        broadcast_to_players.players.discard(websocket)
        log.info(f"Player unregistered. Total players: {len(broadcast_to_players.players)}")

async def lyric_from_tampermonkey(websocket):
    """Receive lyrics from Tampermonkey script and broadcast to players."""
    log.info("Tampermonkey client connected for lyric forwarding")
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                if data.get('type') == 'lyric':
                    lyric_text = data.get('text', '')
                    await broadcast_to_players(json.dumps({
                        'type': 'lyric',
                        'text': lyric_text,
                        'timestamp': datetime.now().isoformat()
                    }))
                    log.info(f"Forwarded lyric: {lyric_text[:30]}...")
                elif data.get('type') == 'status'):
                    log.info(f"Tampermonkey status: {data.get('message', '')}")
            except json.JSONDecodeError:
                log.warning(f"Invalid JSON from Tampermonkey: {message[:100]}")
    except websockets.exceptions.ConnectionClosed:
        log.info("Tampermonkey client disconnected")

async def run_pulse_capture():
    log.info("Starting PulseAudio capture...")
    pulse = pulsectl.Pulse('audio-sniffer')

    try:
        monitor_name = None
        for source in pulse.source_list():
            if '.monitor' in source.name:
                monitor_name = source.name
                log.info(f"Found monitor source: {source.name}")
                break

        if not monitor_name:
            log.error("No monitor source found")
            return

        audio_queue = asyncio.Queue()

        def audio_callback(pa_index, data, timestamp):
            if len(data) > 0:
                audio_data = np.frombuffer(data, dtype=np.float32)
                if audio_data.ndim > 1:
                    audio_data = audio_data.mean(axis=1)
                asyncio.create_task(audio_queue.put(audio_data.copy()))

        stream = pulse.stream_new('audio-sniffer', 'audio float32', 2)
        pulse.stream_connect_input(stream, monitor_name, audio_callback, null=True)

        log.info(f"Capturing from {monitor_name}")

        while True:
            try:
                audio_data = await asyncio.wait_for(audio_queue.get(), timeout=1.0 / FPS)

                if len(audio_data) < N_FFT:
                    continue

                windowed = audio_data[:N_FFT] * np.hanning(N_FFT)
                fft_data = np.fft.rfft(windowed)
                fft_magnitude = np.abs(fft_data)

                bands = compute_frequency_bands(fft_magnitude, SAMPLE_RATE, N_FREQ_BANDS)
                bass = float(np.mean(bands[:4]))
                mid = float(np.mean(bands[4:16]))
                high = float(np.mean(bands[16:]))

                msg = json.dumps({
                    'bass': bass,
                    'mid': mid,
                    'high': high,
                    'timestamp': datetime.now().isoformat()
                })

                await broadcast_to_players(msg)

            except asyncio.TimeoutError:
                continue

    except Exception as e:
        log.error(f"PulseAudio capture error: {e}")
    finally:
        pulse.close()

async def run_sounddevice_capture():
    log.info("Starting sounddevice capture...")

    q = asyncio.Queue()
    running = True

    def callback(indata, frames, time, status):
        if status:
            log.warning(f"Audio callback status: {status}")
        if running and len(indata) > 0:
            q.put_nowait(indata.copy())

    try:
        device = None
        devices = sd.query_devices()
        log.info(f"Available devices: {devices}")

        for dev in devices:
            if isinstance(dev, dict) and '.monitor' in str(dev.get('name', '')):
                device = dev.get('index')
                break

        if device is None:
            device = sd.query_devices(kind='output')

        stream = sd.InputStream(
            device=device,
            channels=2,
            samplerate=SAMPLE_RATE,
            blocksize=int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000),
            callback=callback
        )

        with stream:
            log.info("Sounddevice stream started")
            while running:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                audio_data = data.mean(axis=1) if data.ndim > 1 else data[:, 0]

                if len(audio_data) < N_FFT:
                    continue

                windowed = audio_data[:N_FFT] * np.hanning(N_FFT)
                fft_data = np.fft.rfft(windowed)
                fft_magnitude = np.abs(fft_data)

                bands = compute_frequency_bands(fft_magnitude, SAMPLE_RATE, N_FREQ_BANDS)
                bass = float(np.mean(bands[:4]))
                mid = float(np.mean(bands[4:16]))
                high = float(np.mean(bands[16:]))

                msg = json.dumps({
                    'bass': bass,
                    'mid': mid,
                    'high': high,
                    'timestamp': datetime.now().isoformat()
                })

                await broadcast_to_players(msg)

    except Exception as e:
        log.error(f"Sounddevice capture error: {e}")
    finally:
        running = False

async def audio_handler(websocket, path):
    await register_player(websocket)

async def lyric_handler(websocket, path):
    await lyric_from_tampermonkey(websocket)

async def main():
    log.info(f"Starting Audio Lyric Service")
    log.info(f"Audio WebSocket: ws://{HOST}:{PORT}")
    log.info(f"Lyric WebSocket: ws://{HOST}:{LYRIC_PORT}")

    if not PULSECTL_AVAILABLE and not SOUNDDEVICE_AVAILABLE:
        log.error("No audio capture library available!")
        sys.exit(1)

    audio_task = None
    if PULSECTL_AVAILABLE:
        audio_task = asyncio.create_task(run_pulse_capture())
    elif SOUNDDEVICE_AVAILABLE:
        audio_task = asyncio.create_task(run_sounddevice_capture())

    async with (
        websockets.serve(audio_handler, HOST, PORT),
        websockets.serve(lyric_handler, HOST, LYRIC_PORT)
    ):
        log.info("All servers started. Press Ctrl+C to stop.")
        await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Server stopped by user")
        sys.exit(0)