"""Render a DXF or DWG attachment to an inline SVG for in-browser preview.

DXF renders directly with ezdxf (already a dependency). DWG is a proprietary
binary that ezdxf cannot read, so it is handed to OpenConstructionERP's own DDC
converter — the same engine its Takeoff module uses — which turns it into a
geometry table (layers + drawable entities). We draw that table to SVG here.

Why not LibreDWG anymore: the DDC converter is the real, maintained CAD engine
already shipped with the app (installable through the Takeoff UI, no root), and
it reads modern DWG the way the rest of the product does. If it is not installed
yet, DWG raises CadRenderError and the caller falls back to download-to-open.

The preview shows geometry (lines, arcs, circles, polylines) — not text — so an
annotation-heavy sheet still reads as its linework. Everything renders in the
drawing's own coordinates, flipped vertically so a Y-up CAD drawing is upright.
"""
from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg

# Rendering a very large drawing can be slow and memory-heavy; past this the
# caller should just serve the file for download instead.
MAX_RENDER_BYTES = 20 * 1024 * 1024  # 20 MB


class CadRenderError(Exception):
    """Preview is not possible for this file — the caller downloads instead."""


# ── DXF: ezdxf's own SVG backend ───────────────────────────────────────────
def _dxf_to_svg(dxf_path: str) -> str:
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend).draw_layout(msp)
    out = backend.get_string(layout.Page(0, 0))  # auto-size to content
    if "<path" not in out and "<circle" not in out and "<polyline" not in out and "<line" not in out:
        raise CadRenderError("Drawing has no visible geometry")
    return out


def _render_dxf(data: bytes) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "in.dxf"
        path.write_bytes(data)
        try:
            return _dxf_to_svg(str(path))
        except CadRenderError:
            raise
        except Exception as exc:  # noqa: BLE001 - malformed DXF -> download
            raise CadRenderError("Could not read this DXF") from exc


# ── Geometry table → SVG (used for DWG; the DDC parser emits parse_dxf-shaped
#    entity dicts: {entity_type, layer, color, geometry_data:{...}}) ──────────
def _visible(color: str | None) -> str:
    """Keep the entity's colour unless it is near-white (CAD model space is
    usually black, so white linework would vanish on our light preview)."""
    c = (color or "").strip()
    if not c.startswith("#") or len(c) != 7:
        return "#333333"
    try:
        r, g, b = int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)
    except ValueError:
        return "#333333"
    if r > 235 and g > 235 and b > 235:
        return "#333333"
    return c


