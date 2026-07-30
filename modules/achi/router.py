"""Auto-mounted at /api/v1/achi/ by the module loader — no registration needed."""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response

from app.dependencies import CurrentUserId, OptionalUserPayload, RequireRole, SessionDep, SettingsDep
from app.modules.users.models import User

from . import access

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
from .quotation_router import quotation_router
from .survey_router import survey_router
from .geo_router import geo_router
from .chat_router import chat_router
from .comment_router import comment_router

logger = logging.getLogger(__name__)

router = APIRouter()

# Site survey lives in its own file; the loader only looks for `router` here.
router.include_router(survey_router)
router.include_router(quotation_router)
router.include_router(geo_router)
router.include_router(chat_router)
router.include_router(comment_router)

_UI_DIR = Path(__file__).parent / "ui"

# Coordinate shapes a resolved Google Maps URL can carry. @lat,lng is the map
# centre; !3d..!4d.. is the pinned place; q=/ll=/search/ are query forms.
# The comma may be followed by a literal "+" (Google writes /search/lat,+lng).
_MAPS_COORD_PATS = [
    re.compile(r"@(-?\d+\.\d+),\+?(-?\d+\.\d+)"),
    re.compile(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)"),
    re.compile(r"[?&]q=(-?\d+\.\d+),\+?(-?\d+\.\d+)"),
    re.compile(r"[?&]ll=(-?\d+\.\d+),\+?(-?\d+\.\d+)"),
    re.compile(r"/search/(-?\d+\.\d+),\+?(-?\d+\.\d+)"),
]


def _is_google_maps_url(url: str) -> bool:
    """Only Google Maps hosts, so this endpoint can't be turned into an open
    fetcher (SSRF). Checked on the input AND the final hop after redirects."""
    try:
        p = urlparse(url)
    except ValueError:
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = (p.hostname or "").lower()
    return (
        host in {"maps.app.goo.gl", "goo.gl", "google.com", "maps.google.com"}
        or host.endswith(".google.com")
    )


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


