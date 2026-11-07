"""Refresh pinned, publicly licensed native dependency notices (not a build step)."""
import base64
import concurrent.futures
import hashlib
from pathlib import Path
import re
import urllib.request
import urllib.error
import time

root = Path(__file__).resolve().parent.parent
commit = "f91ca5a72358bb0b00b4da9481b21fe668157614"
base = f"https://pdfium.googlesource.com/pdfium/+/{commit}/"
cache = root / ".preview-assets" / "notices"
cache.mkdir(parents=True, exist_ok=True)


def text(url):
    try:
        path = cache / hashlib.sha256(url.encode()).hexdigest()
        if path.exists():
            return path.read_text(encoding="utf-8")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=30) as response:
                    data = response.read()
                break
            except urllib.error.HTTPError as error:
                if error.code != 429 or attempt == 3:
                    raise
                time.sleep(int(error.headers.get("Retry-After", 10 * (attempt + 1))))
        if url.endswith("?format=TEXT"):
            data = base64.b64decode(data)
        try:
            value = data.decode("utf-8")
        except UnicodeDecodeError:
            value = data.decode("latin-1")
        path.write_text(value, encoding="utf-8")
        return value
    except Exception as error:
        raise RuntimeError(url) from error


deps = text(base + "DEPS?format=TEXT")
revisions = dict(re.findall(r"'(\w+_revision)': '([a-f0-9]+)'", deps))
repositories = {}
for path, repo, revision in re.findall(
    r"'([^']+)':\s*(?:\{\s*'url':\s*)?Var\('chromium_git'\)\s*\+\s*'([^']+)@'\s*\+\s*Var\('([^']+)'\)", deps
):
    repositories[path] = f"https://chromium.googlesource.com{repo}/+/{revisions[revision]}/"


def source(path):
    for prefix in sorted(repositories, key=len, reverse=True):
        if path.startswith(prefix + "/"):
            return repositories[prefix] + path[len(prefix) + 1:] + "?format=TEXT"
    return base + path + "?format=TEXT"


paths = ["LICENSE"]
for name in [
    "agg23", "bigint", "freetype", "lcms", "libopenjpeg", "libtiff",
    "fast_float", "dragonbox", "fp16", "NotoSansCJK", "NotoSansBengali2",
    "NotoSansBengali3", "cpu_features", "harfbuzz", "highway",
]:
    directory = "third_party/" + name + "/"
    readme = text(base + directory + "README.pdfium?format=TEXT")
    licenses = re.search(r"^License File: (.+)$", readme, re.M).group(1).split(", ")
    paths.extend(directory + name for name in licenses)
paths.extend([
    "third_party/libjpeg_turbo/LICENSE.md", "third_party/libjpeg_turbo/README.ijg",
    "third_party/zlib/LICENSE", "third_party/icu/LICENSE",
    "third_party/abseil-cpp/LICENSE", "third_party/brotli/LICENSE",
])
urls = [source(path) for path in paths]
urls.extend([
    "https://raw.githubusercontent.com/emscripten-core/emscripten/6.0.0/LICENSE",
    "https://raw.githubusercontent.com/emscripten-core/emscripten/6.0.0/system/lib/libc/musl/COPYRIGHT",
])
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    texts = list(pool.map(text, urls))
notice = "\n\n".join(f"{url}\n{'=' * 72}\n{value.rstrip()}" for url, value in zip(urls, texts))
(root / "assets" / "PDFIUM-THIRD-PARTY.txt").write_text(notice + "\n", encoding="utf-8")
