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
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ContactFile, Quotation

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


def compute_totals(data: dict) -> tuple[int, int, int]:
    """(subtotal, vat, total) in minor units.

    area x weeks x rate, plus the named additions, less discount, then VAT on the
    result. Kept in one function because the quick-view card and the quotation
    page must never disagree about what a number means.
    """
    area = _num(data.get("area_sqm"))
    weeks = _num(data.get("duration_weeks"))
    rate = Decimal(data.get("rate_minor") or 0)

    hire = (area * weeks * rate).quantize(Decimal("1"))
    subtotal = hire + Decimal(data.get("erection_minor") or 0) \
                    + Decimal(data.get("transport_minor") or 0) \
                    + Decimal(data.get("extras_minor") or 0) \
                    - Decimal(data.get("discount_minor") or 0)
    if subtotal < 0:
        subtotal = Decimal(0)   # a discount larger than the work is a typo, not a credit

    vat_pct = _num(data.get("vat_percent"))
    vat = (subtotal * vat_pct / 100).quantize(Decimal("1"))
    return int(subtotal), int(vat), int(subtotal + vat)


async def _next_quotation_number(session: AsyncSession) -> str:
    """ACHI-QT-YYYY-NNNNN, sequential within the year — same scheme as the rest."""
    year = datetime.now(timezone.utc).year
    prefix = f"ACHI-QT-{year}-"
    row = await session.execute(
        select(func.max(Quotation.quotation_number)).where(Quotation.quotation_number.like(f"{prefix}%"))
    )
    latest = row.scalar_one_or_none()
    seq = int(latest.rsplit("-", 1)[1]) + 1 if latest else 1
    return f"{prefix}{seq:05d}"


class QuotationService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, data: dict, *, user_id: str | None) -> Quotation:
        payload = dict(data)
        subtotal, vat, total = compute_totals(payload)
        q = Quotation(
            quotation_number=await _next_quotation_number(self.session),
            owner_user_id=user_id,
            tenant_id=user_id,
            subtotal_minor=subtotal,
            vat_minor=vat,
            total_minor=total,
            **payload,
        )
        self.session.add(q)
        await self.session.commit()
        await self.session.refresh(q)
        logger.info("achi: drafted quotation %s", q.quotation_number)
        return q

    async def draft_from_log(self, file_id: str, data: dict, *, user_id: str | None) -> Quotation | None:
        """Prefill from a call log row, then apply whatever the card overrode.

        Returns None when the row is gone, so the caller can 404 rather than
        silently drafting a quotation addressed to nobody.
        """
        f = await self.session.get(ContactFile, file_id)
        if f is None:
            return None
        # The row's own text wins where the card left a field blank; the card wins
        # where the user typed. Never the other way round — they just typed it.
        base = {
            "file_id": f.id,
            "contact_id": f.contact_id,
            "customer_name": (f.lead_first_name or "") + (" " + f.lead_last_name if f.lead_last_name else "") or None,
            "customer_company": f.lead_company,
            "customer_mobile": f.lead_mobile,
            "customer_email": f.lead_email,
            "site_city": getattr(f, "city", None),
        }
        base.update({k: v for k, v in data.items() if v not in (None, "")})
        return await self.create(base, user_id=user_id)

    async def get(self, quotation_id: str) -> Quotation | None:
        return await self.session.get(Quotation, quotation_id)

    async def list(self, *, status: str | None = None, limit: int = 200) -> list[Quotation]:
        q = select(Quotation).order_by(Quotation.created_at.desc()).limit(limit)
        if status:
            q = q.where(Quotation.status == status)
        return list((await self.session.execute(q)).scalars().all())

    async def update(self, q: Quotation, data: dict) -> Quotation:
        for k, v in data.items():
            setattr(q, k, v)
        # Recompute from the merged row, not from the patch: a request that
        # changes only the VAT rate still has to move the total.
        merged = {
            "area_sqm": q.area_sqm, "duration_weeks": q.duration_weeks,
            "rate_minor": q.rate_minor, "erection_minor": q.erection_minor,
            "transport_minor": q.transport_minor, "extras_minor": q.extras_minor,
            "discount_minor": q.discount_minor, "vat_percent": q.vat_percent,
        }
        q.subtotal_minor, q.vat_minor, q.total_minor = compute_totals(merged)
        await self.session.commit()
        await self.session.refresh(q)
        return q

    async def delete(self, q: Quotation) -> None:
        await self.session.delete(q)
        await self.session.commit()