@router.get(
    "/ui/chrome.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Sidebar and top bar for our own pages",
)
def ui_chrome_js() -> PlainTextResponse:
    """The app furniture our pages wear.

    Served beside them rather than duplicated into each, so the sidebar cannot
    drift between Call Log and Site Survey. Unauthenticated for the same reason
    as the pages themselves: it is inert markup with no data in it.
    """
    return PlainTextResponse(
        (_UI_DIR / "chrome.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@router.get(
    "/ui/comment.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Tester Comment panel for our own pages",
)
def ui_comment_js() -> PlainTextResponse:
    """Serve the tester Comment panel script."""
    return PlainTextResponse(
        (_UI_DIR / "comment.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@router.get(
    "/ui/model-viewer.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Vendored <model-viewer> for RVT/IFC 3D preview",
)
def ui_model_viewer_js() -> PlainTextResponse:
    """Google's <model-viewer> (BSD-3), vendored so it is same-origin (OCE's CSP
    blocks third-party scripts) and self-contained (no CDN/WASM fetch for the
    plain glTF our pipeline produces). Loaded lazily by log.html only when a user
    opens an RVT/IFC attachment, and cached hard — it is a large, stable asset."""
    return PlainTextResponse(
        (_UI_DIR / "model-viewer.min.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/ui/pdf.min.mjs", response_class=PlainTextResponse, include_in_schema=False, summary="Vendored pdf.js")
def ui_pdfjs() -> PlainTextResponse:
    """pdf.js (Apache-2.0), vendored same-origin, for the PDF first-page preview.
    Loaded lazily only when a PDF card comes into view."""
    return PlainTextResponse(
        (_UI_DIR / "pdf.min.mjs").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/ui/pdf.worker.min.mjs", response_class=PlainTextResponse, include_in_schema=False, summary="pdf.js worker")
def ui_pdfjs_worker() -> PlainTextResponse:
    return PlainTextResponse(
        (_UI_DIR / "pdf.worker.min.mjs").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/tile/{z}/{x}/{y}", include_in_schema=False, summary="OSM map tile proxy")
async def map_tile(z: int, x: int, y: int):
    """Proxy an OpenStreetMap tile.

    OSM's tile policy now blocks browser <img> hotlinking (no Referer / generic
    UA). Fetching server-side with an identifying User-Agent is what the policy
    actually asks for, and it makes the tiles same-origin so no referrer/CORS
    games are needed. Cached hard in the browser so a preview is a handful of
    fetches, not a stream — this is light, occasional use, which the policy
    allows. If map usage ever grows, move to a keyed provider (MapTiler/Carto).
    """
    n = 1 << z
    if not (0 <= z <= 19 and 0 <= x < n and 0 <= y < n):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tile out of range")
    src = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    try:
        async with httpx.AsyncClient(
            timeout=6.0,
            headers={"User-Agent": "ACHI-Scaffolding-ERP/1.0 (+https://ararahx.net; site maps)"},
        ) as client:
            resp = await client.get(src)
    except httpx.HTTPError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not reach the tile server")
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Tile server returned an error")
    return Response(
        content=resp.content,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=604800"},  # 7 days
    )


@router.get(
    "/resolve-maps",
    include_in_schema=False,
    summary="Coordinates for a Google Maps share link",
)
async def resolve_maps(url: str = Query(..., max_length=2048)):
    """Follow a Google Maps link and return coordinates plus its address.

    Short share links (maps.app.goo.gl) — what the Share button gives you — carry
    no coordinates until followed, and the browser can't follow them (CORS). This
    does it server-side. Coordinates are reverse-geocoded best-effort; preview
    still works if the address service is temporarily unavailable.
    """
    if not _is_google_maps_url(url):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a Google Maps link")
    hay = url
    match = next((m for pat in _MAPS_COORD_PATS if (m := pat.search(hay))), None)
    if match is None:
        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                max_redirects=6,
                timeout=6.0,
                headers={"User-Agent": "Mozilla/5.0 (compatible; ACHI/1.0)"},
            ) as client:
                resp = await client.get(url)
        except httpx.HTTPError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not reach Google Maps")
        if not _is_google_maps_url(str(resp.url)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Link redirected off Google")
        hay = f"{resp.url}\n{resp.text[:40000]}"
        match = next((m for pat in _MAPS_COORD_PATS if (m := pat.search(hay))), None)
    if match is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No coordinates found for this link")

    lat, lng = float(match.group(1)), float(match.group(2))
    result = {"lat": lat, "lng": lng}
    try:
        async with httpx.AsyncClient(
            timeout=6.0,
            headers={"User-Agent": "ACHI-Scaffolding-ERP/1.0 (+https://ararahx.net; address lookup)"},
        ) as client:
            reverse = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "format": "jsonv2",
                    "lat": lat,
                    "lon": lng,
                    "zoom": 18,
                    "addressdetails": 1,
                    "layer": "address",
                    "accept-language": "en",
                },
            )
            reverse.raise_for_status()
            place = reverse.json()
        address = place.get("address") or {}
        result.update(
            country=address.get("country"),
            district=next(
                (
                    address.get(key)
                    for key in ("state_district", "county", "state", "region")
                    if address.get(key)
                ),
                None,
            ),
            city=next(
                (
                    address.get(key)
                    for key in ("city", "town", "village", "municipality", "suburb")
                    if address.get(key)
                ),
                None,
            ),
            street=next(
                (
                    address.get(key)
                    for key in ("road", "pedestrian", "residential", "path")
                    if address.get(key)
                ),
                None,
            ),
        )
    except (httpx.HTTPError, ValueError):
        pass
    return result


@router.get(
    "/ui/grid.css",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Shared grid stylesheet",
)
def ui_grid_css() -> PlainTextResponse:
    """The grid's look, served once instead of pasted into every page.

    Inert styling with no data in it, so unauthenticated for the same reason as
    the pages themselves.
    """
    return PlainTextResponse(
        (_UI_DIR / "grid.css").read_text(encoding="utf-8"),
        media_type="text/css",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@router.get(
    "/ui/quill.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Quill rich-text editor (vendored)",
)
def ui_quill_js() -> PlainTextResponse:
    """Quill 2.0.3 JS served locally so it clears the app's script-src CSP."""
    return PlainTextResponse(
        (_UI_DIR / "quill.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get(
    "/ui/quill.snow.css",
    response_class=PlainTextResponse,
    include_in_schema=False,
    summary="Quill Snow theme (vendored)",
)
def ui_quill_snow_css() -> PlainTextResponse:
    """Quill 2.0.3 Snow CSS served locally so it clears the app's style-src CSP."""
    return PlainTextResponse(
        (_UI_DIR / "quill.snow.css").read_text(encoding="utf-8"),
        media_type="text/css",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
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
    # No contact when the row had no phone/email — fall back to what was typed.
    o.contact_name = (await svc.name_for(f.contact_id)) if f.contact_id else (
        " ".join(x for x in (f.lead_first_name, f.lead_last_name) if x).strip() or f.lead_company or None)
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
        company_contact_id=r.get("company_contact_id"),
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


@router.delete("/logs/{log_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a log entry")
async def delete_log(log_id: str, session: SessionDep, _user_id: CurrentUserId) -> Response:
    svc = ContactFileService(session)
    log = await svc.get_log(log_id)
    if log is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Log not found")
    await svc.delete_log(log)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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

# Per-type caps. Ordinary attachments (scans, site photos, docs) stay small so a
# mis-drop cannot fill the disk. CAD/BIM models are legitimately large — a real
# Revit model is tens to a couple hundred MB — so they get a much higher cap, but
# still bounded (and below bim_render's 300 MB 3D-conversion limit). Enforced on
# real bytes read, streamed in chunks so an oversized upload is rejected without
# ever being buffered whole.
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
_MAX_CAD_ATTACHMENT_BYTES = 250 * 1024 * 1024
_CAD_ATTACHMENT_EXTS = ("dwg", "dxf", "rvt", "ifc", "dgn")


def _attachment_cap(filename: str) -> int:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    return _MAX_CAD_ATTACHMENT_BYTES if ext in _CAD_ATTACHMENT_EXTS else _MAX_ATTACHMENT_BYTES


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

    cap = _attachment_cap(file.filename or "")
    # Read in chunks and abort the moment the cap is exceeded, so an oversized
    # upload never gets buffered whole in memory (it was already spooled to a
    # temp file by the multipart parser; this bounds only the in-RAM bytes).
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                f"File is larger than {cap // (1024 * 1024)} MB",
            )
        chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")

    att = await svc.add_attachment(
        log,
        filename=file.filename or "file",
        content_type=file.content_type or "application/octet-stream",
        content=content,
        user_id=user_id,
    )
    return AttachmentOut.model_validate(att)


def _require_valid_token(request: Request, settings) -> None:
    """Accept the caller's JWT from the bearer header OR a ``?token=`` query
    param, and 401 if neither is valid. The query form is for browser contexts
    that can't set an Authorization header — an <img>/<embed> src, a new-tab
    open, or a viewer that fetches the URL itself. Same approach OCE's BIM
    viewer uses; the token is the caller's own."""
    from app.dependencies import decode_access_token

    token = request.query_params.get("token") or ""
    if not token:
        auth = request.headers.get("authorization", "")
        if auth[:7].lower() == "bearer ":
            token = auth[7:]
    try:
        decode_access_token(token, settings)
    except Exception as e:  # noqa: BLE001 - any decode failure = unauthenticated
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated") from e


@router.get(
    "/attachments/{attachment_id}/download",
    include_in_schema=False,
    summary="Download an attached file",
)
async def download_attachment(
    attachment_id: str, request: Request, session: SessionDep, settings: SettingsDep
) -> Response:
    # Token via header OR ?token= so the same URL works as an <img>/PDF src and
    # in a new tab, not just an authenticated fetch.
    _require_valid_token(request, settings)
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


@router.get(
    "/attachments/{attachment_id}/render",
    include_in_schema=False,
    summary="Render a DXF/DWG attachment to SVG for preview",
)
async def render_attachment(
    attachment_id: str, session: SessionDep, _user_id: CurrentUserId
) -> Response:
    """Return an inline SVG preview of a CAD attachment.

    DXF renders directly with ezdxf; DWG is converted with OpenConstructionERP's
    own DDC converter (installed via the Takeoff UI) and its geometry drawn to
    SVG. On anything the renderer cannot handle it returns 415, and the browser
    falls back to download-to-open.
    """
    from .cad_render import CadRenderError, render_cad_to_svg

    svc = ContactFileService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    try:
        content = await svc.read_attachment(att)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment bytes are missing") from e
    try:
        svg_str = await render_cad_to_svg(content, att.filename)
    except CadRenderError as e:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(e)) from e
    return Response(
        svg_str,
        media_type="image/svg+xml",
        headers={"Cache-Control": "private, max-age=3600"},
    )


# --- RVT/IFC 3D preview (glTF via OCE's BIM pipeline) -------------------------
# Converting a Revit model is slow, so it runs as a background job and the .glb
# is cached by attachment id. The front-end: POST prepare -> poll status -> when
# ready, fetch model.glb (with the bearer) and render it with three.js.
_glb_jobs: dict[str, str] = {}   # attachment_id -> "processing" | "error:<msg>"
_glb_tasks: set[asyncio.Task] = set()   # keep task refs so they aren't GC'd mid-run


@router.post("/attachments/{attachment_id}/model/prepare", include_in_schema=False)
async def prepare_model(attachment_id: str, session: SessionDep, _user_id: CurrentUserId):
    """Kick off (or report) conversion of an RVT/IFC attachment to glTF."""
    from .bim_render import BimRenderError, build_glb_sync, cached_glb, is_3d_model

    svc = ContactFileService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    if not is_3d_model(att.filename):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Not a 3D model")
    if cached_glb(attachment_id) is not None:
        return {"status": "ready"}
    if _glb_jobs.get(attachment_id) == "processing":
        return {"status": "processing"}
    try:
        content = await svc.read_attachment(att)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment bytes are missing") from e

    _glb_jobs[attachment_id] = "processing"

    async def _job(aid: str, data: bytes, name: str) -> None:
        try:
            await asyncio.to_thread(build_glb_sync, aid, data, name)
            _glb_jobs.pop(aid, None)                      # cache file is now the ready signal
        except BimRenderError as e:
            _glb_jobs[aid] = f"error:{e}"
        except Exception:  # noqa: BLE001
            logger.warning("3D model build failed for %s", aid, exc_info=True)
            _glb_jobs[aid] = "error:Could not build the 3D model"

    task = asyncio.create_task(_job(attachment_id, content, att.filename))
    _glb_tasks.add(task)
    task.add_done_callback(_glb_tasks.discard)
    return {"status": "processing"}


@router.get("/attachments/{attachment_id}/model/status", include_in_schema=False)
async def model_status(attachment_id: str, _user_id: CurrentUserId):
    from .bim_render import cached_glb

    if cached_glb(attachment_id) is not None:
        return {"status": "ready"}
    st = _glb_jobs.get(attachment_id)
    if st == "processing":
        return {"status": "processing"}
    if st and st.startswith("error:"):
        return {"status": "error", "error": st[len("error:"):]}
    return {"status": "idle"}


@router.get("/attachments/{attachment_id}/model.glb", include_in_schema=False)
async def model_glb(attachment_id: str, request: Request, settings: SettingsDep) -> Response:
    """Serve the converted glTF for <model-viewer>.

    Auth is via the bearer header OR a ``?token=`` query param: the viewer sets
    the element's ``src`` to this URL and loads it internally, and neither
    <model-viewer> nor three.js can attach an Authorization header (and a blob:
    URL is blocked by the page's connect-src CSP). Same approach OCE's own BIM
    viewer uses. The token is the caller's own JWT.
    """
    from .bim_render import cached_glb

    _require_valid_token(request, settings)
    p = cached_glb(attachment_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "3D model not ready")
    return FileResponse(
        str(p),
        media_type="model/gltf-binary",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# --- Open an attachment in OCE's editors (DWG rulers / PDF measure / BIM 3D) ---
def _takeoff_url(kind: str, external_id: str, project_id: str) -> str:
    if kind == "dwg":
        # The DWG-Takeoff page reads the drawing from ?drawingId (camelCase) and
        # its project from the active-project context; project_id is passed too so
        # the shell can select the right project.
        return f"/dwg-takeoff?project_id={project_id}&drawingId={external_id}"
    if kind == "bim":
        return f"/bim/{external_id}"                      # 3D BIM viewer, by model id
    return f"/takeoff?doc={external_id}&tab=measurements"


async def _ensure_call_log_project(session, settings, user_id: str):
    """Find-or-create the caller's 'Call Log Drawings' project (DWG and BIM both
    need a project). Returns (project_id_str, project_uuid)."""
    import uuid as _uuid

    from app.modules.projects.schemas import ProjectCreate
    from app.modules.projects.service import ProjectService

    owner = _uuid.UUID(str(user_id))
    psvc = ProjectService(session, settings)
    projects, _ = await psvc.list_projects(owner, limit=500)
    proj = next((p for p in projects if p.name == "Call Log Drawings"), None)
    if proj is None:
        proj = await psvc.create_project(ProjectCreate(name="Call Log Drawings"), owner)
    return str(proj.id), proj.id


@router.post("/attachments/{attachment_id}/takeoff", include_in_schema=False)
async def open_in_takeoff(
    attachment_id: str,
    session: SessionDep,
    settings: SettingsDep,
    user_id: CurrentUserId,
    background_tasks: BackgroundTasks,
):
    """Hand an attachment to OCE's own editor and return the URL: DWG/DXF -> DWG
    Takeoff, PDF -> PDF Takeoff, RVT/IFC -> 3D BIM viewer. The uploaded artifact is
    cached per attachment so repeat opens reuse it (no re-upload / re-convert)."""
    import io

    from sqlalchemy import select as _select

    from .models import AchiTakeoffLink

    svc = ContactFileService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    ext = att.filename.rsplit(".", 1)[-1].lower() if "." in att.filename else ""
    if ext in ("dwg", "dxf"):
        kind = "dwg"
    elif ext == "pdf":
        kind = "pdf"
    elif ext in ("rvt", "ifc"):
        kind = "bim"
    else:
        kind = ""
    if not kind:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "No editor for this file type")

    cached = (
        await session.execute(
            _select(AchiTakeoffLink).where(
                AchiTakeoffLink.attachment_id == attachment_id, AchiTakeoffLink.kind == kind
            )
        )
    ).scalar_one_or_none()
    if cached is not None:
        return {"url": _takeoff_url(kind, cached.external_id, cached.project_id), "project_id": cached.project_id, "kind": kind}

    try:
        content = await svc.read_attachment(att)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment bytes are missing") from e

    try:
        from starlette.datastructures import UploadFile as _UploadFile

        if kind == "dwg":
            from app.modules.dwg_takeoff.service import DwgTakeoffService

            # Capture the id BEFORE the upload commits (a commit expires the ORM
            # object and a later read would sync-reload inside the async session).
            pid, proj_uuid = await _ensure_call_log_project(session, settings, user_id)
            uf = _UploadFile(io.BytesIO(content), size=len(content), filename=att.filename)
            drawing = await DwgTakeoffService(session).upload_drawing(proj_uuid, uf, str(user_id), name=att.filename)
            ext_id = str(drawing.id)
        elif kind == "bim":
            from app.modules.bim_hub.router import upload_cad_file
            from app.modules.bim_hub.service import BIMHubService

            pid, _proj_uuid = await _ensure_call_log_project(session, settings, user_id)
            uf = _UploadFile(io.BytesIO(content), size=len(content), filename=att.filename)
            # Reuse bim_hub's own upload handler (streams, validates, creates the
            # BIMModel, schedules conversion) — passing OUR background_tasks so the
            # heavy convert runs after this response, not blocking it.
            result = await upload_cad_file(
                background_tasks=background_tasks,
                project_id=pid,
                name=att.filename,
                discipline="architecture",
                conversion_depth="standard",
                file=uf,
                user_id=str(user_id),
                _perm=None,
                service=BIMHubService(session),
            )
            ext_id = str(result["model_id"])
        else:  # pdf
            from app.modules.takeoff.service import TakeoffService

            doc = await TakeoffService(session).upload_document(
                filename=att.filename, content=content, size_bytes=len(content), owner_id=str(user_id)
            )
            ext_id, pid = str(doc.id), ""
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("open_in_takeoff failed for %s", attachment_id, exc_info=True)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not open this file in the editor") from e

    session.add(AchiTakeoffLink(attachment_id=attachment_id, kind=kind, external_id=ext_id, project_id=pid))
    await session.commit()
    return {"url": _takeoff_url(kind, ext_id, pid), "project_id": pid, "kind": kind}


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


@router.get(
    "/contacts/{contact_id}/links",
    summary="Everything linked to one contact, across ACHI and CRM",
    description=(
        "Read-only view of the shared contact. ACHI files match exactly on "
        "contact_id; CRM opportunities on primary_contact_id; CRM leads only by "
        "email, because oe_crm_lead stores no contact id. Returns crm_available "
        "false when the CRM module is disabled rather than failing."
    ),
)
async def contact_links(contact_id: str, session: SessionDep, _user_id: CurrentUserId) -> dict:
    links = await ContactFileService(session).contact_links(contact_id)
    if not links:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Contact not found")
    return links


@router.get("/logs/", response_model=list[LogRowOut], summary="All logs, newest first")
async def list_logs(
    session: SessionDep, _user_id: CurrentUserId, limit: int = Query(default=200, ge=1, le=1000)
) -> list[LogRowOut]:
    svc = ContactFileService(session)
    rows = await svc.list_logs(limit=limit)
    # index rather than unpack: list_logs' tuple width changes when a column is
    # added to its select (owner name was the last one), and a positional unpack
    # here breaks the endpoint when it does
    counts = await svc.attachment_counts([r[0].id for r in rows])
    out: list[LogRowOut] = []
    for log, f, contact, owner_name in rows:
        # A row only has a Contact when a phone or email was given. Without one the
        # identity lives on the file exactly as it was typed, so fall back to that
        # rather than showing a blank row.
        first = last = prefix = None
        company = mobile = email = None
        if contact is not None:
            first, last = contact.first_name, contact.last_name
            company = contact.company_name
            mobile = contact.primary_phone
            email = contact.primary_email
            # prefix (Mr/Ms/…) is stashed in the contact's module bucket by the bridge
            for v in (contact.custom_properties or {}).values():
                if isinstance(v, dict) and v.get("prefix"):
                    prefix = v["prefix"]
                    break
        first = first or f.lead_first_name
        last = last or f.lead_last_name
        prefix = prefix or f.lead_prefix
        company = company or f.lead_company
        mobile = mobile or f.lead_mobile
        email = email or f.lead_email
        name = " ".join(x for x in (first, last) if x).strip() or company
        out.append(
            LogRowOut(
                id=log.id,
                log_type=log.log_type,
                category=log.category,
                reference=log.reference,
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
                role=f.lead_role,
                company_type=f.lead_company_type,
                socials=f.lead_socials,
                site_location=f.site_location,
                city=f.city,
                district=f.district,
                street=f.street,
                country=f.country,
                maps_url=f.maps_url,
                site_number=f.site_number,
                site_building=f.site_building,
                site_floor=f.site_floor,
                owner=f.owner_user_id,
                owner_name=owner_name,
                contact_id=f.contact_id,
                company_contact_id=f.company_contact_id,
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


# --- Access control: limit new users to the ACHI pages -----------------------
# See modules/achi/access.py for the rule. These endpoints are the enforcement
# gate (authz, called by the reverse proxy) plus admin management.

@router.get("/authz", include_in_schema=False)
async def authz(
    request: Request,
    session: SessionDep,
    payload: OptionalUserPayload = None,
):
    """Reverse-proxy forward-auth check. 200 = allow, 403 = deny.

    The proxy (Caddy forward_auth) copies the original request's path into a
    header; we read it and decide based on who is asking. An unidentifiable
    request (no/expired token — e.g. a bare page navigation) is allowed through:
    the page's own data calls carry the token and are judged individually, and
    OCE's auth already 401s unauthenticated API calls.
    """
    target = (
        request.headers.get("x-forwarded-uri")
        or request.headers.get("x-original-uri")
        or request.query_params.get("uri", "")
    )
    try:
        # Off until an admin seeds the grandfather list — so shipping the gate is
        # inert until deliberately switched on, and no current user is caught out.
        if not await access.enforcement_active(session):
            return PlainTextResponse("", status_code=200)
        if not payload:
            return PlainTextResponse("", status_code=200)
        user_id = payload.get("sub")
        user = await session.get(User, user_id) if user_id else None
        role = user.role if user else ""
        if await access.has_full_access(session, user_id, role):
            return PlainTextResponse("", status_code=200)
        ok = access.limited_path_allowed(target)
        return PlainTextResponse("", status_code=200 if ok else 403)
    except Exception:  # noqa: BLE001
        # FAIL OPEN. The proxy denies on any non-2xx, so a bug here would lock
        # every user out of the whole API. This is a soft page-limit, not a
        # secrets boundary (data stays behind normal auth), so an authz fault
        # must never become a site-wide outage.
        logger.warning("achi authz check failed; allowing through", exc_info=True)
        return PlainTextResponse("", status_code=200)


@router.get("/access/me")
async def access_me(session: SessionDep, payload: OptionalUserPayload = None):
    """What the current user is allowed — read by the front-end (chrome.js /
    achi-nav.js) to hide OCE links and land limited users on Call Log.

    Not admin-gated: a user may always ask about themselves. Unidentifiable
    callers are treated as full-access so nothing is hidden pre-login.
    """
    enforced = await access.enforcement_active(session)
    if not payload:
        return {"full_access": True, "enforced": enforced}
    user_id = payload.get("sub")
    user = await session.get(User, user_id) if user_id else None
    role = user.role if user else ""
    full = await access.has_full_access(session, user_id, role)
    return {"full_access": full, "enforced": enforced}


@router.post("/access/seed-current", dependencies=[Depends(RequireRole("admin"))])
async def access_seed_current(session: SessionDep):
    """Grandfather every currently-active user into full access. Idempotent."""
    added = await access.seed_current_users(session)
    return {"added": added}


@router.get("/access/", dependencies=[Depends(RequireRole("admin"))])
async def access_list(session: SessionDep):
    rows = await access.list_full_access(session)
    return [{"user_id": r.user_id, "note": r.note} for r in rows]


@router.post("/access/{user_id}", dependencies=[Depends(RequireRole("admin"))])
async def access_grant(user_id: str, session: SessionDep):
    await access.grant(session, user_id, note="granted by admin")
    return {"ok": True}


@router.delete("/access/{user_id}", dependencies=[Depends(RequireRole("admin"))])
async def access_revoke(user_id: str, session: SessionDep):
    removed = await access.revoke(session, user_id)
    return {"removed": removed}
