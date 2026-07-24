"""Business logic for site surveys.

Kept beside the contact-file service rather than inside it: a survey is its own
document with its own lifecycle, and ContactFileService is already long. It reuses
the same conventions — storage-backed attachments, MAX+1 numbering, has_drawing
derived from the payload — so the two read the same way.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.storage import get_storage_backend

from .models import SiteSurvey, SurveyAttachment, SurveyMeasurement

logger = logging.getLogger(__name__)

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(name: str) -> str:
    cleaned = _UNSAFE_NAME.sub("_", (name or "").strip()).strip("._") or "file"
    return cleaned[:120]


def _drawing_has_shapes(payload: str) -> bool:
    """True when the canvas JSON actually holds something.

    Malformed JSON counts as empty rather than raising: the flag is a UI hint and
    a bad blob must not fail the save that carries it.
    """
    try:
        doc = json.loads(payload or "[]")
    except (ValueError, TypeError):
        return False
    shapes = doc.get("shapes") if isinstance(doc, dict) else doc
    return isinstance(shapes, list) and bool(shapes)


async def _next_survey_number(session: AsyncSession) -> str:
    """ACHI-SV-YYYY-NNNNN, sequential within the year (MAX+1, like the files)."""
    year = datetime.now(timezone.utc).year
    prefix = f"ACHI-SV-{year}-"
    row = await session.execute(
        select(func.max(SiteSurvey.survey_number)).where(SiteSurvey.survey_number.like(f"{prefix}%"))
    )
    latest = row.scalar_one_or_none()
    seq = int(latest.rsplit("-", 1)[1]) + 1 if latest else 1
    return f"{prefix}{seq:05d}"


class SiteSurveyService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── survey ────────────────────────────────────────────────────────────

    async def create(self, data, *, user_id: str | None) -> SiteSurvey:
        payload = data.model_dump(exclude_unset=True)
        measurements = payload.pop("measurements", [])
        drawing = payload.get("drawing") or ""
        s = SiteSurvey(
            survey_number=await _next_survey_number(self.session),
            owner_user_id=user_id,
            tenant_id=user_id,
            has_drawing=1 if _drawing_has_shapes(drawing) else 0,
            has_measurements=1 if measurements else 0,
            **payload,
        )
        s.measurements = [SurveyMeasurement(**row) for row in measurements]
        self.session.add(s)
        await self.session.commit()
        await self.session.refresh(s)
        logger.info("achi: opened survey %s", s.survey_number)
        return s

    async def get(self, survey_id: str) -> SiteSurvey | None:
        return await self.session.get(SiteSurvey, survey_id)

    async def list(self, *, status: str | None = None, limit: int = 200) -> list[SiteSurvey]:
        q = select(SiteSurvey).order_by(SiteSurvey.created_at.desc()).limit(limit)
        if status:
            q = q.where(SiteSurvey.status == status)
        return list((await self.session.execute(q)).scalars().all())

    async def update(self, s: SiteSurvey, data) -> SiteSurvey:
        payload = data.model_dump(exclude_unset=True)
        measurements = payload.pop("measurements", None)
        if "drawing" in payload:
            # Derived, never taken from the client.
            s.has_drawing = 1 if _drawing_has_shapes(payload["drawing"] or "") else 0
        for k, v in payload.items():
            setattr(s, k, v)
        if measurements is not None:
            s.measurements = [SurveyMeasurement(**row) for row in measurements]
            s.has_measurements = 1 if measurements else 0
        await self.session.commit()
        await self.session.refresh(s)
        return s

    async def delete(self, s: SiteSurvey) -> None:
        await self.session.delete(s)
        await self.session.commit()

    async def arrive(self, s: SiteSurvey) -> SiteSurvey:
        """Stamp arrival. The one thing that has to be one tap on a phone."""
        s.arrived_at = datetime.now(timezone.utc)
        if s.status == "planned":
            s.status = "on_site"
        await self.session.commit()
        await self.session.refresh(s)
        return s

    # ── attachments (photos and PDFs) ─────────────────────────────────────

    async def list_attachments(self, survey_id: str) -> list[SurveyAttachment]:
        q = (
            select(SurveyAttachment)
            .where(SurveyAttachment.survey_id == survey_id)
            .order_by(SurveyAttachment.created_at)
        )
        return list((await self.session.execute(q)).scalars())

    async def add_attachment(
        self, s: SiteSurvey, *, filename: str, content_type: str, content: bytes, user_id: str | None
    ) -> SurveyAttachment:
        """Storage first, then the row — an orphaned blob is invisible, a row
        pointing at a key that was never written is a broken link the user sees."""
        att = SurveyAttachment(
            survey_id=s.id,
            label=filename,
            url="",
            filename=filename,
            content_type=content_type or "application/octet-stream",
            size_bytes=len(content),
            storage_key="",
            uploaded_by=user_id,
        )
        att.url = f"/api/v1/achi/survey-attachments/{att.id}/download"
        att.storage_key = f"achi/surveys/{s.id}/{att.id}/{_safe_filename(filename)}"
        await get_storage_backend().put(att.storage_key, content)
        self.session.add(att)
        await self.session.commit()
        await self.session.refresh(att)
        return att

    async def get_attachment(self, attachment_id: str) -> SurveyAttachment | None:
        return await self.session.get(SurveyAttachment, attachment_id)

    async def read_attachment(self, att: SurveyAttachment) -> bytes:
        return await get_storage_backend().get(att.storage_key)

    async def delete_attachment(self, att: SurveyAttachment) -> None:
        key = att.storage_key
        await self.session.delete(att)
        await self.session.commit()
        try:
            await get_storage_backend().delete(key)
        except Exception:  # noqa: BLE001 - row is gone; a stale blob is not worth a 500
            logger.warning("ACHI: could not delete survey attachment blob %s", key, exc_info=True)

    async def photo_counts(self, survey_ids: list[str]) -> dict[str, int]:
        """Attachment count per survey — one grouped query, not one per row."""
        if not survey_ids:
            return {}
        q = (
            select(SurveyAttachment.survey_id, func.count(SurveyAttachment.id))
            .where(SurveyAttachment.survey_id.in_(survey_ids))
            .group_by(SurveyAttachment.survey_id)
        )
        return {sid: n for sid, n in (await self.session.execute(q)).all()}
