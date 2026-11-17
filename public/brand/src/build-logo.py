"""Hand-built Express Help logo. Writes SVGs; the wordmark is outlined from Inter Bold (SIL OFL) so it renders identically everywhere."""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/logo/out"
os.makedirs(OUT, exist_ok=True)
NAVY, RED, WHITE = "#0B2559", "#E11D2E", "#FFFFFF"

font = TTFont("/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf")
font = instantiateVariableFont(font, {"wght": 700, "opsz": 28}, inplace=False)
gs = font.getGlyphSet(); cmap = font.getBestCmap(); upm = font["head"].unitsPerEm
hmtx = font["hmtx"]

def word_path(text, size, x0, baseline, tracking=-0.01):
    """SVG path data of `text` outlined at font size `size` (px), starting at x0; returns (d, advance)."""
    scale = size / upm; x = x0; parts = []
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
        tp = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        gs[name].draw(tp)
        parts.append(pen.getCommands())
        adv = hmtx[name][0] * scale + tracking * size
        # simple pair kerning is skipped on purpose: Inter's default spacing is already even at this weight
        x += adv
    return " ".join(p for p in parts if p), x - x0 - tracking * size

# ---- icon geometry, 256 x 256 ---------------------------------------------------------------
def spanner(fill, gap=None, gapw=0):
    # double-ended open spanner, drawn vertically around (0,0): head circles r=27 at y=-70/+70, 16-wide jaws, 22-wide handle
    d = ("M-8.5,-96.7 L-8.5,-66 L8.5,-66 L8.5,-96.7 A28 28 0 0 1 13,-45.2 L13,45.2 A28 28 0 0 1 8.5,96.7 L8.5,66 L-8.5,66 L-8.5,96.7 "
         "A28 28 0 0 1 -13,45.2 L-13,-45.2 A28 28 0 0 1 -8.5,-96.7 Z")
    s = ""
    if gap: s += f'<path d="{d}" fill="{gap}" stroke="{gap}" stroke-width="{gapw}" stroke-linejoin="round"/>'
    s += f'<path d="{d}" fill="{fill}" stroke="{fill}" stroke-width="2" stroke-linejoin="round"/>'
    return s

def driver(fill):
    # screwdriver drawn vertically, handle at the top, tip at the bottom; grip slot is a hole (evenodd)
    handle = "M-17,-84 a14 14 0 0 1 14,-14 h6 a14 14 0 0 1 14,14 v50 a8 8 0 0 1 -8,8 h-18 a8 8 0 0 1 -8,-8 Z"
    slot = "M-6,-82 a5 5 0 0 1 5,-5 h2 a5 5 0 0 1 5,5 v34 a5 5 0 0 1 -5,5 h-2 a5 5 0 0 1 -5,-5 Z"
    collar = "M-11,-26 h22 a3 3 0 0 1 3,3 v6 a3 3 0 0 1 -3,3 h-22 a3 3 0 0 1 -3,-3 v-6 a3 3 0 0 1 3,-3 Z"
    shaft = "M-4.5,-14 H4.5 V76 L10,90 Q10,94 6,94 H-6 Q-10,94 -10,90 L-4.5,76 Z"
    return (f'<path d="{handle} {slot}" fill="{fill}" fill-rule="evenodd"/>'
            f'<path d="{collar}" fill="{fill}"/><path d="{shaft}" fill="{fill}"/>')

BOLT = "M149,68 L102,141 H127 L108,198 L163,117 H137 Z"

def art(tile, tools, bolt=RED):
    """The artwork only (no tile), centred on 128,128. `tile` colour is used for the cut-out gaps where tools cross."""
    return (f'<g transform="translate(128 128) rotate(-45) scale(1.16)">{driver(tools)}</g>'
            f'<g transform="translate(128 128) rotate(45) scale(1.16)">{spanner(tools, gap=tile, gapw=9)}</g>'
            f'<path d="{BOLT}" fill="{tile}" stroke="{tile}" stroke-width="9" stroke-linejoin="round"/>'
            f'<path d="{BOLT}" fill="{bolt}" stroke="{bolt}" stroke-width="2" stroke-linejoin="round"/>')

def mark(tile=NAVY, tools=WHITE, ring=None, title="Express Help"):
    ringsvg = f'<rect x="7" y="7" width="242" height="242" rx="54" fill="none" stroke="{ring}" stroke-width="6"/>' if ring else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="{title}">'
            f'<title>{title}</title><rect x="4" y="4" width="248" height="248" rx="58" fill="{tile}"/>{ringsvg}{art(tile, tools)}</svg>')

def lockup(tile=NAVY, tools=WHITE, word=NAVY, ring=None, title="Express Help"):
    size = 124; d, adv = word_path("Express Help", size, 0, 0)
    # lockup canvas: mark 256 square at left, wordmark baseline so that cap height centres on the tile
    cap = font["OS/2"].sCapHeight * size / upm
    base = 128 + cap / 2
    d, adv = word_path("Express Help", size, 0, base)
    gap = 40; x0 = 256 + gap
    d, adv = word_path("Express Help", size, x0, base)
    w = int(x0 + adv + 8)
    ringsvg = f'<rect x="7" y="7" width="242" height="242" rx="54" fill="none" stroke="{ring}" stroke-width="6"/>' if ring else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} 256" width="{w}" height="256" role="img" aria-label="{title}">'
            f'<title>{title}</title><rect x="4" y="4" width="248" height="248" rx="58" fill="{tile}"/>{ringsvg}{art(tile, tools)}'
            f'<path d="{d}" fill="{word}"/></svg>'), w

def mono(color):
    # one colour: tile outline + tools, bolt as a knock-out gap
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Express Help">'
            f'<title>Express Help</title><rect x="7" y="7" width="242" height="242" rx="55" fill="none" stroke="{color}" stroke-width="8"/>'
            f'<g fill="{color}">{art("none", color, bolt=color)}</g></svg>')

def write(name, s):
    open(os.path.join(OUT, name), "w").write(s + "\n"); print("wrote", name)

write("logo-mark.svg", mark())
write("logo-mark-dark.svg", mark(ring=WHITE))
l, w = lockup(); write("logo-lockup.svg", l)
l2, _ = lockup(word=WHITE, ring=WHITE); write("logo-lockup-dark.svg", l2)
write("logo-mark-mono.svg", mono("#0B2559"))
write("logo-mark-mono-white.svg", mono("#FFFFFF"))
# favicon: same artwork, slightly bolder tile for tiny sizes
write("favicon.svg", mark())
# apple touch icon: full-bleed square (iOS rounds it itself), artwork scaled to 80 %
apple = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" fill="{NAVY}"/>'
         f'<g transform="translate(128 128) scale(0.86) translate(-128 -128)">{art(NAVY, WHITE)}</g></svg>')
write("apple-touch-icon-src.svg", apple)
# email: navy wordmark + mark, transparent background
write("logo-lockup-email-src.svg", l)
print("lockup width", w)
