"""Independent Code 39 checks. Patterns come from python-barcode. Payloads come from zxing-cpp."""
import json
import re
import sys

from barcode.codex import Code39
from PIL import Image, ImageDraw
import zxingcpp


def reference_bits(payload):
    return Code39(payload, add_checksum=False).build()[0]


def rasterize(svg):
    view = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg)
    if not view:
        raise SystemExit("SVG has no viewBox")
    width = float(view.group(1))
    height = float(view.group(2))
    scale = 16
    pad = 24
    image = Image.new("L", (int(width * scale) + pad * 2, int(height * scale) + pad * 2), 255)
    draw = ImageDraw.Draw(image)
    bars = list(re.finditer(r'<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)" fill="#000"', svg))
    if not bars:
        raise SystemExit("SVG has no black bars")
    for match in bars:
        x, y, w, h = (float(part) for part in match.groups())
        draw.rectangle([pad + x * scale, pad + y * scale, pad + (x + w) * scale - 1, pad + (y + h) * scale - 1], fill=0)
    return image


def decode(svg):
    image = rasterize(svg)
    found = zxingcpp.read_barcodes(image)
    if len(found) != 1:
        raise SystemExit("Expected one barcode, found " + str(len(found)))
    hit = found[0]
    return {"text": hit.text, "format": str(hit.format)}


def main():
    command = sys.argv[1]
    if command == "bits":
        for payload in sys.argv[2:]:
            sys.stdout.write(payload + "\t" + reference_bits(payload) + "\n")
        return
    if command == "checksum":
        payload = sys.argv[2]
        sys.stdout.write(Code39(payload, add_checksum=True).build()[0] + "\n")
        return
    if command == "decode":
        svg = open(sys.argv[2], encoding="utf-8").read()
        json.dump(decode(svg), sys.stdout)
        sys.stdout.write("\n")
        return
    raise SystemExit("Unknown command")


if __name__ == "__main__":
    main()
