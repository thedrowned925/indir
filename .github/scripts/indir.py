#!/usr/bin/env python3
"""indir worker: bir GitHub issue'sundaki isteği okur, yt-dlp ile indirir,
dosyaları bir GitHub Release'e yükler ve sonucu issue'ya yorum olarak yazar.

İstek, issue gövdesindeki ```json ... ``` bloğundan okunur. Kullanıcı girdisi
asla kabuğa (shell) verilmez; her şey doğrulanır ve argüman listesi olarak
subprocess'e geçirilir.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = os.environ.get("GITHUB_REPOSITORY", "")
RUN_URL = "{}/{}/actions/runs/{}".format(
    os.environ.get("GITHUB_SERVER_URL", "https://github.com"), REPO, os.environ.get("GITHUB_RUN_ID", "")
)
WORK = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "indir"
OUT = WORK / "out"
COOKIES = WORK / "cookies.txt"

# GitHub Release varlıkları en fazla 2 GiB olabilir; biraz altında böl.
MAX_ASSET = 1_990_000_000
MAX_COMMENT = 60_000

VIDEO_HEIGHTS = {"best", "4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"}
VIDEO_CONTAINERS = {"mp4", "mkv", "webm", "mov"}
VIDEO_CODECS = {"any", "compat", "h264", "h265", "vp9", "av1"}
VIDEO_FPS = {"any", "60", "30"}
AUDIO_FORMATS = {"best", "mp3", "m4a", "aac", "opus", "vorbis", "flac", "wav", "alac"}
LOSSLESS = {"flac", "wav", "alac"}
AUDIO_QUALITIES = {"0", "2", "5", "7", "9", "320K", "256K", "192K", "160K", "128K", "96K", "64K"}
SAMPLE_RATES = {"orig", "22050", "44100", "48000", "88200", "96000", "192000"}
BIT_DEPTHS = {"orig", "16", "24", "32"}
CHANNELS = {"orig", "2", "1"}
THUMB_OK_VIDEO = {"mp4", "mkv", "mov"}
THUMB_OK_AUDIO = {"mp3", "m4a", "opus", "vorbis", "flac", "alac", "best"}
SPONSOR_CATS = {"sponsor", "intro", "outro", "selfpromo", "preview", "filler", "interaction", "music_offtopic"}

TIME_RE = re.compile(r"^\d{1,3}(:\d{1,2}){0,2}(\.\d+)?$")
FORMAT_RE = re.compile(r"^[A-Za-z0-9_\-+/\[\]=<>!.*:,^$~ ]{1,200}$")
ITEMS_RE = re.compile(r"^[0-9,:\-]{1,50}$")
LANGS_RE = re.compile(r"^[A-Za-z0-9_\-.,*!]{1,100}$")


class UserError(Exception):
    pass


# ----------------------------------------------------------------- GitHub ----

def gh(*args, check=True, capture=True):
    return subprocess.run(["gh", *args], check=check, text=True, capture_output=capture)


def comment(issue, body):
    if len(body) > MAX_COMMENT:
        body = body[:MAX_COMMENT] + "\n\n…(kısaltıldı)"
    gh("issue", "comment", str(issue), "--repo", REPO, "--body", body)


def close(issue, reason="completed"):
    gh("issue", "close", str(issue), "--repo", REPO, "--reason", reason, check=False)


def json_comment(tag, data, text):
    return "<!-- indir:{} -->\n{}\n\n<details><summary>veri</summary>\n\n```json\n{}\n```\n</details>".format(
        tag, text, json.dumps(data, ensure_ascii=False)
    )


# ---------------------------------------------------------------- İstek -----

def load_request():
    """Olay dosyasından (issue) isteği ve issue numarasını döndürür."""
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    issue = event["issue"]
    body = issue.get("body") or ""
    m = re.search(r"```json\s*(\{.*?\})\s*```", body, re.S)
    if not m:
        raise UserError("Issue gövdesinde ```json``` bloğu bulunamadı.")
    try:
        req = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise UserError("İstek JSON'u okunamadı: {}".format(e))
    if not isinstance(req, dict):
        raise UserError("İstek bir JSON nesnesi olmalı.")
    return issue["number"], issue["user"]["login"], req


def allowed(login):
    raw = os.environ.get("INDIR_ALLOWED", "").strip()
    owner = REPO.split("/")[0]
    if raw == "*":
        return True
    users = {u.strip().lower() for u in raw.split(",") if u.strip()} | {owner.lower()}
    return login.lower() in users


def pick(req, key, choices, default):
    val = str(req.get(key, default))
    if val not in choices:
        raise UserError("Geçersiz `{}` değeri: {}".format(key, val))
    return val


def flag(req, key):
    return bool(req.get(key, False))


def valid_url(url):
    if not isinstance(url, str) or not re.match(r"^https?://\S+$", url) or len(url) > 2000:
        raise UserError("Geçerli bir http(s) bağlantısı girin.")
    return url


def build_args(req):
    """İstekten yt-dlp argüman listesini üretir."""
    mode = pick(req, "mode", {"video", "audio"}, "video")
    url = valid_url(req.get("url"))

    args = [
        "--newline", "--no-mtime", "--restrict-filenames", "--no-overwrites",
        "--paths", str(OUT),
        "-o", "%(title).90B-%(id)s.%(ext)s",
        "--retries", "10", "--fragment-retries", "10",
        "--concurrent-fragments", "4",
    ]
    if COOKIES.exists():
        args += ["--cookies", str(COOKIES)]

    # Oynatma listesi
    if flag(req, "playlist"):
        items = str(req.get("playlist_items", "") or "1:25")
        if not ITEMS_RE.match(items):
            raise UserError("Geçersiz oynatma listesi aralığı.")
        args += ["--yes-playlist", "--playlist-items", items]
    else:
        args += ["--no-playlist"]

    # Zaman aralığı (kırpma)
    start, end = str(req.get("start", "") or ""), str(req.get("end", "") or "")
    if start or end:
        for t in (start, end):
            if t and not TIME_RE.match(t):
                raise UserError("Zaman biçimi SS:DD:ss olmalı: {}".format(t))
        args += ["--download-sections", "*{}-{}".format(start or "0", end or "inf")]
        if flag(req, "precise_cut"):
            args += ["--force-keyframes-at-cuts"]

    # SponsorBlock
    cats = req.get("sponsorblock") or []
    if cats:
        if not isinstance(cats, list) or not set(cats) <= SPONSOR_CATS:
            raise UserError("Geçersiz SponsorBlock kategorisi.")
        args += ["--sponsorblock-remove", ",".join(cats)]

    if flag(req, "metadata"):
        args += ["--embed-metadata"]
    if flag(req, "chapters"):
        args += ["--embed-chapters"]

    ffmpeg_out = []
    if mode == "video":
        height = pick(req, "quality", VIDEO_HEIGHTS, "best")
        container = pick(req, "container", VIDEO_CONTAINERS, "mp4")
        codec = pick(req, "vcodec", VIDEO_CODECS, "any")
        fps = pick(req, "fps", VIDEO_FPS, "any")
        fmt = str(req.get("format_id", "") or "").strip()

        if fmt:
            if not FORMAT_RE.match(fmt):
                raise UserError("Geçersiz format kimliği.")
            args += ["-f", fmt]
        else:
            args += ["-f", "bv*+ba/b"]
            sort = []
            if height != "best":
                sort.append("res:" + height)
            if fps != "any":
                sort.append("fps:" + fps)
            codec_sort = {
                "compat": ["vcodec:h264", "acodec:aac"],
                "h264": ["vcodec:h264"],
                "h265": ["vcodec:h265"],
                "vp9": ["vcodec:vp9"],
                "av1": ["vcodec:av01"],
            }.get(codec, [])
            sort += codec_sort
            if container == "webm" and codec == "any":
                sort.append("ext:webm")
            if sort:
                args += ["-S", ",".join(sort)]

        args += ["--merge-output-format", container]
        if container == "webm":
            # Kaynakta WebM uyumlu akış yoksa VP9/Opus'a yeniden kodla.
            args += ["--recode-video", "webm"]
        else:
            args += ["--remux-video", container]

        if flag(req, "subs"):
            langs = str(req.get("sub_langs", "") or "tr.*,en.*")
            if not LANGS_RE.match(langs):
                raise UserError("Geçersiz altyazı dili listesi.")
            args += ["--write-subs", "--sub-langs", langs]
            if flag(req, "auto_subs"):
                args += ["--write-auto-subs"]
            if container == "webm":
                args += ["--convert-subs", "vtt"]
            args += ["--embed-subs"] if flag(req, "embed_subs") else ["--convert-subs", "srt"]
        if flag(req, "thumbnail") and container in THUMB_OK_VIDEO:
            args += ["--embed-thumbnail"]

    else:  # audio
        afmt = pick(req, "audio_format", AUDIO_FORMATS, "mp3")
        aq = pick(req, "audio_quality", AUDIO_QUALITIES, "0")
        sr = pick(req, "sample_rate", SAMPLE_RATES, "orig")
        bd = pick(req, "bit_depth", BIT_DEPTHS, "orig")
        ch = pick(req, "channels", CHANNELS, "orig")

        args += ["-f", "ba/b", "-x", "--audio-format", afmt]
        if afmt not in LOSSLESS and afmt != "best":
            args += ["--audio-quality", aq]
        if sr != "orig":
            ffmpeg_out += ["-ar", sr]
        if ch != "orig":
            ffmpeg_out += ["-ac", ch]
        if afmt == "alac":
            # yt-dlp, m4a kaynağında ALAC yerine AAC'yi koruyabiliyor; codec'i zorla.
            ffmpeg_out += ["-c:a", "alac"]
        if bd != "orig" and afmt in LOSSLESS:
            if afmt == "wav":
                ffmpeg_out += ["-c:a", {"16": "pcm_s16le", "24": "pcm_s24le", "32": "pcm_s32le"}[bd]]
            elif afmt == "flac":
                ffmpeg_out += ["-sample_fmt", "s16" if bd == "16" else "s32"]
                if bd == "24":
                    ffmpeg_out += ["-bits_per_raw_sample", "24"]
            elif afmt == "alac":
                ffmpeg_out += ["-sample_fmt", "s16p" if bd == "16" else "s32p"]
                if bd == "24":
                    ffmpeg_out += ["-bits_per_raw_sample", "24"]
        if flag(req, "thumbnail") and afmt in THUMB_OK_AUDIO:
            args += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]

    if ffmpeg_out:
        args += ["--postprocessor-args", "ExtractAudio+ffmpeg_o:" + shlex.join(ffmpeg_out)]

    return mode, url, args + ["--", url]


# --------------------------------------------------------------- Çalıştır ---

def run_ytdlp(args):
    cmd = [sys.executable, "-m", "yt_dlp", *args]
    print("+ " + subprocess.list2cmdline(cmd), flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail = []
    for line in proc.stdout:
        print(line, end="", flush=True)
        tail.append(line.rstrip())
        tail = tail[-40:]
    return proc.wait(), tail


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "{:.1f} {}".format(n, unit) if unit != "B" else "{} B".format(n)
        n /= 1024


def info(issue, url, req):
    """Formatları listeler ve yorum olarak yazar."""
    args = ["-J", "--no-playlist", "--no-warnings"]
    if COOKIES.exists():
        args += ["--cookies", str(COOKIES)]
    proc = subprocess.run([sys.executable, "-m", "yt_dlp", *args, "--", url], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-3000:])
    data = json.loads(proc.stdout)
    formats = []
    for f in data.get("formats") or []:
        if f.get("format_note") == "storyboard" or f.get("vcodec") == "none" and f.get("acodec") == "none":
            continue
        formats.append({
            "id": f.get("format_id"),
            "ext": f.get("ext"),
            "res": f.get("resolution") or ("ses" if f.get("vcodec") == "none" else None),
            "h": f.get("height"),
            "fps": f.get("fps"),
            "vc": None if f.get("vcodec") in (None, "none") else f.get("vcodec"),
            "ac": None if f.get("acodec") in (None, "none") else f.get("acodec"),
            "abr": round(f["abr"]) if f.get("abr") else None,
            "tbr": round(f["tbr"]) if f.get("tbr") else None,
            "asr": f.get("asr"),
            "size": f.get("filesize") or f.get("filesize_approx"),
            "note": f.get("format_note"),
            "dr": f.get("dynamic_range"),
            "lang": f.get("language"),
        })
    payload = {
        "title": data.get("title"),
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "extractor": data.get("extractor_key"),
        "formats": formats[-200:],
    }
    text = "### ℹ️ {}\n{} format bulundu. Siteye dönüp istediğin formatı seçebilirsin.".format(
        payload["title"] or "Video", len(payload["formats"])
    )
    body = json_comment("info", payload, text)
    while len(body) > MAX_COMMENT and payload["formats"]:
        payload["formats"] = payload["formats"][10:]
        body = json_comment("info", payload, text)
    comment(issue, body)


def split_big(path):
    """2 GiB'den büyük dosyaları parçalara böler."""
    size = path.stat().st_size
    if size <= MAX_ASSET:
        return [path]
    parts = []
    with path.open("rb") as src:
        i = 1
        while True:
            chunk_path = path.with_name("{}.{:03d}".format(path.name, i))
            written = 0
            with chunk_path.open("wb") as dst:
                while written < MAX_ASSET:
                    buf = src.read(min(64 * 1024 * 1024, MAX_ASSET - written))
                    if not buf:
                        break
                    dst.write(buf)
                    written += len(buf)
            if written == 0:
                chunk_path.unlink()
                break
            parts.append(chunk_path)
            i += 1
    path.unlink()
    return parts


