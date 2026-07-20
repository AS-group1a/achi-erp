"""Auto-mounted at /api/v1/achi/ by the module loader — no registration needed."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

from app.dependencies import CurrentUserId, SessionDep

from .manifest import manifest as MANIFEST
from .schemas import (
    AttachmentOut,
    ContactFileCreate,
    LogRowOut,
    QuickLogCreate,
    QuickLogOut,
    ContactFileListOut,
    ContactFileOut,
    ContactFileUpdate,
    FileConvertRequest,
    ContactPatch,
    FileLogCreate,
    FileLogOut,
    FileLogUpdate,
    ModuleInfo,
)
from .service import ContactFileService

router = APIRouter()

_UI_DIR = Path(__file__).parent / "ui"


@router.get(
    "/ui",
    response_class=HTMLResponse,
    include_in_schema=False,
    summary="Client Files UI",
)
def ui() -> HTMLResponse:
    """Serve our own page from our own module.

    Why here and not in OCE's frontend: their UI ships pre-built inside the pip
    wheel (app/_frontend_dist), so adding a page to it means forking the repo and
    building their whole frontend ourselves — Node 22, ~8GB RAM, three.js/Cesium/
    ag-grid — and owning that pipeline forever. Serving our own HTML from our own
    router costs nothing and touches no upstream file.

    Being on the same origin as the SPA is what makes it work: the page reads the
    JWT the SPA already stored under localStorage['oe_access_token'], so there is
    no second login and no token plumbing.

    NOTE: deliberately unauthenticated — it is a static shell with no data in it.
    Every fetch it makes carries the bearer token and is authorised by the API
    routes below. Serving the shell to an anonymous browser leaks nothing.
    """
    return HTMLResponse(
        (_UI_DIR / "log.html").read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@router.get(
    "/ui/drawing.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Drawing tool for the description popup",
)
def ui_drawing_js() -> PlainTextResponse:
    """The canvas drawing tool, served beside the page that loads it.

    Kept out of log.html because it is a thousand lines of canvas logic that has
    nothing to say about the log grid, and because a separate file is cacheable.
    Same reasoning as ``ui()``: unauthenticated, because it is inert code with no
    data in it — every call it triggers goes through the authorised routes below.
    """
    return PlainTextResponse(
        (_UI_DIR / "drawing.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


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


# ── Quick capture: the log is the only thing a human uses ─────────────────


@router.post(
    "/logs/",
    response_model=QuickLogOut,
    status_code=status.HTTP_201_CREATED,
    summary="Log a call (creates the contact and file underneath)",
    description=(
        "The single entry point. Log that the phone rang; the contact is found or "
        "created (deduped by email) and a file is found or opened for them. Nobody "
        "should have to open a file by hand before writing down a call.\n\n"
        "The log lands on the contact's most recent OPEN file, or a new one if they "
        "have none. Pass new_file=true when a known contact rings about something "
        "unrelated."
    ),
)
async def quick_log(data: QuickLogCreate, session: SessionDep, user_id: CurrentUserId) -> QuickLogOut:
    r = await ContactFileService(session).quick_log(data, user_id=user_id)
    return QuickLogOut(
        log=FileLogOut.model_validate(r["log"]),
        file_id=r["file_id"],
        file_number=r["file_number"],
        file_created=r["file_created"],
        contact_id=r["contact_id"],
        contact_name=r["contact_name"],
        contact_created=r["contact_created"],
    )


@router.patch("/files/{file_id}/contact", summary="Edit the file's linked contact (inline)")
async def update_contact(
    file_id: str, data: ContactPatch, session: SessionDep, _user_id: CurrentUserId
) -> dict:
    svc = ContactFileService(session)
    f = await svc.get(file_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await svc.update_contact(f, data)
    return {"ok": True}


@router.patch("/logs/{log_id}", response_model=FileLogOut, summary="Edit a log entry (inline)")
async def update_log(
    log_id: str, data: FileLogUpdate, session: SessionDep, _user_id: CurrentUserId
) -> FileLogOut:
    svc = ContactFileService(session)
    log = await svc.get_log(log_id)
    if log is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Log not found")
    return FileLogOut.model_validate(await svc.update_log(log, data))


@router.get("/logs/{log_id}/drawing", summary="The log's drawing (canvas JSON)")
async def get_drawing(log_id: str, session: SessionDep, _user_id: CurrentUserId) -> dict:
    """Fetched only when the popup opens the drawing, never with the list.

    The blob is unbounded; shipping it on every row of /logs/ would make the grid
    pay for a feature almost no row uses. The list carries `has_drawing` instead.
    """
    log = await ContactFileService(session).get_log(log_id)
    if log is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Log not found")
    return {"drawing": log.drawing or "", "has_drawing": log.has_drawing}


# ── Attachments: the Files button in the description popup ────────────────

# Large enough for the scans and site photos this is actually for, small enough
# that a mis-drop cannot fill the disk. Enforced after the read, so the limit is
# on real bytes rather than a Content-Length the client controls.
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024


@router.get(
    "/logs/{log_id}/attachments",
    response_model=list[AttachmentOut],
    summary="Files attached to a log",
)
async def list_attachments(
    log_id: str, session: SessionDep, _user_id: CurrentUserId
) -> list[AttachmentOut]:
    svc = ContactFileService(session)
    if await svc.get_log(log_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Log not found")
    return [AttachmentOut.model_validate(a) for a in await svc.list_attachments(log_id)]


@router.post(
    "/logs/{log_id}/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Attach a file to a log",
)
async def add_attachment(
    log_id: str,
    session: SessionDep,
    user_id: CurrentUserId,
    file: UploadFile = File(...),
) -> AttachmentOut:
    svc = ContactFileService(session)
    log = await svc.get_log(log_id)
    if log is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Log not found")

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")
    if len(content) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"File is larger than {_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB",
        )

    att = await svc.add_attachment(
        log,
        filename=file.filename or "file",
        content_type=file.content_type or "application/octet-stream",
        content=content,
        user_id=user_id,
    )
    return AttachmentOut.model_validate(att)


@router.get(
    "/attachments/{attachment_id}/download",
    include_in_schema=False,
    summary="Download an attached file",
)
async def download_attachment(
    attachment_id: str, session: SessionDep, _user_id: CurrentUserId
) -> Response:
    svc = ContactFileService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    try:
        content = await svc.read_attachment(att)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment bytes are missing") from e
    return Response(
        content,
        media_type=att.content_type,
        # inline: PDFs and images are the point of attaching them — the browser
        # should show them. RFC 5987 encoding keeps user-supplied names out of
        # the header syntax while preserving Unicode names when the file is saved.
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(att.filename, safe='')}"},
    )


@router.delete(
    "/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove an attached file",
)
async def delete_attachment(
    attachment_id: str, session: SessionDep, _user_id: CurrentUserId
) -> Response:
    svc = ContactFileService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    await svc.delete_attachment(att)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/logs/", response_model=list[LogRowOut], summary="All logs, newest first")
async def list_logs(
    session: SessionDep, _user_id: CurrentUserId, limit: int = Query(default=200, ge=1, le=1000)
) -> list[LogRowOut]:
    svc = ContactFileService(session)
    rows = await svc.list_logs(limit=limit)
    counts = await svc.attachment_counts([log.id for log, _f, _c in rows])
    out: list[LogRowOut] = []
    for log, f, contact in rows:
        name = first = last = prefix = None
        company = mobile = email = None
        if contact is not None:
            first, last = contact.first_name, contact.last_name
            name = " ".join(x for x in (first, last) if x).strip() or contact.company_name
            company = contact.company_name
            mobile = contact.primary_phone
            email = contact.primary_email
            # prefix (Mr/Ms/…) is stashed in the contact's module bucket by the bridge
            for v in (contact.custom_properties or {}).values():
                if isinstance(v, dict) and v.get("prefix"):
                    prefix = v["prefix"]
                    break
        out.append(
            LogRowOut(
                id=log.id,
                log_type=log.log_type,
                category=log.category,
                occurred_at=log.occurred_at,
                description=log.description,
                updates=log.updates,
                follow_up_date=log.follow_up_date,
                follow_up_notes=log.follow_up_notes,
                has_drawing=log.has_drawing,
                attachment_count=counts.get(log.id, 0),
                created_at=log.created_at,
                file_id=f.id,
                file_number=f.file_number,
                stage=f.stage,
                status=f.status,
                subject=f.subject or "",
                site_location=f.site_location,
                city=f.city,
                district=f.district,
                street=f.street,
                country=f.country,
                maps_url=f.maps_url,
                owner=f.owner_user_id,
                contact_id=f.contact_id,
                contact_name=name,
                prefix=prefix,
                first_name=first,
                last_name=last,
                company_name=company,
                mobile=mobile,
                email=email,
            )
        )
    return out
