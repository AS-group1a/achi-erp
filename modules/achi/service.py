"""Business logic for ACHI client files."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.contacts import bridge

from .models import ClientFile, FileLog
from .schemas import ClientFileCreate, ClientFileUpdate, FileLogCreate

logger = logging.getLogger(__name__)

# Our tag in Contact.module_tags. bridge.py: "third-party modules adding their own
# tag value just work - there is no registry check."
MODULE_TAG = "achi_file"

# Contact.contact_type as the funnel moves. The bridge writes the row directly and
# bypasses the contacts service, so these aren't validated there — keep them inside
# the set the Contacts UI understands.
_STAGE_TO_CONTACT_TYPE = {
    "prospect": "lead",
    "lead": "lead",
    "site_survey": "lead",
    "measurements": "lead",
    "client": "client",
}


async def _next_file_number(session: AsyncSession) -> str:
    """ACHI-YYYY-NNNNN, sequential within the year.

    MAX+1 rather than a sequence: two files created in the same millisecond could
    collide, and the unique index on file_number would reject the loser. That's a
    500 the caller can retry, not corruption. A real sequence is the fix if this
    ever runs hot — it does not today (a handful of files a day).
    """
    year = datetime.now(timezone.utc).year
    prefix = f"ACHI-{year}-"
    row = await session.execute(
        select(func.max(ClientFile.file_number)).where(ClientFile.file_number.like(f"{prefix}%"))
    )
    latest = row.scalar_one_or_none()
    seq = int(latest.rsplit("-", 1)[1]) + 1 if latest else 1
    return f"{prefix}{seq:05d}"


def _full_name(data: ClientFileCreate | ClientFile) -> str:
    if data.is_company:
        return (data.company_name or "").strip()
    # Deliberately excludes the prefix: "Eng." is a salutation, not part of a name,
    # and the bridge splits full_name into first/last on whitespace.
    return " ".join(p for p in (data.first_name, data.last_name) if p).strip()


class ClientFileService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, data: ClientFileCreate, *, user_id: str | None) -> ClientFile:
        """Open a file and mirror the person into OCE's contact directory.

        The bridge dedupes by email before creating, so opening a second file for
        someone we already know reuses their contact rather than duplicating them.
        With no email we cannot dedupe — the bridge will create a fresh contact,
        and two files for the same phone-only person will produce two contacts.
        That is a known limitation; Frappe deduped on phone too.
        """
        f = ClientFile(
            file_number=await _next_file_number(self.session),
            owner_user_id=user_id,
            tenant_id=user_id,
            **data.model_dump(exclude_unset=False),
        )
        self.session.add(f)

        contact = await bridge.ensure_contact_for_person(
            self.session,
            full_name=_full_name(data),
            email=data.email,
            phone=data.mobile or data.tel,
            contact_type=_STAGE_TO_CONTACT_TYPE.get(data.stage, "lead"),
            module_tag=MODULE_TAG,
            tenant_id=user_id,
            custom_properties={"file_number": f.file_number, "stage": data.stage},
        )
        f.contact_id = str(contact.id)

        await self.session.commit()   # the bridge never commits — that's ours to do
        await self.session.refresh(f)
        logger.info("achi: opened file %s -> contact %s", f.file_number, f.contact_id)
        return f

    async def get(self, file_id: str) -> ClientFile | None:
        return await self.session.get(ClientFile, file_id)

    async def list(self, *, stage: str | None = None, status: str | None = None, limit: int = 200):
        q = select(ClientFile).order_by(ClientFile.created_at.desc()).limit(limit)
        if stage:
            q = q.where(ClientFile.stage == stage)
        if status:
            q = q.where(ClientFile.status == status)
        return list((await self.session.execute(q)).scalars().all())

    async def update(self, f: ClientFile, data: ClientFileUpdate) -> ClientFile:
        for k, v in data.model_dump(exclude_unset=True).items():
            setattr(f, k, v)
        await self.session.commit()
        await self.session.refresh(f)
        return f

    async def add_log(self, f: ClientFile, data: FileLogCreate, *, user_id: str | None) -> FileLog:
        log = FileLog(file_id=f.id, created_by=user_id, **data.model_dump())
        self.session.add(log)
        await self.session.commit()
        await self.session.refresh(log)
        return log
