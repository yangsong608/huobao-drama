#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""四组视频的三维度量化：连贯性 / 一致性 / 自然性。

用法：python3 analyze_ab.py manifest.json > result.json
manifest 形如：
{
 "groups": {
   "baseline": {"shots": [{"name":"1","file":"/path/1.mp4"}, ...]},
   "A_ref":    {"shots": [{"name":"1","src":"/path/full.mp4","start":0,"count":209}, ...]}
 }
}
"""
import json, os, subprocess, sys
import numpy as np
import cv2

W, H = 432, 240
CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


def frames_of(path, start=None, count=None, fps=24):
    cmd = ["ffmpeg", "-v", "error", "-i", path]
    if start is not None:
        cmd += ["-vf", f"select='between(n\\,{start}\\,{start+count-1})',scale={W}:{H}", "-vsync", "0"]
    else:
        cmd += ["-vf", f"scale={W}:{H}"]
    cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    arr = np.frombuffer(raw, dtype=np.uint8)
    n = len(arr) // (W * H * 3)
    return arr[: n * W * H * 3].reshape(n, H, W, 3)


def audio_stats(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    err = r.stderr + r.stdout
    peak = rms = None
    for line in err.splitlines():
        if "max_volume" in line:
            peak = float(line.split(":")[-1].replace("dB", "").strip())
        if "mean_volume" in line:
            rms = float(line.split(":")[-1].replace("dB", "").strip())
    return peak, rms


def face_hist(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = CASCADE.detectMultiScale(gray, 1.15, 5, minSize=(24, 24))
    if len(faces) == 0:
        return None, 0.0
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    crop = frame[y:y + h, x:x + w]
    hist = cv2.calcHist([crop], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
    cv2.normalize(hist, hist)
    return hist.flatten(), w / W


def bg_hist(frame):
    small = cv2.resize(frame, (32, 18))
    hist = cv2.calcHist([small], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
    cv2.normalize(hist, hist)
    return hist.flatten()


def cos(a, b):
    if a is None or b is None:
        return None
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def analyze_shot(spec):
    if "file" in spec:
        path = spec["file"]
        frames = frames_of(path)
        full = path
    else:
        full = spec["src"]
        frames = frames_of(full, spec["start"], spec["count"])
    if len(frames) == 0:
        return None
    faces, widths = [], []
    for i in range(0, len(frames), 4):
        h, w = face_hist(frames[i])
        if h is not None:
            faces.append(h)
            widths.append(w)
    motion = float(np.mean([np.abs(np.diff(frames[i].astype(np.float32), axis=0)).mean()
                            for i in range(0, min(len(frames) - 1, 60), 3)]))
    peak, rms = audio_stats(full) if spec.get("audio", True) else (None, None)
    return {
        "name": spec.get("name"),
        "frames": int(len(frames)),
        "face_coverage": round(len(faces) / max(1, len(range(0, len(frames), 4))), 3),
        "face_w_max": round(max(widths), 3) if widths else 0.0,
        "face_w_med": round(float(np.median(widths)), 3) if widths else 0.0,
        "motion": round(motion, 2),
        "audio_peak_db": peak,
        "audio_rms_db": rms,
        "face_hist": np.mean(faces, axis=0).tolist() if faces else None,
        "bg_hist": bg_hist(frames[len(frames) // 2]).tolist(),
        "first": frames[0], "last": frames[-1],
    }


def main(manifest_path):
    mf = json.load(open(manifest_path))
    out = {}
    for gname, g in mf["groups"].items():
        shots = []
        for spec in g["shots"]:
            r = analyze_shot(spec)
            if r:
                shots.append(r)
        # 组内跨镜一致性
        face_sims = []
        bg_sims = []
        for a, b in zip(shots, shots[1:]):
            fa = np.array(a["face_hist"]) if a["face_hist"] else None
            fb = np.array(b["face_hist"]) if b["face_hist"] else None
            s = cos(fa, fb)
            if s is not None:
                face_sims.append(round(s, 3))
            bg_sims.append(round(cos(np.array(a["bg_hist"]), np.array(b["bg_hist"])), 3))
        cuts = [round(float(np.abs(a["last"].astype(np.float32) - b["first"].astype(np.float32)).mean()), 1)
                for a, b in zip(shots, shots[1:])]
        # 首尾帧是否同一画面（链式组内部应更低）
        out[gname] = {
            "shot_count": len(shots),
            "face_coverage_mean": round(float(np.mean([s["face_coverage"] for s in shots])), 3),
            "face_w_max_mean": round(float(np.mean([s["face_w_max"] for s in shots])), 3),
            "motion_mean": round(float(np.mean([s["motion"] for s in shots])), 2),
            "audio_peak_mean": round(float(np.mean([s["audio_peak_db"] or -99 for s in shots])), 1),
            "face_sim_between_shots": round(float(np.mean(face_sims)), 3) if face_sims else None,
            "bg_sim_between_shots": round(float(np.mean(bg_sims)), 3) if bg_sims else None,
            "cut_diff_mean": round(float(np.mean(cuts)), 1) if cuts else None,
            "shots": [{k: v for k, v in s.items() if k not in ("face_hist", "bg_hist", "first", "last")} for s in shots],
        }
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
