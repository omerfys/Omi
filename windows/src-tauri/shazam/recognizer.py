# -*- coding: utf-8 -*-
"""
Acoustic Music Recognizer (Shazam Native Protocol) for Coucou / Omi.
Captures speaker loopback audio across all Windows endpoints (including SteelSeries Sonar)
and performs exact landmark acoustic fingerprinting with Apple's Shazam database.
Zero hallucinations: returns exact matches only.
"""

import ctypes
from ctypes import wintypes
import time
import io
import wave
import json
import uuid
import sys
import os
import urllib.request
import numpy as np
import scipy.signal

# Add current directory to path for algorithm & signature_format imports
curr_dir = os.path.dirname(os.path.abspath(__file__))
if curr_dir not in sys.path:
    sys.path.insert(0, curr_dir)

import algorithm
import signature_format

ole32 = ctypes.windll.ole32
ole32.CoInitialize(None)

class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8)
    ]

def make_guid(d1, d2, d3, d4):
    g = GUID()
    g.Data1 = d1; g.Data2 = d2; g.Data3 = d3
    for i, b in enumerate(d4): g.Data4[i] = b
    return g

CLSID_MMDeviceEnumerator = make_guid(0xBCDE0395, 0xE52F, 0x467C, [0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E])
IID_IMMDeviceEnumerator = make_guid(0xA95664D2, 0x9614, 0x4F35, [0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6])
IID_IAudioClient = make_guid(0x1CB9AD4C, 0xDBFA, 0x4C32, [0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2])
IID_IAudioCaptureClient = make_guid(0xc8adbd64, 0xe71e, 0x48a0, [0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17])

class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD)
    ]

def capture_active_audio(duration=3.5):
    pEnum = ctypes.c_void_p()
    if ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, 1, ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(pEnum)) != 0:
        return None
    enum_v = ctypes.cast(pEnum, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents

    pColl = ctypes.c_void_p()
    ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))(enum_v[3])(pEnum, 0, 1, ctypes.byref(pColl))
    if not pColl.value:
        return None
    coll_v = ctypes.cast(pColl, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents

    cnt = wintypes.UINT(0)
    ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(wintypes.UINT))(coll_v[3])(pColl, ctypes.byref(cnt))
    ItemFn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p))(coll_v[4])

    for i in range(cnt.value):
        pDev = ctypes.c_void_p()
        ItemFn(pColl, i, ctypes.byref(pDev))
        if not pDev.value:
            continue
        dev_v = ctypes.cast(pDev, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents

        ActivateFn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(dev_v[3])
        pClient = ctypes.c_void_p()
        if ActivateFn(pDev, ctypes.byref(IID_IAudioClient), 1, None, ctypes.byref(pClient)) != 0 or not pClient.value:
            continue

        client_v = ctypes.cast(pClient, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        pWaveFormat = ctypes.c_void_p()
        ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(client_v[8])(pClient, ctypes.byref(pWaveFormat))
        if not pWaveFormat.value:
            continue
        wfx = WAVEFORMATEX.from_address(pWaveFormat.value)

        # Initialize Loopback (AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000)
        hr = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_int, wintypes.DWORD, ctypes.c_longlong, ctypes.c_longlong, ctypes.c_void_p, ctypes.c_void_p)(client_v[3])(pClient, 0, 0x00020000, 10000000, 0, pWaveFormat, None)
        if hr != 0:
            continue

        pCap = ctypes.c_void_p()
        hr = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))(client_v[14])(pClient, ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(pCap))
        if hr != 0 or not pCap.value:
            continue
        cap_v = ctypes.cast(pCap, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents

        GetBuffer = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_ulonglong), ctypes.POINTER(ctypes.c_ulonglong))(cap_v[3])
        ReleaseBuffer = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.UINT)(cap_v[4])
        GetNextPacketSize = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(wintypes.UINT))(cap_v[5])

        StartFn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(client_v[10])
        StopFn = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(client_v[11])

        StartFn(pClient)
        # Probe for 60ms
        time.sleep(0.06)
        packet = wintypes.UINT(0)
        GetNextPacketSize(pCap, ctypes.byref(packet))

        if packet.value > 0:
            # Active audio packets found! Record
            chunks = []
            t0 = time.time()
            while time.time() - t0 < duration:
                GetNextPacketSize(pCap, ctypes.byref(packet))
                while packet.value > 0:
                    pData = ctypes.c_void_p(); num_frames = wintypes.UINT(0); flags = wintypes.DWORD(0)
                    dp = ctypes.c_ulonglong(0); qp = ctypes.c_ulonglong(0)
                    if GetBuffer(pCap, ctypes.byref(pData), ctypes.byref(num_frames), ctypes.byref(flags), ctypes.byref(dp), ctypes.byref(qp)) == 0 and num_frames.value > 0:
                        bc = num_frames.value * wfx.nBlockAlign
                        raw = (ctypes.c_char * bc).from_address(pData.value).raw
                        if not (flags.value & 1):
                            chunks.append(raw)
                        ReleaseBuffer(pCap, num_frames.value)
                    GetNextPacketSize(pCap, ctypes.byref(packet))
                time.sleep(0.01)
            StopFn(pClient)

            total_pcm = b"".join(chunks)
            if len(total_pcm) >= 1000:
                return total_pcm, wfx.nChannels, wfx.wBitsPerSample // 8, wfx.nSamplesPerSec
        else:
            StopFn(pClient)

    return None

