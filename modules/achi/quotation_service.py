"""Business logic for customer quotations.

Sales-side, and therefore ours: OCE's rfq_bidding / bid_management / tendering
all model us soliciting bids, not us issuing a price. See models.Quotation.

Money is handled in minor units (integers) end to end. The only place a decimal
appears is the boundary with the UI, and it is converted there — a float that
travels through the totals accumulates error across exactly the number the
customer was told.
"""

from __future__ import annotations

import logging
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ContactFile, Quotation, QuotationLine

logger = logging.getLogger(__name__)


def to_minor(value) -> int | None:
    """Decimal-ish input -> integer minor units. None stays None.

    Decimal, not float: 19.99 is not representable in binary floating point, and
    quantising the float has already lost the cent before we round it.
    """
    if value is None or value == "":
        return None
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError, TypeError):
        return None


def to_major(minor: int | None) -> str | None:
    """Minor units -> a string the UI can show without reintroducing a float."""
    if minor is None:
        return None
    return f"{Decimal(minor) / 100:.2f}"


def _num(value) -> Decimal:
    try:
        return Decimal(str(value)) if value not in (None, "") else Decimal(0)
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(0)


# Money columns are 32-bit integers of minor units; past this a save would fail
# in the database, so it is refused up front with a message a person can act on.
MAX_MINOR = 2_000_000_000


