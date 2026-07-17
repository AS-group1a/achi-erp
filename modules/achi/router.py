"""Auto-mounted at /api/v1/achi/ by the module loader — no registration needed."""

from __future__ import annotations

from fastapi import APIRouter

from .manifest import manifest as MANIFEST
from .schemas import ModuleInfo

router = APIRouter()


@router.get("/info", response_model=ModuleInfo, summary="ACHI module info")
def info() -> ModuleInfo:
    """Proves the module loaded and its router mounted."""
    return ModuleInfo(
        module=MANIFEST.name,
        version=MANIFEST.version,
        company="Achi Scaffolding",
        note="ACHI's own code. Upstream is stock and unmodified.",
    )
