#!/usr/bin/env python3
"""
Generate logo/icon assets from resources/cow.png

Outputs:
  - resources/icon.png          (1024x1024, app icon for Linux + source)
  - resources/icon.ico          (multi-size Windows icon)
  - resources/icon.icns         (macOS iconset)
  - resources/icon.iconset/*    (individual sizes for icns)
  - src/renderer/assets/logo.png (sidebar + welcome page logo)
  - public/favicon.png          (32x32 browser favicon)
  - resources/tray-icon.png     (32x32 colored tray icon)
  - resources/tray-iconTemplate.png (32x32 white silhouette for macOS template)

Strategy:
  1. Load cow.png, find alpha bbox to trim transparent edges
  2. Crop to a tight square around the cow's head/upper body
  3. Scale to target sizes with high-quality Lanczos resampling
  4. Preserve transparency (RGBA) for all outputs
"""

import os
import sys
import struct
import subprocess
from pathlib import Path

# Try Pillow first, fallback to bundled
from PIL import Image, ImageFilter, ImageEnhance

# ── Paths ──────────────────────────────────────────────────────────
BASE = Path(__file__).resolve().parent.parent
SRC = BASE / "resources" / "cow.png"

OUT_ICON_PNG = BASE / "resources" / "icon.png"
OUT_ICON_ICO = BASE / "resources" / "icon.ico"
OUT_ICON_ICNS = BASE / "resources" / "icon.icns"
OUT_ICONSET_DIR = BASE / "resources" / "icon.iconset"
OUT_LOGO = BASE / "src" / "renderer" / "assets" / "logo.png"
OUT_FAVICON = BASE / "public" / "favicon.png"
OUT_TRAY = BASE / "resources" / "tray-icon.png"
OUT_TRAY_TEMPLATE = BASE / "resources" / "tray-iconTemplate.png"

# ── Config ─────────────────────────────────────────────────────────
# Padding ratio around the cow after trim (0 = no padding, 0.05 = 5%)
PADDING_RATIO = 0.02

# For the logo, we want a slightly tighter crop focusing on head/upper body
LOGO_CROP_TOP_RATIO = 0.00    # crop from top (0 = no crop)
LOGO_CROP_BOTTOM_RATIO = 0.15  # crop from bottom (remove some legs for tighter composition)

# For favicon and tray, focus even more on the head
ICON_CROP_TOP_RATIO = 0.00
ICON_CROP_BOTTOM_RATIO = 0.25   # more aggressive bottom crop for small icons

# Icon sizes for .ico (Windows) and .iconset (macOS)
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICONSET_SIZES = [
    (16, 16), (16, 16 * 2),      # 16x16, 16x16@2x
    (32, 32), (32, 32 * 2),      # 32x32, 32x32@2x
    (128, 128), (128, 128 * 2),  # 128x128, 128x128@2x
    (256, 256), (256, 256 * 2),  # 256x256, 256x256@2x
    (512, 512), (512, 512 * 2),  # 512x512, 512x512@2x
]

# ── Helpers ────────────────────────────────────────────────────────

def find_alpha_bbox(img: Image.Image) -> tuple:
    """Find bounding box of non-transparent pixels."""
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    alpha = img.split()[-1]
    bbox = alpha.getbbox()
    return bbox  # (left, upper, right, lower)


def crop_to_square(img: Image.Image, crop_top_ratio=0.0, crop_bottom_ratio=0.0) -> Image.Image:
    """
    Crop image to a square, centering the subject.
    Optionally crop from top/bottom first (ratios of current height).
    """
    w, h = img.size

    # First apply top/bottom crop
    if crop_top_ratio > 0 or crop_bottom_ratio > 0:
        top_crop = int(h * crop_top_ratio)
        bottom_crop = int(h * crop_bottom_ratio)
        img = img.crop((0, top_crop, w, h - bottom_crop))
        w, h = img.size

    # Now make square
    if w == h:
        return img

    if w > h:
        # Landscape: crop left/right
        diff = w - h
        left = diff // 2
        right = left + h
        return img.crop((left, 0, right, h))
    else:
        # Portrait: crop top/bottom
        diff = h - w
        top = diff // 2
        bottom = top + w
        return img.crop((0, top, w, bottom))


def add_padding(img: Image.Image, ratio: float) -> Image.Image:
    """Add transparent padding around the image."""
    w, h = img.size
    pad = int(max(w, h) * ratio)
    new_w, new_h = w + pad * 2, h + pad * 2
    new_img = Image.new('RGBA', (new_w, new_h), (0, 0, 0, 0))
    new_img.paste(img, (pad, pad))
    return new_img


