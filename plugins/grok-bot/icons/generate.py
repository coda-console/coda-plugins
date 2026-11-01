# /// script
# requires-python = ">=3.10"
# dependencies = ["cairosvg==2.8.2", "pypdf==6.1.3"]
# ///
"""Generate a vector blink loop from the reviewed open-eye SVG; no runtime dependencies."""
from io import BytesIO
from math import atan2, cos, sin
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import cairosvg
from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject

HERE = Path(__file__).resolve().parent
SOURCE = ET.fromstring((HERE / "grok-bot.svg").read_text())
PATH = SOURCE.find("{http://www.w3.org/2000/svg}path")
FACE, *EYES = PATH.attrib["d"].strip().rstrip("Z").split(" Z ")
assert len(EYES) == 2


def eyelid(path, openness):
    # The original eyes are polygonal holes. Compress each along its own long axis,
    # keeping its centre, tilt and transparent fill; the face's curve is unchanged.
    points = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", path)]
    pairs = list(zip(points[::2], points[1::2]))
    cx = sum(x for x, _ in pairs) / len(pairs)
    cy = sum(y for _, y in pairs) / len(pairs)
    xx = sum((x - cx) ** 2 for x, _ in pairs)
    yy = sum((y - cy) ** 2 for _, y in pairs)
    xy = sum((x - cx) * (y - cy) for x, y in pairs)
    angle = atan2(2 * xy, xx - yy) / 2
    ux, uy = cos(angle), sin(angle)
    result = []
    for x, y in pairs:
        distance = ((x - cx) * ux + (y - cy) * uy) * (openness - 1)
        result.append(f"{x + distance * ux:.4f} {y + distance * uy:.4f}")
    return "M " + " L ".join(result)


writer = PdfWriter()
for openness, seconds in [(1, 4.8), (0.5, 0.06), (0.08, 0.08), (0.5, 0.06)]:
    PATH.set("d", " Z ".join([FACE] + [eye if openness == 1 else eyelid(eye, openness) for eye in EYES]) + " Z")
    pdf = PdfReader(BytesIO(cairosvg.svg2pdf(bytestring=ET.tostring(SOURCE))))
    page = writer.add_page(pdf.pages[0])
    # Standard PDF page display duration; Coda uses the first page for still icons.
    page[NameObject("/Dur")] = FloatObject(seconds)
writer.add_metadata({"/Title": "Grok Bot", "/Producer": "CairoSVG + pypdf"})
with (HERE / "grok-bot.pdf").open("wb") as output:
    writer.write(output)
assert (HERE / "grok-bot.pdf").stat().st_size <= 32 * 1024
