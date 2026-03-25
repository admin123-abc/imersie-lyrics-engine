#!/usr/bin/env python3
"""
Immersive Lyric Engine - Audio Sniffer Service
Listens to system audio via PulseAudio, performs FFT analysis,
and streams frequency data to connected WebSocket clients.
"""

import sys
import asyncio
import numpy as np
import websockets
import logging
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('AudioSniffer')

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

async def run_pulse_capture(websocket):
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
            await websocket.send('{"error": "No monitor source found"}')
            return

        audio_queue = asyncio.Queue()
        chunk_size = int(SAMPLE_RATE * CHUNK_DURATION_MS / 1000)

        def audio_callback(pa_index, data, timestamp):
            if len(data) > 0:
                audio_data = np.frombuffer(data, dtype=np.float32)
                if audio_data.ndim > 1:
                    audio_data = audio_data.mean(axis=1)
                asyncio.create_task(audio_queue.put(audio_data.copy()))

        stream = pulse.stream_new('audio-sniffer', 'audio float32', 2)
        pulse.stream_connect_input(stream, monitor_name, null=True, audio_callback)

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

                timestamp = datetime.now().isoformat()
                msg = f'{{"bass":{bass:.6f},"mid":{mid:.6f},"high":{high:.6f},"timestamp":"{timestamp}"}}'

                await websocket.send(msg)

            except asyncio.TimeoutError:
                continue

    except websockets.exceptions.ConnectionClosed:
        log.info("Client disconnected")
    except Exception as e:
        log.error(f"PulseAudio capture error: {e}")
        await websocket.send(f'{{"error": "{e}"}}')
    finally:
        pulse.close()

async def run_sounddevice_capture(websocket):
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

                timestamp = datetime.now().isoformat()
                msg = f'{{"bass":{bass:.6f},"mid":{mid:.6f},"high":{high:.6f},"timestamp":"{timestamp}"}}'

                await websocket.send(msg)

    except websockets.exceptions.ConnectionClosed:
        log.info("Client disconnected")
    except Exception as e:
        log.error(f"Sounddevice capture error: {e}")
        await websocket.send(f'{{"error": "{e}"}}')
    finally:
        running = False

async def handler(websocket, path):
    log.info(f"Client connected from {websocket.remote_address}")
    try:
        await websocket.send(f'{{"status": "connected", "fps": {FPS}}}')

        if PULSECTL_AVAILABLE:
            await run_pulse_capture(websocket)
        elif SOUNDDEVICE_AVAILABLE:
            await run_sounddevice_capture(websocket)
        else:
            await websocket.send('{"error": "No audio capture available"}')
            log.error("No audio capture library available!")
    except websockets.exceptions.ConnectionClosed:
        log.info(f"Client {websocket.remote_address} disconnected")

async def main():
    log.info(f"Starting Audio Sniffer WebSocket server on {HOST}:{PORT}")

    if not PULSECTL_AVAILABLE and not SOUNDDEVICE_AVAILABLE:
        log.error("No audio capture library available! Install pulsectl or sounddevice.")
        sys.exit(1)

    async with websockets.serve(handler, HOST, PORT):
        log.info(f"Server started. Connect ws://{HOST}:{PORT}")
        await asyncio.Future()

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Server stopped by user")
        sys.exit(0)