def make_tray_template(img: Image.Image, size: int = 32) -> Image.Image:
    """
    Create a macOS template tray icon: white silhouette on transparent background.
    """
    # Resize first
    img = img.resize((size, size), Image.LANCZOS)

    # Convert to grayscale
    gray = img.convert('L')

    # Create white version with original alpha
    r, g, b, a = img.split()

    # Use the grayscale as a mask to create white silhouette
    white = Image.new('RGBA', (size, size), (255, 255, 255, 0))

    # Where the original image is visible, make it white
    # We'll use the alpha channel to determine visibility
    white_data = white.load()
    gray_data = gray.load()
    alpha_data = a.load()

    for y in range(size):
        for x in range(size):
            if alpha_data[x, y] > 30:  # threshold for visibility
                # Use grayscale value to modulate alpha (darker = more opaque)
                opacity = gray_data[x, y]
                white_data[x, y] = (255, 255, 255, opacity)

    return white


def make_tray_icon(img: Image.Image, size: int = 32) -> Image.Image:
    """Create a colored tray icon, simplified for small size."""
    img = img.resize((size, size), Image.LANCZOS)
    return img


def save_icns(iconset_dir: Path, output_path: Path):
    """Use macOS iconutil to create .icns from iconset directory."""
    if sys.platform == 'darwin':
        subprocess.run(['iconutil', '-c', 'icns', str(iconset_dir)], check=True)
    else:
        # On non-macOS, we can't easily create .icns
        # Just copy the largest PNG as a fallback
        largest = iconset_dir / "icon_512x512@2x.png"
        if largest.exists():
            import shutil
            shutil.copy(largest, output_path)
            print(f"  [fallback] copied {largest.name} -> {output_path}")


def create_ico(images: list, output_path: Path):
    """
    Create a multi-size Windows .ico file manually.
    Pillow's ICO writer has bugs on Windows where it only writes the first image.
    We build the ICO header + directory + image data ourselves.
    Each image is saved as PNG (better quality, supports alpha) inside the ICO.
    """
    # ICO header: Reserved(2) + Type(2) + Count(2)
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)

    # Each image needs: Width(1) + Height(1) + Colors(1) + Reserved(1)
    #                   + Planes(2) + BitCount(2) + SizeInBytes(4) + Offset(4)
    # For PNG-in-ICO, Width/Height can be 0 when >= 256
    directory = b''
    image_data = b''
    offset = 6 + 16 * count  # header size + directory size

    for img in images:
        # Save image as PNG bytes
        import io
        buf = io.BytesIO()
        # Convert to RGBA for consistent output
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        img.save(buf, format='PNG')
        png_bytes = buf.getvalue()
        size_bytes = len(png_bytes)

        w, h = img.size
        # ICO directory entry
        # Width and height are stored as 1-byte values, 0 means 256
        width_byte = w if w < 256 else 0
        height_byte = h if h < 256 else 0
        directory += struct.pack(
            '<BBBBHHII',
            width_byte,      # Width
            height_byte,     # Height
            0,               # Color count (0 = >256 colors)
            0,               # Reserved
            1,               # Color planes
            32,              # Bits per pixel
            size_bytes,      # Size of image data in bytes
            offset           # Offset to image data
        )
        image_data += png_bytes
        offset += size_bytes

    with open(output_path, 'wb') as f:
        f.write(header)
        f.write(directory)
        f.write(image_data)

    # Verify
    with open(output_path, 'rb') as f:
        data = f.read()
        _, _, img_count = struct.unpack('<HHH', data[:6])
        print(f"    Verified: {img_count} images in ICO, total size {len(data) // 1024} KB")


# ── Main ───────────────────────────────────────────────────────────

