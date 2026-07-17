"""Business logic for ACHI contact files."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.contacts import bridge
from app.modules.contacts.models import Contact

from .models import ContactFile, FileLog
from .schemas import ContactFileCreate, ContactFileUpdate, FileLogCreate, PersonIn

logger = logging.getLogger(__name__)

# Our tag in Contact.module_tags. bridge.py: "third-party modules adding their own
# tag value just work - there is no registry check."
MODULE_TAG = "achi_file"


async def _next_file_number(session: AsyncSession) -> str:
    """ACHI-YYYY-NNNNN, sequential within the year.

    MAX+1 rather than a sequence: two files opened in the same millisecond collide
    on the unique index — a 500 the caller retries, not corruption. A real sequence
    is the fix if this ever runs hot; it does not today.
    """
    year = datetime.now(timezone.utc).year
    prefix = f"ACHI-{year}-"
    row = await session.execute(
        select(func.max(ContactFile.file_number)).where(ContactFile.file_number.like(f"{prefix}%"))
    )
    latest = row.scalar_one_or_none()
    seq = int(latest.rsplit("-", 1)[1]) + 1 if latest else 1
    return f"{prefix}{seq:05d}"


def _display_name(c: Contact | None) -> str | None:
    if c is None:
        return None
    if (c.company_name or "").strip() and not (c.first_name or c.last_name):
        return c.company_name
    name = " ".join(p for p in (c.first_name, c.last_name) if p).strip()
    return name or c.company_name or None


class ContactFileService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _resolve_contact(self, data: ContactFileCreate, *, user_id: str | None) -> str:
        """Return the contact id this file belongs to, creating the contact if needed."""
        if data.contact_id:
            if await self.session.get(Contact, data.contact_id) is None:
                raise ValueError(f"contact_id {data.contact_id} not found")
            return data.contact_id

        p: PersonIn = data.person  # guaranteed by the schema validator
        full_name = (p.company_name or "").strip() if p.is_company else " ".join(
            x for x in (p.first_name, p.last_name) if x
        ).strip()

        contact = await bridge.ensure_contact_for_person(
            self.session,
            full_name=full_name,
            email=p.email,
            phone=p.mobile,
            # A file exists because someone enquired; that's a lead until they sign.
            contact_type="lead",
            module_tag=MODULE_TAG,
            tenant_id=user_id,
            # prefix/is_company have no home on OCE's Contact, so they ride in the
            # module-namespaced custom_properties bucket the bridge already manages.
            custom_properties={"prefix": p.prefix, "is_company": p.is_company},
        )
        if p.is_company and not contact.company_name:
            contact.company_name = p.company_name
        return str(contact.id)

    async def create(self, data: ContactFileCreate, *, user_id: str | None) -> ContactFile:
        contact_id = await self._resolve_contact(data, user_id=user_id)
        f = ContactFile(
            file_number=await _next_file_number(self.session),
            contact_id=contact_id,
            owner_user_id=user_id,
            tenant_id=user_id,
            **data.model_dump(exclude={"contact_id", "person"}),
        )
        self.session.add(f)
        await self.session.commit()   # the bridge never commits — that's ours to do
        await self.session.refresh(f)
        logger.info("achi: opened file %s for contact %s", f.file_number, contact_id)
        return f

    async def get(self, file_id: str) -> ContactFile | None:
        return await self.session.get(ContactFile, file_id)

    async def list(
        self, *, stage: str | None = None, status: str | None = None,
        contact_id: str | None = None, limit: int = 200,
    ) -> list[ContactFile]:
        q = select(ContactFile).order_by(ContactFile.created_at.desc()).limit(limit)
        if stage:
            q = q.where(ContactFile.stage == stage)
        if status:
            q = q.where(ContactFile.status == status)
        if contact_id:
            q = q.where(ContactFile.contact_id == contact_id)
        return list((await self.session.execute(q)).scalars().all())

    async def name_for(self, contact_id: str) -> str | None:
        return _display_name(await self.session.get(Contact, contact_id))

    async def update(self, f: ContactFile, data: ContactFileUpdate) -> ContactFile:
        for k, v in data.model_dump(exclude_unset=True).items():
            setattr(f, k, v)
        await self.session.commit()
        await self.session.refresh(f)
        return f

    async def convert(self, f: ContactFile, project_id: str) -> ContactFile:
        """The contact became a client: close the file onto a project.

        The project is OCE's (oe_projects_project). We don't create it — project
        setup is theirs and has its own rules. We only record the outcome, and
        promote the contact from lead to client.
        """
        f.project_id = project_id
        f.converted_at = datetime.now(timezone.utc)
        f.status = "done"
        contact = await self.session.get(Contact, f.contact_id)
        if contact is not None:
            contact.contact_type = "client"
        await self.session.commit()
        await self.session.refresh(f)
        logger.info("achi: file %s converted -> project %s", f.file_number, project_id)
        return f

    async def add_log(self, f: ContactFile, data: FileLogCreate, *, user_id: str | None) -> FileLog:
        log = FileLog(file_id=f.id, created_by=user_id, **data.model_dump())
        self.session.add(log)
        await self.session.commit()
        await self.session.refresh(log)
        return log
