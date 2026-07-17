"""Auto-mounted at /api/v1/achi/ by the module loader — no registration needed."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.dependencies import CurrentUserId, SessionDep

from .manifest import manifest as MANIFEST
from .schemas import (
    ClientFileCreate,
    ClientFileListOut,
    ClientFileOut,
    ClientFileUpdate,
    FileLogCreate,
    FileLogOut,
    ModuleInfo,
)
from .service import ClientFileService

router = APIRouter()


@router.get("/info", response_model=ModuleInfo, summary="ACHI module info")
def info() -> ModuleInfo:
    return ModuleInfo(
        module=MANIFEST.name,
        version=MANIFEST.version,
        company="Achi Scaffolding",
        note="ACHI's own code. Upstream is stock and unmodified.",
    )


# ── Client files ──────────────────────────────────────────────────────────


@router.post(
    "/files/",
    response_model=ClientFileOut,
    status_code=status.HTTP_201_CREATED,
    summary="Open a client file",
    description=(
        "Opens a file for a person or company before they are a client, and mirrors "
        "them into OCE's contact directory via the contacts bridge (deduping by "
        "email). Not linked to a project — a prospect has no project."
    ),
)
async def create_file(data: ClientFileCreate, session: SessionDep, user_id: CurrentUserId) -> ClientFileOut:
    f = await ClientFileService(session).create(data, user_id=user_id)
    return ClientFileOut.model_validate(f)


@router.get("/files/", response_model=list[ClientFileListOut], summary="List client files")
async def list_files(
    session: SessionDep,
    _user_id: CurrentUserId,
    stage: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[ClientFileListOut]:
    rows = await ClientFileService(session).list(stage=stage, status=status_, limit=limit)
    return [ClientFileListOut.model_validate(r) for r in rows]


@router.get("/files/{file_id}", response_model=ClientFileOut, summary="Get a client file")
async def get_file(file_id: str, session: SessionDep, _user_id: CurrentUserId) -> ClientFileOut:
    f = await ClientFileService(session).get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return ClientFileOut.model_validate(f)


@router.patch("/files/{file_id}", response_model=ClientFileOut, summary="Update a client file")
async def update_file(
    file_id: str, data: ClientFileUpdate, session: SessionDep, _user_id: CurrentUserId
) -> ClientFileOut:
    svc = ClientFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return ClientFileOut.model_validate(await svc.update(f, data))


# ── Logs ──────────────────────────────────────────────────────────────────


@router.post(
    "/files/{file_id}/logs/",
    response_model=FileLogOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add a log entry to a file",
)
async def add_log(
    file_id: str, data: FileLogCreate, session: SessionDep, user_id: CurrentUserId
) -> FileLogOut:
    svc = ClientFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return FileLogOut.model_validate(await svc.add_log(f, data, user_id=user_id))