def upload(issue, files, title):
    tag = "indir-{}".format(issue)
    gh("release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag", check=False)
    gh("release", "create", tag, "--repo", REPO, "--title", "indir #{} — {}".format(issue, title)[:120],
       "--notes", "İstek: #{}\nOtomatik oluşturuldu; temizlik iş akışı eski sürümleri siler.".format(issue),
       "--prerelease", "--latest=false")
    for f in files:
        for attempt in range(4):
            r = gh("release", "upload", tag, str(f), "--repo", REPO, "--clobber", check=False)
            if r.returncode == 0:
                break
            print(r.stderr, file=sys.stderr)
            time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError("Yükleme başarısız: {}".format(f.name))
    data = json.loads(gh("release", "view", tag, "--repo", REPO, "--json", "assets,url").stdout)
    return data["url"], [
        {"name": a["name"], "size": a["size"], "url": a["url"]} for a in data["assets"]
    ]


def main():
    issue, login, req = None, None, None
    try:
        issue, login, req = load_request()
    except UserError as e:
        print(e, file=sys.stderr)
        return 1

    if not allowed(login):
        comment(issue, "⛔ @{} bu depoda indirme yapma iznine sahip değil.".format(login))
        close(issue, "not planned")
        return 0

    try:
        mode = req.get("mode", "video")
        if mode == "info":
            info(issue, valid_url(req.get("url")), req)
            close(issue)
            return 0

        mode, url, args = build_args(req)
        comment(issue, "<!-- indir:status -->\n⏳ İndirme başladı… [İş akışını izle]({})".format(RUN_URL))

        OUT.mkdir(parents=True, exist_ok=True)
        code, tail = run_ytdlp(args)
        files = sorted(p for p in OUT.rglob("*") if p.is_file() and not p.name.endswith((".part", ".ytdl")))
        if code != 0 and not files:
            raise RuntimeError("\n".join(tail))

        final = []
        for f in files:
            # gh, adı glob deseni gibi yorumlar; özel karakterleri temizle.
            safe = f.with_name(re.sub(r"[\[\]*?#,{}]", "", f.name) or "dosya")
            if safe != f:
                f = f.rename(safe)
            final += split_big(f)
        if not final:
            raise RuntimeError("Hiç dosya üretilmedi.\n" + "\n".join(tail))

        title = files[0].stem
        release_url, assets = upload(issue, final, title)
        lines = ["### ✅ Hazır!", ""]
        for a in assets:
            lines.append("- [{}]({}) — {}".format(a["name"], a["url"], fmt_size(a["size"])))
        if any(re.search(r"\.\d{3}$", a["name"]) for a in assets):
            lines += ["", "Büyük dosya parçalara bölündü. Birleştirmek için: "
                      "`cat dosya.001 dosya.002 > dosya` (Windows: `copy /b dosya.001+dosya.002 dosya`)"]
        if code != 0:
            lines += ["", "⚠️ yt-dlp bazı öğelerde hata verdi; indirilebilenler yukarıda."]
        comment(issue, json_comment("result", {"release": release_url, "files": assets, "partial": code != 0},
                                    "\n".join(lines)))
        close(issue)
        return 0

    except UserError as e:
        comment(issue, json_comment("error", {"message": str(e)}, "### ❌ Hata\n" + str(e)))
        close(issue, "not planned")
        return 0
    except Exception as e:  # noqa: BLE001
        msg = str(e).strip()[-3500:]
        hint = ""
        if "Sign in to confirm" in msg or "not a bot" in msg:
            hint = ("\n\n💡 Site, GitHub sunucularını bot sanıyor. Depo ayarlarında `YTDLP_COOKIES` "
                    "secret'ına tarayıcı çerezlerini (Netscape formatı) ekleyin — README'ye bakın.")
        comment(issue, json_comment(
            "error", {"message": msg[-800:], "run": RUN_URL},
            "### ❌ İndirme başarısız\n```\n{}\n```{}\n\n[Günlük]({})".format(msg, hint, RUN_URL)))
        close(issue, "not planned")
        return 1
    finally:
        shutil.rmtree(OUT, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
