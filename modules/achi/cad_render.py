"""Render a DXF or DWG attachment to an inline SVG for in-browser preview.

DXF renders directly with ezdxf (already a dependency). DWG is a proprietary
binary that ezdxf cannot read, so it is first converted to DXF with LibreDWG's
`dwg2dxf`. If that tool is not installed, DWG raises CadRenderError and the
caller falls back to download-to-open.

Text labels need a font on the host; geometry renders without one. Install
`fonts-dejavu-core` on the server for labelled previews.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg

# Rendering a very large drawing can be slow and memory-heavy; past this the
# caller should just serve the file for download instead.
MAX_RENDER_BYTES = 20 * 1024 * 1024  # 20 MB


class CadRenderError(Exception):
    """Preview is not possible for this file — the caller downloads instead."""


def _dxf_to_svg(dxf_path: str) -> str:
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend).draw_layout(msp)
    out = backend.get_string(layout.Page(0, 0))  # auto-size to content
    if "<path" not in out and "<circle" not in out and "<polyline" not in out and "<line" not in out:
        raise CadRenderError("Drawing has no visible geometry")
    return out


def render_to_svg(data: bytes, filename: str) -> str:
    """Return an SVG string for a DXF/DWG file, or raise CadRenderError."""
    if len(data) > MAX_RENDER_BYTES:
        raise CadRenderError("File is too large to preview")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    with tempfile.TemporaryDirectory() as tmp:
        if ext == "dxf":
            path = os.path.join(tmp, "in.dxf")
            with open(path, "wb") as fh:
                fh.write(data)
            try:
                return _dxf_to_svg(path)
            except CadRenderError:
                raise
            except Exception as exc:  # noqa: BLE001 - malformed DXF -> download
                raise CadRenderError("Could not read this DXF") from exc

        if ext == "dwg":
            tool = shutil.which("dwg2dxf")
            if not tool:
                raise CadRenderError("DWG preview needs LibreDWG (dwg2dxf) on the server")
            src = os.path.join(tmp, "in.dwg")
            out = os.path.join(tmp, "in.dxf")
            with open(src, "wb") as fh:
                fh.write(data)
            try:
                proc = subprocess.run(
                    [tool, "-o", out, src],
                    capture_output=True, timeout=30, check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise CadRenderError("DWG conversion timed out") from exc
            if proc.returncode != 0 or not os.path.exists(out):
                raise CadRenderError("Could not convert this DWG")
            try:
                return _dxf_to_svg(out)
            except CadRenderError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise CadRenderError("Converted DWG could not be rendered") from exc

        raise CadRenderError(f"Cannot preview a .{ext} file")
