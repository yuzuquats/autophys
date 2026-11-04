"""Deterministic M-4 plots, no plotting dependency.

One 640x400 indexed (8-bit palette) PNG per measurement/channel, two panels:
fit above (blue measured dots, red fitted curve, dashed grey initial), residual
below (blue dots, green +/-1 band). No text; captions label the channel.
Rows use PNG filter 0, zlib level 9; no timestamps or ancillary metadata.
At most 2000 evenly spaced measured samples are drawn per channel.
Only stored run curves are used (linear interpolation for reduced curves);
rendering never simulates. Palette and integer rasterization keep bytes modest.
"""
import struct
import zlib

import numpy as np

from .data import Observation

WIDTH, HEIGHT = 640, 400
PALETTE = bytes((255,255,255, 50,50,50, 35,100,190, 200,55,45,
                 140,140,140, 225,242,225))


def _png(pixels):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
    rows = b"".join(b"\0" + row.tobytes() for row in pixels)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", PALETTE) + chunk(b"IDAT", zlib.compress(rows, 9))
            + chunk(b"IEND", b""))


def render_plots(measurements, curves):
    """Yield (caption, PNG bytes) in measurement order, sorted channel order."""
    for record in measurements:
        curve = curves.get(record.id)
        if not curve:
            continue
        obs = Observation.from_dict(record.payload["observation"])
        if not len(obs.t):
            continue
        indices = np.rint(np.linspace(0, len(obs.t)-1, min(len(obs.t), 2000))).astype(int)
        t = obs.t[indices]
        ct = np.asarray(curve.get("t", obs.t), dtype=float)
        for channel in sorted(obs.y):
            if channel not in curve["fit"]:
                continue
            fitted = np.interp(t, ct, curve["fit"][channel])
            initial = np.interp(t, ct, curve["initial"][channel])
            measured = obs.y[channel][indices]
            residual = (measured - fitted) / obs.sigma[channel]
            pixels = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)

            def panel(series, top, bottom, band=False):
                finite = np.concatenate([np.asarray(v)[np.isfinite(v)] for v in series])
                lo = min(float(finite.min()) if finite.size else -1., -1.) if band else (float(finite.min()) if finite.size else -1.)
                hi = max(float(finite.max()) if finite.size else 1., 1.) if band else (float(finite.max()) if finite.size else 1.)
                pad = max((hi-lo)*.05, 1e-12)
                lo, hi = lo-pad, hi+pad
                left, right = 35, 620
                def ys(y):
                    return int(np.rint(bottom - (y-lo)/(hi-lo)*(bottom-top)))
                span = max(float(t[-1]-t[0]), 1e-12)
                xs = np.rint(left + (t-t[0])/span*(right-left)).astype(int)
                if band:
                    pixels[max(top,ys(1)):min(bottom,ys(-1))+1,left:right+1] = 5
                pixels[top:bottom+1,left] = pixels[top:bottom+1,right] = 1
                pixels[top,left:right+1] = pixels[bottom,left:right+1] = 1

                def points(values, color, line=False, dashed=False):
                    previous = None
                    for x,y in zip(xs, values):
                        if not np.isfinite(y):
                            previous = None
                            continue
                        point = (int(x), ys(float(y)))
                        if line and previous is not None:
                            x0,y0 = previous
                            x1,y1 = point
                            n = max(abs(x1-x0),abs(y1-y0),1)
                            for i in range(n+1):
                                xx = int(np.rint(x0+(x1-x0)*i/n))
                                yy = int(np.rint(y0+(y1-y0)*i/n))
                                if top <= yy <= bottom and left <= xx <= right and (not dashed or (xx//6)%2 == 0):
                                    pixels[yy,xx] = color
                        elif not line:
                            xx,yy = point
                            pixels[max(top,yy-1):min(bottom,yy+1)+1,
                                   max(left,xx-1):min(right,xx+1)+1] = color
                        previous = point
                return points

            draw = panel([measured, fitted, initial], 15, 235)
            draw(initial,4,True,True)
            draw(fitted,3,True)
            draw(measured,2)
            draw = panel([residual],265,380,True)
            draw(residual,2)
            yield f"{obs.experiment} / {channel}: measured, fit, dashed initial; (measured-fit)/sigma, +/-1 band", _png(pixels)