def main():
    print(f"Loading source: {SRC}")
    if not SRC.exists():
        print(f"ERROR: Source image not found: {SRC}")
        sys.exit(1)

    img = Image.open(SRC)
    print(f"  Original size: {img.size}, mode: {img.mode}")

    # Convert to RGBA if needed
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    # Step 1: Trim transparent edges
    bbox = find_alpha_bbox(img)
    if bbox:
        img = img.crop(bbox)
        print(f"  Trimmed to: {img.size}")
    else:
        print("  No transparent edges to trim")

    # Step 2: Add small padding for breathing room
    img_padded = add_padding(img, PADDING_RATIO)
    print(f"  With padding: {img_padded.size}")

    # ── Generate main app icon (1024x1024) ─────────────────────────
    print("\n[1] Generating app icon (1024x1024)...")
    icon_square = crop_to_square(img_padded, ICON_CROP_TOP_RATIO, ICON_CROP_BOTTOM_RATIO)
    icon_1024 = icon_square.resize((1024, 1024), Image.LANCZOS)
    icon_1024.save(OUT_ICON_PNG, 'PNG')
    print(f"  -> {OUT_ICON_PNG}")

    # ── Generate logo for UI (512x512, less aggressive crop) ──────
    print("\n[2] Generating UI logo (512x512)...")
    logo_square = crop_to_square(img_padded, LOGO_CROP_TOP_RATIO, LOGO_CROP_BOTTOM_RATIO)
    logo_512 = logo_square.resize((512, 512), Image.LANCZOS)
    logo_512.save(OUT_LOGO, 'PNG')
    print(f"  -> {OUT_LOGO}")

    # ── Generate favicon (32x32) ──────────────────────────────────
    print("\n[3] Generating favicon (32x32)...")
    favicon = icon_square.resize((32, 32), Image.LANCZOS)
    favicon.save(OUT_FAVICON, 'PNG')
    print(f"  -> {OUT_FAVICON}")

    # ── Generate tray icons ───────────────────────────────────────
    print("\n[4] Generating tray icons (32x32)...")
    tray = make_tray_icon(icon_square, 32)
    tray.save(OUT_TRAY, 'PNG')
    print(f"  -> {OUT_TRAY}")

    tray_template = make_tray_template(icon_square, 32)
    tray_template.save(OUT_TRAY_TEMPLATE, 'PNG')
    print(f"  -> {OUT_TRAY_TEMPLATE}")

    # ── Generate Windows .ico ─────────────────────────────────────
    print("\n[5] Generating Windows .ico...")
    ico_images = []
    for size in ICO_SIZES:
        ico_img = icon_square.resize((size, size), Image.LANCZOS)
        ico_images.append(ico_img)
    create_ico(ico_images, OUT_ICON_ICO)
    print(f"  -> {OUT_ICON_ICO}")

    # ── Generate macOS .iconset ───────────────────────────────────
    print("\n[6] Generating macOS iconset...")
    OUT_ICONSET_DIR.mkdir(exist_ok=True)

    # Clean old files
    for old in OUT_ICONSET_DIR.glob("*.png"):
        old.unlink()

    for base_size, px_size in ICONSET_SIZES:
        if px_size == base_size * 2:
            name = f"icon_{base_size}x{base_size}@2x.png"
        else:
            name = f"icon_{base_size}x{base_size}.png"

        iconset_img = icon_square.resize((px_size, px_size), Image.LANCZOS)
        iconset_img.save(OUT_ICONSET_DIR / name, 'PNG')
        print(f"  -> {name}")

    # Try to create .icns
    print(f"\n[7] Generating .icns...")
    try:
        save_icns(OUT_ICONSET_DIR, OUT_ICON_ICNS)
        print(f"  -> {OUT_ICON_ICNS}")
    except Exception as e:
        print(f"  WARNING: Could not create .icns: {e}")
        print(f"  (iconset files are ready, use macOS iconutil to create .icns)")

    print("\n✅ All assets generated successfully!")
    print(f"\nSummary:")
    print(f"  App icon:     {OUT_ICON_PNG} ({OUT_ICON_PNG.stat().st_size // 1024} KB)")
    print(f"  Windows ico:  {OUT_ICON_ICO} ({OUT_ICON_ICO.stat().st_size // 1024} KB)")
    print(f"  macOS icns:   {OUT_ICON_ICNS} ({OUT_ICON_ICNS.stat().st_size // 1024} KB)")
    print(f"  UI logo:      {OUT_LOGO} ({OUT_LOGO.stat().st_size // 1024} KB)")
    print(f"  Favicon:      {OUT_FAVICON} ({OUT_FAVICON.stat().st_size // 1024} KB)")
    print(f"  Tray icon:    {OUT_TRAY} ({OUT_TRAY.stat().st_size // 1024} KB)")
    print(f"  Tray template:{OUT_TRAY_TEMPLATE} ({OUT_TRAY_TEMPLATE.stat().st_size // 1024} KB)")


if __name__ == '__main__':
    main()