def query_shazam_api(sig):
    uuid_a = str(uuid.uuid4()).upper()
    uuid_b = str(uuid.uuid4()).upper()
    api_url = f"https://amp.shazam.com/discovery/v5/tr/TR/iphone/-/tag/{uuid_a}/{uuid_b}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3"

    data = {
        'timezone': 'Europe/Istanbul',
        'signature': {
            'uri': sig.encode_to_uri(),
            'samplems': int(sig.number_samples / sig.sample_rate_hz * 1000)
        },
        'timestamp': int(time.time() * 1000),
        'context': {},
        'geolocation': {}
    }

    headers = {
        'User-Agent': 'Shazam/3685 CFNetwork/1197 Darwin/20.0.0',
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': 'tr'
    }

    req = urllib.request.Request(api_url, data=json.dumps(data).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode('utf-8'))

def recognize(duration=3.5):
    captured = capture_active_audio(duration)
    if not captured:
        return {"found": False}

    pcm_data, channels, width, rate = captured

    # Convert to mono float32
    if width == 2:
        raw_s16 = np.frombuffer(pcm_data, dtype=np.int16)
        if channels > 1:
            raw_s16 = raw_s16[::channels]
        mono = raw_s16.astype(np.float32) / 32768.0
    elif width == 4:
        raw_f32 = np.frombuffer(pcm_data, dtype=np.float32)
        if channels > 1:
            raw_f32 = raw_f32[::channels]
        mono = raw_f32
    else:
        return {"found": False}

    # Resample to 16,000 Hz
    target_samples = int(len(mono) * 16000 / rate)
    resampled = scipy.signal.resample(mono, target_samples)
    s16_samples = np.clip(resampled * 32767.0, -32768, 32767).astype(np.int16)

    # Generate landmark acoustic fingerprint
    sig_gen = algorithm.SignatureGenerator()
    sig_gen.feed_input(s16_samples.tolist())
    sig_gen.MAX_TIME_SECONDS = 8
    sigs = list(sig_gen)
    if not sigs:
        return {"found": False}

    try:
        res = query_shazam_api(sigs[0])
        if "track" in res:
            t = res["track"]
            title = t.get("title", "")
            artist = t.get("subtitle", "")
            cover = t.get("images", {}).get("coverart", "")
            album = "Single"
            for sec in t.get("sections", []):
                for meta in sec.get("metadata", []):
                    if meta.get("title", "").lower() == "album":
                        album = meta.get("text", album)
            return {
                "found": True,
                "title": title,
                "artist": artist,
                "album": album,
                "cover": cover,
                "source": "Shazam"
            }
    except Exception:
        pass

    return {"found": False}

if __name__ == "__main__":
    dur = 3.5
    if len(sys.argv) > 1:
        try:
            dur = float(sys.argv[1])
        except Exception:
            pass
    result = recognize(dur)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
