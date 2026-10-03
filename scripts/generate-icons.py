"""Render the existing Roomly r. wordmark as opaque home-screen icons."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
scale = 4
size = 512 * scale
image = Image.new("RGB", (size, size), "#bfd4b6")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 320 * scale)
bounds = draw.textbbox((0, 0), "r.", font=font)
width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
draw.text(((size - width) / 2 - bounds[0], (size - height) / 2 - bounds[1]), "r.", font=font, fill="#1b3335")
for filename, target in [("icon-192.png", 192), ("icon-512.png", 512), ("icon-maskable-512.png", 512), ("apple-touch-icon.png", 180)]:
    image.resize((target, target), Image.Resampling.LANCZOS).save(root / filename)
print("Generated Roomly icons: 192, 512, maskable 512, Apple 180")
