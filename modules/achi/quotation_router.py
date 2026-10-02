"""Quotation routes, mounted under /api/v1/achi/ by router.py.

Same arrangement as survey_router: its own file to grow in, included into the
module router rather than mounted separately, because the loader only looks for
`router` in router.py.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import HTMLResponse, PlainTextResponse

from app.dependencies import CurrentUserId, SessionDep

from .schemas import (
    QuotationCreate,
    QuotationDraftFromLog,
    QuotationLineOut,
    QuotationOut,
    QuotationUpdate,
)
from .quotation_service import (
    DEFAULT_CONDITIONS,
    QuotationService,
    display_quotation_number,
    to_major,
    to_minor,
)

quotation_router = APIRouter()

_UI_DIR = Path(__file__).parent / "ui"
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}


def _line_out(line) -> QuotationLineOut:
    return QuotationLineOut(
        id=line.id, position=line.position, item=line.item, description=line.description,
        start_date=line.start_date, end_date=line.end_date, unit=line.unit,
        quantity=line.quantity, unit_price=to_major(line.unit_price_minor),
        total=to_major(line.line_total_minor) or "0.00",
    )


def _out(q, lines=None) -> QuotationOut:
    """Row -> wire shape, converting minor units back to decimal strings.

    lines: the quotation's table rows, or None where they are not loaded (lists).
    """
    return QuotationOut(
        id=q.id,
        quotation_number=display_quotation_number(q.quotation_number),
        file_id=q.file_id,
        survey_id=q.survey_id,
        contact_id=q.contact_id,
        customer_name=q.customer_name,
        customer_company=q.customer_company,
        customer_mobile=q.customer_mobile,
        customer_email=q.customer_email,
        site_city=q.site_city,
        site_address=q.site_address,
        area_sqm=q.area_sqm,
        duration_weeks=q.duration_weeks,
        currency=q.currency,
        vat_percent=q.vat_percent,
        rate=to_major(q.rate_minor),
        erection=to_major(q.erection_minor),
        transport=to_major(q.transport_minor),
        extras=to_major(q.extras_minor),
        discount=to_major(q.discount_minor),
        subtotal=to_major(q.subtotal_minor),
        vat=to_major(q.vat_minor),
        total=to_major(q.total_minor),
        scope=q.scope,
        notes=q.notes,
        valid_until=q.valid_until,
        conditions=q.conditions,
        status=q.status,
        created_at=q.created_at,
        lines=None if lines is None else [_line_out(line) for line in lines],
    )


async def _full(svc: QuotationService, q) -> QuotationOut:
    return _out(q, await svc.lines(q.id))


def _estimate_to_columns(data: dict) -> dict:
    """Map the card's decimal strings onto the model's minor-unit columns."""
    out = dict(data)
    for wire, column in (
        ("rate", "rate_minor"), ("erection", "erection_minor"),
        ("transport", "transport_minor"), ("extras", "extras_minor"),
        ("discount", "discount_minor"),
    ):
        if wire in out:
            out[column] = to_minor(out.pop(wire))
    return out


@quotation_router.get(
    "/quotations/ui",
    response_class=HTMLResponse,
    include_in_schema=False,
    summary="Quotations UI",
)
def quotations_ui() -> HTMLResponse:
    return HTMLResponse((_UI_DIR / "quotations.html").read_text(encoding="utf-8"), headers=_NO_STORE)


@quotation_router.get("/quotations/edit", response_class=HTMLResponse, include_in_schema=False)
def quotation_editor_ui() -> HTMLResponse:
    """The quotation editor: ?id=<quotation> opens one, ?file=<enquiry> starts
    one addressed to that enquiry's customer, neither starts a blank one."""
    return HTMLResponse((_UI_DIR / "quotation_editor.html").read_text(encoding="utf-8"), headers=_NO_STORE)