def _bounds(entities: list[dict]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []

    def add(x: Any, y: Any) -> None:
        try:
            xs.append(float(x))
            ys.append(float(y))
        except (TypeError, ValueError):
            pass

    for e in entities:
        g = e.get("geometry_data") or {}
        for key in ("start", "end", "center", "insert"):
            p = g.get(key)
            if isinstance(p, dict):
                add(p.get("x"), p.get("y"))
        for p in g.get("points") or []:
            if isinstance(p, dict):
                add(p.get("x"), p.get("y"))
        if g.get("radius") is not None and isinstance(g.get("center"), dict):
            c = g["center"]
            r = float(g["radius"])
            add(c.get("x", 0) - r, c.get("y", 0) - r)
            add(c.get("x", 0) + r, c.get("y", 0) + r)
    if not xs or not ys:
        return 0.0, 0.0, 1.0, 1.0
    return min(xs), min(ys), max(xs), max(ys)


def _arc_points(cx: float, cy: float, r: float, a0: float, a1: float) -> list[tuple[float, float]]:
    if a1 < a0:
        a1 += 2 * math.pi
    steps = max(6, int((a1 - a0) / (math.pi / 24)) + 1)
    return [
        (cx + r * math.cos(a0 + (a1 - a0) * k / steps), cy + r * math.sin(a0 + (a1 - a0) * k / steps))
        for k in range(steps + 1)
    ]


def _path(points: list[tuple[float, float]], color: str, close: bool = False) -> str:
    if not points:
        return ""
    d = "M" + " L".join(f"{x:.3f} {y:.3f}" for x, y in points)
    if close:
        d += " Z"
    return f'<path d="{d}" stroke="{color}"/>'


def _entities_to_svg(parsed: dict) -> str:
    entities = parsed.get("entities") or []
    if not entities:
        raise CadRenderError("Drawing has no visible geometry")

    ext = parsed.get("extents") or {}
    min_x, min_y, max_x, max_y = (
        ext.get("min_x"),
        ext.get("min_y"),
        ext.get("max_x"),
        ext.get("max_y"),
    )
    if None in (min_x, min_y, max_x, max_y) or max_x <= min_x or max_y <= min_y:
        min_x, min_y, max_x, max_y = _bounds(entities)

    w = max(max_x - min_x, 1e-6)
    h = max(max_y - min_y, 1e-6)
    pad = max(w, h) * 0.02

    body: list[str] = []
    for e in entities:
        t = e.get("entity_type")
        g = e.get("geometry_data") or {}
        color = _visible(e.get("color"))
        try:
            if t == "LINE":
                s, en = g["start"], g["end"]
                body.append(f'<line x1="{s["x"]:.3f}" y1="{s["y"]:.3f}" x2="{en["x"]:.3f}" y2="{en["y"]:.3f}" stroke="{color}"/>')
            elif t in ("LWPOLYLINE", "POLYLINE", "HATCH"):
                pts = [(p["x"], p["y"]) for p in (g.get("points") or []) if isinstance(p, dict)]
                body.append(_path(pts, color, close=bool(g.get("closed")) or t == "HATCH"))
            elif t == "CIRCLE":
                c = g["center"]
                body.append(f'<circle cx="{c["x"]:.3f}" cy="{c["y"]:.3f}" r="{float(g["radius"]):.3f}" stroke="{color}"/>')
            elif t == "ARC":
                c = g["center"]
                body.append(_path(_arc_points(c["x"], c["y"], float(g["radius"]), float(g.get("start_angle", 0)), float(g.get("end_angle", 0))), color))
            elif t == "ELLIPSE":
                c = g["center"]
                ma = g.get("major_axis") or {"x": 1, "y": 0}
                a = math.hypot(ma.get("x", 1), ma.get("y", 0)) or 1.0
                b = a * float(g.get("ratio", 1.0))
                rot = math.atan2(ma.get("y", 0), ma.get("x", 1))
                pts = []
                for k in range(49):
                    th = 2 * math.pi * k / 48
                    ex, ey = a * math.cos(th), b * math.sin(th)
                    pts.append((c["x"] + ex * math.cos(rot) - ey * math.sin(rot), c["y"] + ex * math.sin(rot) + ey * math.cos(rot)))
                body.append(_path(pts, color, close=True))
            # TEXT / MTEXT / INSERT are intentionally skipped: a line preview.
        except (KeyError, TypeError, ValueError):
            continue  # one malformed entity never kills the whole preview

    if not any(body):
        raise CadRenderError("Drawing has no visible geometry")

    # Flip vertically (CAD is Y-up, SVG is Y-down) so the drawing is upright.
    # non-scaling-stroke keeps a crisp ~1px line at any zoom of the viewBox.
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{min_x - pad:.3f} {min_y - pad:.3f} {w + 2 * pad:.3f} {h + 2 * pad:.3f}">'
        f'<style>line,path,circle,ellipse{{fill:none;stroke-width:1;vector-effect:non-scaling-stroke}}</style>'
        f'<g transform="translate(0 {min_y + max_y:.3f}) scale(1 -1)">'
        + "".join(body)
        + "</g></svg>"
    )


# ── DWG: OpenConstructionERP's DDC converter ───────────────────────────────
async def _render_dwg(data: bytes, filename: str) -> str:
    # Import lazily so this module still imports where OCE's boq/dwg_takeoff
    # modules are absent (tests, tooling).
    from app.modules.boq.cad_import import convert_cad_to_excel, find_converter
    from app.modules.dwg_takeoff.ddc_dwg_parser import parse_ddc_dwg_excel

    # Do NOT trigger a 218 MB auto-install inside a page request — if the
    # converter isn't there yet, say so and let the admin install it.
    if find_converter("dwg") is None:
        raise CadRenderError("The DWG preview engine isn't installed on the server yet — try again once it finishes installing.")

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.dwg"
        src.write_bytes(data)
        try:
            xlsx = await convert_cad_to_excel(src, Path(tmp), "dwg")
        except Exception as exc:  # noqa: BLE001 - convert failed -> download
            raise CadRenderError("Could not convert this DWG") from exc
        if not xlsx or not Path(xlsx).exists():
            raise CadRenderError("Could not convert this DWG")
        try:
            parsed = parse_ddc_dwg_excel(xlsx)
        except Exception as exc:  # noqa: BLE001
            raise CadRenderError("Converted DWG could not be read") from exc
        return _entities_to_svg(parsed)


async def render_cad_to_svg(data: bytes, filename: str) -> str:
    """Return an SVG string for a DXF/DWG file, or raise CadRenderError.

    DXF is CPU-bound and synchronous (ezdxf), so it runs in a threadpool; DWG is
    an async subprocess conversion (the DDC converter) and is awaited directly.
    """
    if len(data) > MAX_RENDER_BYTES:
        raise CadRenderError("File is too large to preview")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "dxf":
        from starlette.concurrency import run_in_threadpool

        return await run_in_threadpool(_render_dxf, data)
    if ext == "dwg":
        return await _render_dwg(data, filename)
    raise CadRenderError(f"Cannot preview a .{ext} file")
