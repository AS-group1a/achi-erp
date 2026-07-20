"""Business logic for ACHI contact files."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.contacts import bridge
from app.modules.contacts.models import Contact

from .models import ContactFile, FileLog
from .schemas import ContactFileCreate, ContactFileUpdate, FileLogCreate, PersonIn, QuickLogCreate

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

    async def get_log(self, log_id: str) -> FileLog | None:
        return await self.session.get(FileLog, log_id)

    async def delete_log(self, log: FileLog) -> None:
        """Delete one log entry. The file stays (files are plumbing)."""
        await self.session.delete(log)
        await self.session.commit()

    async def update_contact(self, file: ContactFile, data) -> None:
        """Inline-edit the file's linked canonical contact (name/company/phone/…).

        Contact identity is owned by the Contacts directory, but the grid lets the
        front desk fix a typo without leaving the log. Only the sent fields change.
        """
        c = await self.session.get(Contact, file.contact_id)
        if c is None:
            return
        d = data.model_dump(exclude_unset=True)
        if "first_name" in d:
            c.first_name = d["first_name"] or None
        if "last_name" in d:
            c.last_name = d["last_name"] or None
        if "company_name" in d:
            c.company_name = d["company_name"] or None
        if "email" in d:
            c.primary_email = (d["email"] or "").strip().lower() or None
        if "mobile" in d:
            c.primary_phone = d["mobile"] or None
        if "prefix" in d:
            props = dict(c.custom_properties or {})
            bucket = dict(props.get(MODULE_TAG.split("_", 1)[0]) or {})
            bucket["prefix"] = d["prefix"] or None
            props[MODULE_TAG.split("_", 1)[0]] = bucket
            c.custom_properties = props
        await self.session.commit()

    async def update_log(self, log: FileLog, data) -> FileLog:
        """Apply only the fields the caller sent (inline grid edits one cell)."""
        for k, v in data.model_dump(exclude_unset=True).items():
            setattr(log, k, v)
        await self.session.commit()
        await self.session.refresh(log)
        return log

    # ── Quick capture ─────────────────────────────────────────────────────

    async def quick_log(self, data: QuickLogCreate, *, user_id: str | None) -> dict:
        """Log a call; create the contact and file underneath it as needed.

        This is the only entry point a human uses. Files are backend bookkeeping —
        nobody should have to open one by hand before they can write down that the
        phone rang.

        File selection: reuse the contact's most recent OPEN file, else create one.
        A second call about the same job lands on the same file; `new_file=True`
        forces a fresh one when a known contact rings about something unrelated.

        The rule is deliberately dumb. It will occasionally attach a call about a
        new site to an old open file — the fix is for the user to say so
        (`new_file`), not for us to guess by comparing addresses.
        """
        p = data.person
        full_name = (p.company_name or "").strip() if p.is_company else " ".join(
            x for x in (p.first_name, p.last_name) if x
        ).strip()

        before = await self._contact_exists(p.email)
        contact = await bridge.ensure_contact_for_person(
            self.session,
            full_name=full_name,
            email=p.email,
            phone=p.mobile,
            contact_type="lead",
            module_tag=MODULE_TAG,
            tenant_id=user_id,
            custom_properties={"prefix": p.prefix, "is_company": p.is_company},
        )
        if p.is_company and not contact.company_name:
            contact.company_name = p.company_name
        contact_id = str(contact.id)

        f = None if data.new_file else await self._open_file_for(contact_id)
        file_created = f is None
        if f is None:
            site = data.site.model_dump() if data.site else {}
            f = ContactFile(
                file_number=await _next_file_number(self.session),
                contact_id=contact_id,
                subject=data.subject,
                stage=data.stage,
                owner_user_id=user_id,
                tenant_id=user_id,
                **site,
            )
            self.session.add(f)
            await self.session.flush()

        log = FileLog(
            file_id=f.id,
            created_by=user_id,
            log_type=data.log_type,
            category=data.category,
            occurred_at=data.occurred_at,
            duration_seconds=data.duration_seconds,
            description=data.description,
            updates=data.updates,
            follow_up_date=data.follow_up_date,
            follow_up_notes=data.follow_up_notes,
        )
        self.session.add(log)
        await self.session.commit()
        await self.session.refresh(log)
        await self.session.refresh(f)

        logger.info(
            "achi: logged %s -> file %s (%s) contact %s (%s)",
            data.log_type, f.file_number,
            "new" if file_created else "existing", contact_id,
            "new" if not before else "existing",
        )
        return {
            "log": log, "file_id": f.id, "file_number": f.file_number,
            "file_created": file_created, "contact_id": contact_id,
            "contact_name": _display_name(contact), "contact_created": not before,
        }

    async def _contact_exists(self, email: str | None) -> bool:
        """Did we already know this person? Asked BEFORE the bridge runs, because
        afterwards the answer is always yes and the UI can't tell the user."""
        if not (email or "").strip():
            return False
        row = await self.session.execute(
            select(Contact.id).where(func.lower(Contact.primary_email) == email.strip().lower()).limit(1)
        )
        return row.scalar_one_or_none() is not None

    async def _open_file_for(self, contact_id: str) -> ContactFile | None:
        row = await self.session.execute(
            select(ContactFile)
            .where(ContactFile.contact_id == contact_id, ContactFile.status == "open")
            .order_by(ContactFile.created_at.desc())
            .limit(1)
        )
        return row.scalar_one_or_none()

    async def list_logs(self, *, limit: int = 200) -> list[tuple]:
        """Log rows joined to their file — one query, not N+1."""
        q = (
            select(FileLog, ContactFile, Contact)
            .join(ContactFile, FileLog.file_id == ContactFile.id)
            .outerjoin(Contact, ContactFile.contact_id == Contact.id)
            .order_by(FileLog.created_at.desc())
            .limit(limit)
        )
        return list((await self.session.execute(q)).all())
