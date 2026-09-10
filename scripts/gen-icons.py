#!/usr/bin/env python3
"""Mycard PWA 图标生成脚本（一次性开发工具）。

用法: python3 scripts/gen-icons.py
生成:
  icons/icon-192.png
  icons/icon-512.png
  icons/icon-maskable-512.png   （全出血背景，内容居中安全区内）
  icons/apple-touch-icon.png    （不透明，iOS 使用）
设计: 深蓝紫渐变背景 + 两张交叠圆角卡片 + “M” 字标（不用字体，全部矢量绘制）
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")

# 主画布 1024，绘制完成后等比缩放
BASE = 1024
SIZE_512 = 512
SIZE_192 = 192
SIZE_180 = 180

# 调色板
BG_TOP = (57, 73, 201)
BG_BOT = (11, 17, 43)
ACCENT_TOP = (143, 123, 255)
ACCENT_BOT = (91, 108, 255)
CARD_TOP = (255, 255, 255)
CARD_BOT = (222, 228, 255)
MONO = (74, 89, 208)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def vertical_gradient(w, h, c1, c2):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        col = lerp(c1, c2, t)
        for x in range(w):
            px[x, y] = col
    return img


def rounded_alpha(size, radius, full=False):
    """返回圆角矩形遮罩。full=True 时为不透明方形。"""
    if full:
        return Image.new("L", (size, size), 255)
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_card_layer(size, cx, cy, w, h, radius, rot, top, bot, mono_alpha=0):
    """把一张圆角渐变卡片（含可选 M 字标）绘制到 (cx, cy) 附近，旋转 rot 度。"""
    layer = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
    x0 = size - w // 2
    y0 = size - h // 2
    grad = vertical_gradient(w, h, top, bot).convert("RGBA")
    m = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(m)
    md.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    card.paste(grad, (0, 0), m)
    if mono_alpha:
        draw_mono(ImageDraw.Draw(card), w, h, mono_alpha)
    layer.paste(card, (x0, y0), card)
    layer = layer.rotate(rot, resample=Image.BICUBIC, center=(size, size))
    return layer, size + int(cx), size + int(cy)


def draw_mono(draw, w, h, alpha=1.0):
    """在卡片中部绘制 M 字标（四条笔划，无字体依赖）。"""
    col = MONO + (int(255 * alpha),)
    x0 = w * 0.30
    x1 = w * 0.70
    y0 = h * 0.26
    y1 = h * 0.74
    midx = (x0 + x1) / 2.0
    stroke = int(w * 0.075)
    draw.line([(x0, y0), (x0, y1)], fill=col, width=stroke)
    draw.line([(x0 + stroke, y1), (midx, h * 0.45)], fill=col, width=stroke)
    draw.line([(midx, h * 0.45), (x1 - stroke, y1)], fill=col, width=stroke)
    draw.line([(x1, y0), (x1, y1)], fill=col, width=stroke)
    draw.line([(x0, y0), (x1, y0)], fill=col, width=int(stroke * 1.15))


def sparkle(draw, x, y, r, color):
    pts = []
    for i in range(8):
        ang = math.pi * i / 4
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((x + rr * math.cos(ang), y + rr * math.sin(ang)))
    draw.polygon(pts, fill=color)
def render_canvas(maskable=False):
    """maskable=False: 四周留透明边+圆角；maskable=True: 全出血方形背景。"""
    s = BASE
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    # 1) 背景渐变
    bg = vertical_gradient(s, s, BG_TOP, BG_BOT).convert("RGBA")
    if maskable:
        canvas.paste(bg, (0, 0), Image.new("L", (s, s), 255))
    else:
        radius = int(s * 0.225)
        pad = int(s * 0.03)
        crop = bg.crop((0, 0, s - pad, s - pad))
        m = rounded_alpha(s - pad, int(radius * 0.97))
        crop.putalpha(m)
        canvas.alpha_composite(crop, (pad // 2, pad // 2))

    # 2) 顶部柔光
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([s * 0.02, -s * 0.28, s * 0.80, s * 0.42], fill=(143, 123, 255, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.16))
    canvas.alpha_composite(glow)

    d = ImageDraw.Draw(canvas)
    scale = 0.86 if maskable else 0.94
    cx0 = s / 2
    cy0 = s / 2 + s * 0.02

    # 3) 后层卡片（旋转，accent 渐变）
    w1, h1 = int(s * 0.52 * scale), int(s * 0.68 * scale)
    l1, x1, y1 = draw_card_layer(
        s, cx0 + s * 0.10 * scale, cy0 + s * 0.02, w1, h1,
        int(s * 0.05), -10, ACCENT_TOP, ACCENT_BOT, 0,
    )
    canvas.alpha_composite(l1, (x1 - s, y1 - s))

    # 4) 前层主卡片（白色，含 M）
    w2, h2 = int(s * 0.58 * scale), int(s * 0.74 * scale)
    l2, x2, y2 = draw_card_layer(
        s, cx0 - s * 0.09 * scale, cy0, w2, h2,
        int(s * 0.05), 6, CARD_TOP, CARD_BOT, 0.95,
    )
    canvas.alpha_composite(l2, (x2 - s, y2 - s))

    # 5) 点缀星光
    sparkle(d, s * 0.80, s * 0.12, int(s * 0.013), (255, 255, 255, 215))
    sparkle(d, s * 0.15, s * 0.86, int(s * 0.011), (143, 123, 255, 235))
    sparkle(d, s * 0.88, s * 0.84, int(s * 0.009), (255, 255, 255, 155))
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    canvas = render_canvas(maskable=False)

    canvas.resize((SIZE_512, SIZE_512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
    canvas.resize((SIZE_192, SIZE_192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))

    render_canvas(maskable=True).resize((SIZE_512, SIZE_512), Image.LANCZOS).save(
        os.path.join(OUT, "icon-maskable-512.png")
    )

    opaque = render_canvas(maskable=True).resize((SIZE_180, SIZE_180), Image.LANCZOS)
    opaque.convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))

    print("icons generated in", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
