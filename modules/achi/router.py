"""Auto-mounted at /api/v1/achi/ by the module loader — no registration needed."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.dependencies import CurrentUserId, SessionDep

from .manifest import manifest as MANIFEST
from .schemas import (
    ContactFileCreate,
    ContactFileListOut,
    ContactFileOut,
    ContactFileUpdate,
    FileConvertRequest,
    FileLogCreate,
    FileLogOut,
    ModuleInfo,
)
from .service import ContactFileService

router = APIRouter()


@router.get("/info", response_model=ModuleInfo, summary="ACHI module info")
def info() -> ModuleInfo:
    return ModuleInfo(
        module=MANIFEST.name,
        version=MANIFEST.version,
        company="Achi Scaffolding",
        note="ACHI's own code. Upstream is stock and unmodified.",
    )


async def _out(svc: ContactFileService, f) -> ContactFileOut:
    o = ContactFileOut.model_validate(f)
    o.contact_name = await svc.name_for(f.contact_id)
    return o


@router.post(
    "/files/",
    response_model=ContactFileOut,
    status_code=status.HTTP_201_CREATED,
    summary="Open a file against a contact",
    description=(
        "Contacts have files; clients have projects. Pass an existing contact_id, or a "
        "`person` to find/create one (deduped by email via the contacts bridge). The file "
        "records this enquiry — not the person, whose details live in the contact directory."
    ),
)
async def create_file(data: ContactFileCreate, session: SessionDep, user_id: CurrentUserId) -> ContactFileOut:
    svc = ContactFileService(session)
    try:
        f = await svc.create(data, user_id=user_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return await _out(svc, f)


@router.get("/files/", response_model=list[ContactFileListOut], summary="List files")
async def list_files(
    session: SessionDep,
    _user_id: CurrentUserId,
    stage: str | None = Query(default=None),
    status_: str | None = Query(default=None, alias="status"),
    contact_id: str | None = Query(default=None, description="All files for one contact"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[ContactFileListOut]:
    svc = ContactFileService(session)
    rows = await svc.list(stage=stage, status=status_, contact_id=contact_id, limit=limit)
    out = []
    for r in rows:
        o = ContactFileListOut.model_validate(r)
        o.contact_name = await svc.name_for(r.contact_id)
        out.append(o)
    return out


@router.get("/files/{file_id}", response_model=ContactFileOut, summary="Get a file")
async def get_file(file_id: str, session: SessionDep, _user_id: CurrentUserId) -> ContactFileOut:
    svc = ContactFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return await _out(svc, f)


@router.patch("/files/{file_id}", response_model=ContactFileOut, summary="Update a file")
async def update_file(
    file_id: str, data: ContactFileUpdate, session: SessionDep, _user_id: CurrentUserId
) -> ContactFileOut:
    svc = ContactFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return await _out(svc, await svc.update(f, data))


@router.post(
    "/files/{file_id}/convert/",
    response_model=ContactFileOut,
    summary="Convert a file to a project (the contact becomes a client)",
    description=(
        "Records the outcome: the file closes onto an existing OCE project and the "
        "contact is promoted from lead to client. The project itself is OCE's — we "
        "don't create it, project setup has its own rules."
    ),
)
async def convert_file(
    file_id: str, data: FileConvertRequest, session: SessionDep, _user_id: CurrentUserId
) -> ContactFileOut:
    svc = ContactFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return await _out(svc, await svc.convert(f, data.project_id))


@router.post(
    "/files/{file_id}/logs/",
    response_model=FileLogOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add a log entry to a file",
)
async def add_log(
    file_id: str, data: FileLogCreate, session: SessionDep, user_id: CurrentUserId
) -> FileLogOut:
    svc = ContactFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return FileLogOut.model_validate(await svc.add_log(f, data, user_id=user_id))
