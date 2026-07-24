"""Site survey routes, mounted under /api/v1/achi/ by router.py.

Split out of router.py so the survey has its own file to grow in; it is included
into the module router rather than mounted separately, because the loader only
looks for `router` in router.py.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from fastapi.responses import HTMLResponse, Response

from app.dependencies import CurrentUserId, SessionDep

from .schemas import (
    SurveyAttachmentOut,
    SurveyCreate,
    SurveyOut,
    SurveyRowOut,
    SurveyUpdate,
)
from .survey_service import SiteSurveyService

survey_router = APIRouter()

_UI_DIR = Path(__file__).parent / "ui"

# Site photos are the point of the survey, and phone cameras are not small.
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024


@survey_router.get(
    "/survey/ui",
    response_class=HTMLResponse,
    include_in_schema=False,
    summary="Site Survey UI",
)
def survey_ui(id: str | None = Query(default=None, description="Open one survey in the form")) -> HTMLResponse:
    """Site Survey. The table by default; the step-by-step form for one survey.

    Serving the table from this URL — not only from /surveys/table — is
    deliberate. achi-nav.js is cached CacheFirst by a service worker, so a
    browser can hold an old copy whose Site Survey entry still points here. If
    this route served the form, that stale nav would keep showing the form no
    matter what the sidebar was changed to. Answering with the table means the
    sidebar lands on it whichever nav version the browser is running.

    ``?id=`` still opens the form for that survey, which is how the table's
    survey-number link hands a row over to the on-site view.
    """
    page = "survey.html" if id else "survey_table.html"
    return HTMLResponse(
        (_UI_DIR / page).read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@survey_router.get("/surveys/table", response_class=HTMLResponse, include_in_schema=False,
                   summary="Site Survey table")
def survey_table_ui() -> HTMLResponse:
    """The surveys as a grid, beside the step-by-step form.

    The form at /survey/ui is built for a phone on site; this is the same records
    as a Call Log-style table for working through them at a desk. Both read the
    same rows — neither is a copy of the other's data.
    """
    return HTMLResponse(
        (_UI_DIR / "survey_table.html").read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@survey_router.get("/surveys/", response_model=list[SurveyRowOut], summary="Surveys, newest first")
async def list_surveys(
    session: SessionDep,
    _user_id: CurrentUserId,
    status_: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[SurveyRowOut]:
    svc = SiteSurveyService(session)
    rows = await svc.list(status=status_, limit=limit)
    counts = await svc.photo_counts([r.id for r in rows])
    out = []
    for r in rows:
        o = SurveyRowOut.model_validate(r)
        o.photo_count = counts.get(r.id, 0)
        out.append(o)
    return out


@survey_router.post(
    "/surveys/",
    response_model=SurveyOut,
    status_code=status.HTTP_201_CREATED,
    summary="Raise a survey",
)
async def create_survey(data: SurveyCreate, session: SessionDep, user_id: CurrentUserId) -> SurveyOut:
    return SurveyOut.model_validate(await SiteSurveyService(session).create(data, user_id=user_id))


@survey_router.get("/surveys/{survey_id}", response_model=SurveyOut, summary="One survey")
async def get_survey(survey_id: str, session: SessionDep, _user_id: CurrentUserId) -> SurveyOut:
    s = await SiteSurveyService(session).get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    return SurveyOut.model_validate(s)


@survey_router.patch("/surveys/{survey_id}", response_model=SurveyOut, summary="Update a survey")
async def update_survey(
    survey_id: str, data: SurveyUpdate, session: SessionDep, _user_id: CurrentUserId
) -> SurveyOut:
    svc = SiteSurveyService(session)
    s = await svc.get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    return SurveyOut.model_validate(await svc.update(s, data))


@survey_router.post("/surveys/{survey_id}/arrive", response_model=SurveyOut, summary="I'm on site")
async def arrive(survey_id: str, session: SessionDep, _user_id: CurrentUserId) -> SurveyOut:
    """One tap on a phone: stamps the arrival time and moves it to on_site."""
    svc = SiteSurveyService(session)
    s = await svc.get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    return SurveyOut.model_validate(await svc.arrive(s))


@survey_router.delete(
    "/surveys/{survey_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a survey"
)
async def delete_survey(survey_id: str, session: SessionDep, _user_id: CurrentUserId) -> Response:
    svc = SiteSurveyService(session)
    s = await svc.get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    await svc.delete(s)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@survey_router.get("/surveys/{survey_id}/drawing", summary="The survey's sketch (canvas JSON)")
async def get_survey_drawing(survey_id: str, session: SessionDep, _user_id: CurrentUserId) -> dict:
    """Fetched only when the sketch is opened — the blob is unbounded and the list
    has no use for it (it carries has_drawing instead)."""
    s = await SiteSurveyService(session).get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    return {"drawing": s.drawing or "", "has_drawing": s.has_drawing}


# ── photos and documents ──────────────────────────────────────────────────


@survey_router.get(
    "/surveys/{survey_id}/attachments",
    response_model=list[SurveyAttachmentOut],
    summary="Photos and documents on a survey",
)
async def list_survey_attachments(
    survey_id: str, session: SessionDep, _user_id: CurrentUserId
) -> list[SurveyAttachmentOut]:
    svc = SiteSurveyService(session)
    if await svc.get(survey_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")
    return [SurveyAttachmentOut.model_validate(a) for a in await svc.list_attachments(survey_id)]


@survey_router.post(
    "/surveys/{survey_id}/attachments",
    response_model=SurveyAttachmentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Attach a photo or document",
)
async def add_survey_attachment(
    survey_id: str,
    session: SessionDep,
    user_id: CurrentUserId,
    file: UploadFile = File(...),
) -> SurveyAttachmentOut:
    svc = SiteSurveyService(session)
    s = await svc.get(survey_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Survey not found")

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")
    if len(content) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"File is larger than {_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB",
        )
    att = await svc.add_attachment(
        s,
        filename=file.filename or "file",
        content_type=file.content_type or "application/octet-stream",
        content=content,
        user_id=user_id,
    )
    return SurveyAttachmentOut.model_validate(att)


@survey_router.get(
    "/survey-attachments/{attachment_id}/download",
    include_in_schema=False,
    summary="Download a survey photo or document",
)
async def download_survey_attachment(
    attachment_id: str, session: SessionDep, _user_id: CurrentUserId
) -> Response:
    svc = SiteSurveyService(session)
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
        # inline: photos and PDFs are meant to be looked at, not downloaded.
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(att.filename, safe='')}"},
    )


@survey_router.delete(
    "/survey-attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a survey photo or document",
)
async def delete_survey_attachment(
    attachment_id: str, session: SessionDep, _user_id: CurrentUserId
) -> Response:
    svc = SiteSurveyService(session)
    att = await svc.get_attachment(attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    await svc.delete_attachment(att)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