def line_total(quantity, unit_price_minor: int | None) -> int:
    """quantity x price per unit, in minor units, rounded half up like a till."""
    total = (_num(quantity) * Decimal(unit_price_minor or 0)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(total)


def compute_totals(data: dict, line_totals: list[int] | None = None) -> tuple[int, int, int]:
    """(subtotal, vat, total) in minor units.

    With table lines, the subtotal is their sum. Without, it is the quick
    estimate: area x weeks x rate plus the named additions. Either way, less
    discount, then VAT on the result. Kept in one function because the Log's
    quick card, the editor and the stored quotation must never disagree about
    what a number means.
    """
    if line_totals:
        work = Decimal(sum(line_totals))
    else:
        area = _num(data.get("area_sqm"))
        weeks = _num(data.get("duration_weeks"))
        rate = Decimal(data.get("rate_minor") or 0)
        hire = (area * weeks * rate).quantize(Decimal("1"))
        work = hire + Decimal(data.get("erection_minor") or 0) \
                    + Decimal(data.get("transport_minor") or 0) \
                    + Decimal(data.get("extras_minor") or 0)
    subtotal = work - Decimal(data.get("discount_minor") or 0)
    if subtotal < 0:
        subtotal = Decimal(0)   # a discount larger than the work is a typo, not a credit

    vat_pct = _num(data.get("vat_percent"))
    vat = (subtotal * vat_pct / 100).quantize(Decimal("1"))
    return int(subtotal), int(vat), int(subtotal + vat)


def display_quotation_number(value: str | None) -> str:
    """Quotation numbers are "QUO-NNNNN". Ones drafted before that format were
    stored as "ACHI-QT-YYYY-NNNNN"; they show as "QUO-NNNNN" (stored value untouched)."""
    raw = str(value or "")
    if raw.startswith("ACHI-QT-"):
        return f"QUO-{raw.rsplit('-', 1)[-1]}"
    return raw


async def _next_quotation_number(session: AsyncSession) -> str:
    """QUO-NNNNN, one running sequence (MAX+1, like site visits).

    Continues after the highest of both the new and the old ACHI-QT-YYYY-NNNNN
    numbers, so no two quotations ever show the same code.
    """
    rows = await session.execute(
        select(Quotation.quotation_number).where(
            Quotation.quotation_number.like("QUO-%") | Quotation.quotation_number.like("ACHI-QT-%")
        )
    )
    highest = 0
    for number in rows.scalars().all():
        tail = str(number).rsplit("-", 1)[-1]
        if tail.isdigit():
            highest = max(highest, int(tail))
    return f"QUO-{highest + 1:05d}"


# Prefilled on page 2 of a new quotation; the person edits it per quotation.
DEFAULT_CONDITIONS = """1. Validity: this quotation is valid for 30 days from its date.
2. Payment: 50% advance on order confirmation, balance on completion of erection. Hire beyond the quoted period is invoiced monthly in advance.
3. Hire period: charged from the day erection is completed until the day the client releases the scaffold for dismantling. Minimum hire period: 4 weeks.
4. Site access: the client provides clear access, a firm and level base, and a working area free of obstructions. Delays caused by the site are charged extra.
5. Variations: any alteration, extension or additional visit requested after erection is quoted and charged separately.
6. Use and safety: the scaffold may only be altered by Achi Scaffolding. The client is responsible for its safe use by others and for loss of or damage to the material while on site.
7. Permits: municipality and building permits, power line isolation and road closures are the client's responsibility unless stated otherwise.
8. Prices are in the currency shown and exclude VAT unless shown on the quotation."""


def _check_amount(minor: int | None, label: str) -> None:
    if minor is not None and abs(minor) > MAX_MINOR:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{label} is too large")


def _line_rows(quotation_id: str, lines: list[dict]) -> list[QuotationLine]:
    rows = []
    for position, line in enumerate(lines):
        price = to_minor(line.get("unit_price"))
        _check_amount(price, f"Line {position + 1}: the price")
        total = line_total(line.get("quantity"), price)
        _check_amount(total, f"Line {position + 1}: the total")
        rows.append(QuotationLine(
            quotation_id=quotation_id, position=position,
            item=line.get("item") or "", description=line.get("description") or "",
            start_date=line.get("start_date"), end_date=line.get("end_date"),
            unit=line.get("unit") or "m²", quantity=line.get("quantity"),
            unit_price_minor=price, line_total_minor=total,
        ))
    return rows


def _estimate(q: Quotation) -> dict:
    return {
        "area_sqm": q.area_sqm, "duration_weeks": q.duration_weeks,
        "rate_minor": q.rate_minor, "erection_minor": q.erection_minor,
        "transport_minor": q.transport_minor, "extras_minor": q.extras_minor,
        "discount_minor": q.discount_minor, "vat_percent": q.vat_percent,
    }


class QuotationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def lines(self, quotation_id: str) -> list[QuotationLine]:
        return list((await self.session.execute(
            select(QuotationLine)
            .where(QuotationLine.quotation_id == quotation_id)
            .order_by(QuotationLine.position)
        )).scalars().all())

    def _set_totals(self, q: Quotation, line_totals: list[int]) -> None:
        q.subtotal_minor, q.vat_minor, q.total_minor = compute_totals(_estimate(q), line_totals)
        _check_amount(q.total_minor, "The quotation total")

    async def create(self, data: dict, *, user_id: str | None, lines: list[dict] | None = None) -> Quotation:
        payload = dict(data)
        for key in ("rate_minor", "erection_minor", "transport_minor", "extras_minor", "discount_minor"):
            _check_amount(payload.get(key), "An amount")
        q = Quotation(
            quotation_number=await _next_quotation_number(self.session),
            owner_user_id=user_id,
            tenant_id=user_id,
            **payload,
        )
        self.session.add(q)
        await self.session.flush()          # q.id, for the lines
        rows = _line_rows(q.id, lines or [])
        self.session.add_all(rows)
        self._set_totals(q, [row.line_total_minor for row in rows])
        await self.session.commit()
        await self.session.refresh(q)
        logger.info("achi: drafted quotation %s", q.quotation_number)
        return q

    async def customer_from_file(self, file_id: str) -> dict | None:
        """The enquiry's customer, as the quotation should address it."""
        f = await self.session.get(ContactFile, file_id)
        if f is None:
            return None
        return {
            "file_id": f.id,
            "contact_id": f.contact_id,
            "customer_name": (f.lead_first_name or "") + (" " + f.lead_last_name if f.lead_last_name else "") or None,
            "customer_company": f.lead_company,
            "customer_mobile": f.lead_mobile,
            "customer_email": f.lead_email,
            "site_city": getattr(f, "city", None),
            "site_address": ", ".join(
                part for part in (getattr(f, "street", None), getattr(f, "district", None)) if part
            ) or None,
        }

    async def draft_from_log(self, file_id: str, data: dict, *, user_id: str | None) -> Quotation | None:
        """Prefill from a call log row, then apply whatever the card overrode.

        Returns None when the row is gone, so the caller can 404 rather than
        silently drafting a quotation addressed to nobody.
        """
        base = await self.customer_from_file(file_id)
        if base is None:
            return None
        # The row's own text wins where the card left a field blank; the card wins
        # where the user typed. Never the other way round — they just typed it.
        base.update({k: v for k, v in data.items() if v not in (None, "")})
        return await self.create(base, user_id=user_id)

    async def create_from_editor(self, data: dict, *, user_id: str | None) -> Quotation | None:
        """A quotation written in the editor, optionally for an enquiry (file_id).

        Returns None when that enquiry is gone. Typed customer fields win; blank
        ones are taken from the enquiry, as when drafting from the Log.
        """
        payload = dict(data)
        lines = payload.pop("lines", None)
        file_id = payload.pop("file_id", None)
        base: dict = {}
        if file_id:
            base = await self.customer_from_file(file_id)
            if base is None:
                return None
        base.update({k: v for k, v in payload.items() if v not in (None, "")})
        return await self.create(base, user_id=user_id, lines=lines)

    async def get(self, quotation_id: str) -> Quotation | None:
        return await self.session.get(Quotation, quotation_id)

    async def list(self, *, status: str | None = None, limit: int = 200) -> list[Quotation]:
        q = select(Quotation).order_by(Quotation.created_at.desc()).limit(limit)
        if status:
            q = q.where(Quotation.status == status)
        return list((await self.session.execute(q)).scalars().all())

    async def update(self, q: Quotation, data: dict) -> Quotation:
        changes = dict(data)
        lines = changes.pop("lines", None)
        for key in ("rate_minor", "erection_minor", "transport_minor", "extras_minor", "discount_minor"):
            _check_amount(changes.get(key), "An amount")
        for k, v in changes.items():
            setattr(q, k, v)
        if lines is not None:
            # The editor sends the whole table: replace, don't merge.
            await self.session.execute(delete(QuotationLine).where(QuotationLine.quotation_id == q.id))
            rows = _line_rows(q.id, lines)
            self.session.add_all(rows)
            totals = [row.line_total_minor for row in rows]
        else:
            totals = [row.line_total_minor for row in await self.lines(q.id)]
        # Recompute from the merged row, not from the patch: a request that
        # changes only the VAT rate still has to move the total.
        self._set_totals(q, totals)
        await self.session.commit()
        await self.session.refresh(q)
        return q

    async def delete(self, q: Quotation) -> None:
        # Lines first: the database would cascade, but say it rather than rely on it.
        await self.session.execute(delete(QuotationLine).where(QuotationLine.quotation_id == q.id))
        await self.session.delete(q)
        await self.session.commit()
