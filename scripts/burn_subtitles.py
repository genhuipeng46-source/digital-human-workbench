#!/usr/bin/env python3
import argparse
import os
import re
import shutil
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"

FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def pick_font(size: int):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def parse_srt_time(ts: str) -> float:
    h, m, s_ms = ts.strip().split(":")
    s, ms = s_ms.replace(".", ",").split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_srt(srt_path: str):
    with open(srt_path, "r", encoding="utf-8") as f:
        raw = f.read()
    blocks = re.split(r"\r?\n\r?\n+", raw.strip())
    cues = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        time_line = lines[1] if "-->" in lines[1] else lines[0]
        if "-->" not in time_line:
            continue
        start_str, end_str = time_line.split("-->")
        text_lines = lines[2:] if "-->" in lines[1] else lines[1:]
        text = " ".join(text_lines).strip()
        if not text:
            continue
        cues.append((parse_srt_time(start_str), parse_srt_time(end_str), text))
    return cues


def probe_video_size(video_path: str):
    out = subprocess.check_output([
        FFPROBE, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0",
        video_path,
    ], text=True).strip()
    m = re.search(r"(\d+)\s*x\s*(\d+)", out)
    if not m:
        return 1080, 1920
    return int(m.group(1)), int(m.group(2))


def hex_to_rgba(hex_color: str, alpha: int = 255):
    c = hex_color.strip().lstrip("#")
    if len(c) != 6:
        c = "FFD800"
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha)


def render_cue_png(text: str, width: int, height: int, color_hex: str, out_path: str):
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font_size = max(28, int(min(width, height) * 0.056))
    font = pick_font(font_size)
    stroke_w = max(3, int(font_size * 0.12))

    # 自动换行（超过画面宽度的 86% 时拆成两行）
    max_w = int(width * 0.86)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_w)
    if bbox[2] - bbox[0] > max_w and len(text) > 8:
        mid = len(text) // 2
        lines = [text[:mid], text[mid:]]
    else:
        lines = [text]

    line_h = int(font_size * 1.32)
    total_h = line_h * len(lines)
    base_y = int(height * 0.77) - total_h // 2
    fill_rgba = hex_to_rgba(color_hex, 255)
    shadow_offset = max(2, int(font_size * 0.06))

    for i, line in enumerate(lines):
        lb = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
        tw = lb[2] - lb[0]
        x = (width - tw) // 2
        y = base_y + i * line_h
        # 阴影
        draw.text((x + shadow_offset, y + shadow_offset), line, font=font, fill=(0, 0, 0, 170), stroke_width=stroke_w, stroke_fill=(0, 0, 0, 170))
        # 主字 + 黑描边
        draw.text((x, y), line, font=font, fill=fill_rgba, stroke_width=stroke_w, stroke_fill=(0, 0, 0, 255))

    img.save(out_path, "PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--srt", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--color", default="#FFD800")
    parser.add_argument("--bgm", default="")
    args = parser.parse_args()

    cues = parse_srt(args.srt)
    if not cues:
        shutil.copyfile(args.video, args.out)
        return

    w, h = probe_video_size(args.video)
    tmp_dir = tempfile.mkdtemp(prefix="sub_png_")
    try:
        cmd = [FFMPEG, "-y", "-i", args.video]
        png_paths = []
        for idx, (st, et, txt) in enumerate(cues):
            p = os.path.join(tmp_dir, f"cue_{idx:04d}.png")
            render_cue_png(txt, w, h, args.color, p)
            png_paths.append((p, st, et))
            cmd.extend(["-i", p])

        has_bgm = bool(args.bgm and os.path.exists(args.bgm))
        bgm_idx = len(png_paths) + 1
        if has_bgm:
            cmd.extend(["-stream_loop", "-1", "-i", args.bgm])

        filters = []
        prev_v = "0:v"
        for idx, (_p, st, et) in enumerate(png_paths):
            in_idx = idx + 1
            out_v = f"v{idx}"
            filters.append(f"[{prev_v}][{in_idx}:v]overlay=0:0:enable='between(t,{st:.3f},{et:.3f})'[{out_v}]")
            prev_v = out_v

        if has_bgm:
            filters.append(f"[{bgm_idx}:a]volume=0.16[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]")
            audio_map = "[aout]"
        else:
            audio_map = "0:a?"

        cmd.extend([
            "-filter_complex", ";".join(filters),
            "-map", f"[{prev_v}]",
            "-map", audio_map,
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            args.out,
        ])

        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
