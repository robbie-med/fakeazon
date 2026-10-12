"""Regenerate icons/icon-*.png: navy tile, white "f", orange Amazon-ish smile."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")
N = 512
FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
         "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"]

img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, N - 1, N - 1], radius=110, fill="#131921")
font = next((ImageFont.truetype(f, 360) for f in FONTS if os.path.exists(f)), ImageFont.load_default())
d.text((N / 2, N * 0.43), "f", font=font, fill="white", anchor="mm")
# smile + arrowhead
d.arc([96, 250, 416, 430], start=20, end=160, fill="#ff9900", width=34)
d.polygon([(372, 392), (432, 352), (420, 420)], fill="#ff9900")

os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 96, 128):
    img.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f"icon-{s}.png"))
print("icons written to", os.path.normpath(OUT))
