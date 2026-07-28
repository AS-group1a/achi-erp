"""Convert an RVT (or IFC) attachment to binary glTF (.glb) for a 3D preview.

Reuses OpenConstructionERP's own BIM pipeline end to end: the DDC RvtExporter
turns the model into a COLLADA .dae, and ``bim_hub.ifc_processor.process_ifc_file``
runs trimesh (+ pycollada) to produce a .glb the browser renders with three.js.
We skip bim_hub's project/model/DB scaffolding — we only need the .glb bytes.

Conversion of a real building model is slow and memory-heavy, so the caller runs
it as a background job (see the router) and we cache the .glb by attachment id on
the persistent /data volume. Attachment bytes are immutable, so a cached .glb is
valid forever — the second view is instant.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

# Persisted on the /data volume (HOME=/data in the container), so a converted
# model survives restarts and rebuilds.
GLB_CACHE_DIR = Path(os.environ.get("ACHI_GLB_CACHE", str(Path.home() / ".achi_glb_cache")))

# A source model past this is refused up front — the .dae/.glb it produces would
# be far larger and risk OOM on the box / an unusable download in the browser.
MAX_MODEL_BYTES = 300 * 1024 * 1024  # 300 MB

SUPPORTED_3D_EXTS = ("rvt", "ifc")


class BimRenderError(Exception):
    """3D preview is not possible — the caller falls back to download."""


def _ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def is_3d_model(filename: str) -> bool:
    return _ext(filename) in SUPPORTED_3D_EXTS


def glb_cache_path(attachment_id: str) -> Path:
    return GLB_CACHE_DIR / f"{attachment_id}.glb"


def cached_glb(attachment_id: str) -> Path | None:
    p = glb_cache_path(attachment_id)
    return p if p.exists() and p.stat().st_size > 0 else None


def build_glb_sync(attachment_id: str, data: bytes, filename: str) -> Path:
    """Blocking: convert the model to .glb and cache it. Returns the cache path.

    Run this via ``asyncio.to_thread`` — process_ifc_file shells out to the DDC
    converter and does CPU-heavy mesh work.
    """
    ext = _ext(filename)
    if ext not in SUPPORTED_3D_EXTS:
        raise BimRenderError(f"Cannot 3D-preview a .{ext} file")
    if len(data) > MAX_MODEL_BYTES:
        raise BimRenderError("Model is too large to preview in 3D")

    cached = cached_glb(attachment_id)
    if cached is not None:
        return cached

    # Import lazily so this module still imports where OCE's bim_hub is absent.
    from app.modules.bim_hub.ifc_processor import process_ifc_file
    from app.modules.boq.cad_import import find_converter

    # RVT has no text fallback — it MUST have the converter. IFC can degrade to a
    # placeholder box model, which is not worth previewing, so require it too.
    if find_converter(ext) is None:
        raise BimRenderError(f"The {ext.upper()} 3D engine isn't installed on the server yet — try again shortly.")

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"in.{ext}"
        src.write_bytes(data)
        try:
            result = process_ifc_file(src, Path(tmp), "standard")
        except Exception as exc:  # noqa: BLE001 - conversion failed -> download
            raise BimRenderError("Could not extract 3D geometry from this model") from exc

        glb = result.get("glb_path") if isinstance(result, dict) else None
        if not glb or not Path(glb).exists() or Path(glb).stat().st_size == 0:
            raise BimRenderError("Could not extract 3D geometry from this model")
        if result.get("geometry_type") == "placeholder":
            # Only real geometry is worth a 3D view; boxes are not.
            raise BimRenderError("No real 3D geometry in this model")

        GLB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        out = glb_cache_path(attachment_id)
        tmp_out = out.with_suffix(".glb.part")
        shutil.move(str(glb), str(tmp_out))  # cross-filesystem safe (tmp -> /data)
        tmp_out.replace(out)                 # atomic publish within /data
        return out