@quotation_router.get("/quotations/editor.js", response_class=PlainTextResponse, include_in_schema=False)
def quotation_editor_js() -> PlainTextResponse:
    return PlainTextResponse(
        (_UI_DIR / "quotation_editor.js").read_text(encoding="utf-8"),
        media_type="application/javascript", headers=_NO_STORE,
    )


@quotation_router.get("/quotations/defaults", summary="Defaults for a new quotation")
async def quotation_defaults(user_id: CurrentUserId) -> dict:
    return {"conditions": DEFAULT_CONDITIONS, "currency": "USD", "vat_percent": "11"}


@quotation_router.get("/quotations/customer", summary="Who a quotation for an enquiry is addressed to")
async def quotation_customer(
    session: SessionDep,
    user_id: CurrentUserId,
    file_id: str = Query(..., max_length=36),
) -> dict:
    """The editor shows this before the first save; the server applies the same
    mapping again on create, so the two cannot drift."""
    customer = await QuotationService(session).customer_from_file(file_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="That enquiry no longer exists")
    return customer


@quotation_router.post(
    "/quotations/",
    response_model=QuotationOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a quotation from the editor",
)
async def create_quotation(payload: QuotationCreate, session: SessionDep, user_id: CurrentUserId) -> QuotationOut:
    svc = QuotationService(session)
    data = _estimate_to_columns(payload.model_dump(exclude_unset=True))
    q = await svc.create_from_editor(data, user_id=user_id)
    if q is None:
        raise HTTPException(status_code=404, detail="That enquiry no longer exists")
    return await _full(svc, q)


@quotation_router.post(
    "/logs/{file_id}/quotation",
    response_model=QuotationOut,
    status_code=status.HTTP_201_CREATED,
    summary="Draft a quotation from a call log row",
)
async def draft_from_log(
    file_id: str,
    payload: QuotationDraftFromLog,
    session: SessionDep,
    user_id: CurrentUserId,
) -> QuotationOut:
    svc = QuotationService(session)
    data = _estimate_to_columns(payload.model_dump(exclude_unset=True))
    q = await svc.draft_from_log(file_id, data, user_id=user_id)
    if q is None:
        # The row is gone — 404 rather than a quotation addressed to nobody.
        raise HTTPException(status_code=404, detail="call log row not found")
    return await _full(svc, q)


@quotation_router.get("/quotations/", response_model=list[QuotationOut], summary="List quotations")
async def list_quotations(
    session: SessionDep,
    user_id: CurrentUserId,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(200, ge=1, le=500),
) -> list[QuotationOut]:
    rows = await QuotationService(session).list(status=status_filter, limit=limit)
    return [_out(q) for q in rows]


@quotation_router.get("/quotations/{quotation_id}", response_model=QuotationOut, summary="Get a quotation")
async def get_quotation(quotation_id: str, session: SessionDep, user_id: CurrentUserId) -> QuotationOut:
    svc = QuotationService(session)
    q = await svc.get(quotation_id)
    if q is None:
        raise HTTPException(status_code=404, detail="quotation not found")
    return await _full(svc, q)


@quotation_router.patch("/quotations/{quotation_id}", response_model=QuotationOut, summary="Update a quotation")
async def update_quotation(
    quotation_id: str,
    payload: QuotationUpdate,
    session: SessionDep,
    user_id: CurrentUserId,
) -> QuotationOut:
    svc = QuotationService(session)
    q = await svc.get(quotation_id)
    if q is None:
        raise HTTPException(status_code=404, detail="quotation not found")
    return await _full(svc, await svc.update(q, _estimate_to_columns(payload.model_dump(exclude_unset=True))))


@quotation_router.delete(
    "/quotations/{quotation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a quotation",
)
async def delete_quotation(quotation_id: str, session: SessionDep, user_id: CurrentUserId) -> None:
    svc = QuotationService(session)
    q = await svc.get(quotation_id)
    if q is None:
        raise HTTPException(status_code=404, detail="quotation not found")
    await svc.delete(q)
