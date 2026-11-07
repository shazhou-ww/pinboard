"""Independent FreeType glyph references; uses only the bundled licensed font.

Regenerate with Python 3 and Pillow 11.1.0. Runtime tests consume the JSON and
do not require Python, Pillow, system fonts or network access.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
font = ImageFont.truetype(str(root / "assets" / "DroidSansFallbackFull.ttf"), 60)
result = {}
for char in "你好世界中文預覽":
    image = Image.new("L", (100, 100), 0)
    ImageDraw.Draw(image).text((10, 80), char, font=font, fill=255, anchor="ls")
    image = image.point(lambda value: 255 if value >= 128 else 0)
    image = image.crop(image.getbbox()).resize((32, 32), Image.Resampling.NEAREST)
    result[char] = "".join("1" if value else "0" for value in image.getdata())
(root / "test" / "fixtures" / "pdf-glyph-reference.json").write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
