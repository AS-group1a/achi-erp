"""Business logic for ACHI contact files."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.storage import get_storage_backend
from app.modules.contacts import bridge
from app.modules.contacts.models import Contact
from app.modules.users.models import User

from .models import (
    AchiEmail,
    ContactFile,
    FileLog,
    LogAttachment,
    Quotation,
    SiteSurvey,
)

from .schemas import (
    ContactFileCreate,
    ContactFileUpdate,
    FileLogCreate,
    LogFilterParams,
    LogListParams,
    PersonIn,
    QuickLogCreate,
)

logger = logging.getLogger(__name__)

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

# ── General Log "#" code buckets ──────────────────────────────────────────────
# The General Log's "#" column shows a stage-bucketed code like "SV001" instead
# of a plain row number. Several early pipeline stages roll up into ENQ; the
# stages not listed here ("other": drawing, boq, resources, costing, pricing,
# negotiation, accepted, cancelled, on_hold) never assign or change a code — a
# file parked in one of them keeps whatever code it last had (frozen).

# Set once per process the first time the log feed is served, so the one-time
# backfill of existing rows isn't re-attempted on every request.


_NUMERIC_LOG_CODE_RE = re.compile(r"^[1-9]\d*$")

# PostgreSQL transaction-scoped advisory lock for global Log-number allocation.
# This prevents concurrent Log creation transactions from receiving the same
# permanent number.
_LOG_NUMBER_LOCK = 681_246_020


def _log_code_sort_key(code: str | None) -> tuple[int, int, str]:
    """Sort permanent numeric Log IDs numerically and tolerate legacy codes."""
    value = (code or "").strip()

    if _NUMERIC_LOG_CODE_RE.fullmatch(value):
        return (0, int(value), "")

    # Legacy prefix-coded records remain readable until the explicit
    # one-time renumbering migration.
    return (1, 0, value)



def parse_comm_tally(raw: str | None) -> dict[str, int]:
    """A log's stored comm_tally JSON → {channel: positive int}, robustly.

    Bad/empty/garbage input yields {} rather than raising, so one corrupt row
    can never take down the log feed or the per-file summary.
    """
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, int] = {}
    for k, v in data.items():
        try:
            n = int(v)
        except (ValueError, TypeError):
            continue
        if k and n > 0:
            out[str(k)] = n
    return out


def _normalize_phone(raw: str | None) -> str:
    """A phone number reduced to bare digits with leading zeros dropped.

    "+961 70-123 456", "0096170123456" and "96170123456" all collapse to
    "96170123456", so formatting can never split one caller into two contacts.
    Different country codes stay distinct — equating "70123456" with
    "+96170123456" would need per-country trunk rules we don't want to own.
    """
    return re.sub(r"\D", "", raw or "").lstrip("0")


def _phone_matches(column, normalized: str):
    """SQL predicate: the column's digits (leading zeros dropped) equal ours."""
    return func.ltrim(func.regexp_replace(column, "[^0-9]", "", "g"), "0") == normalized


def _safe_filename(name: str) -> str:
    """Reduce an uploaded name to a storage-key-safe tail.

    The key already carries a UUID directory, so this only has to be inert — it is
    not an identity. The display name the user sees comes from the row, unchanged.
    """
    cleaned = _UNSAFE_NAME.sub("_", (name or "").strip()).strip("._") or "file"
    return cleaned[:120]


def _drawing_has_shapes(payload: str) -> bool:
    """True when the canvas JSON actually holds something.

    The tool saves ``{"version":…,"shapes":[…],"scale":…}``; a bare list is the
    older shape and still reads. We look only for a non-empty shape list — the
    rest of the blob is the tool's business, not ours.

    Malformed JSON counts as empty rather than raising: the flag is a UI hint, and
    a bad blob should not be able to fail the save that carries it.
    """
    try:
        doc = json.loads(payload or "[]")
    except (ValueError, TypeError):
        return False
    shapes = doc.get("shapes") if isinstance(doc, dict) else doc
    return isinstance(shapes, list) and bool(shapes)

# Our tag in Contact.module_tags. bridge.py: "third-party modules adding their own
# tag value just work - there is no registry check."
MODULE_TAG = "achi_file"

# The Contacts directory page lists ONLY contacts carrying this tag (the
# contact-info router filters on it). A contact the log creates or reuses must
# carry it too, or it exists in the database yet never appears on the Contacts
# page. router.py imports this name — single source, so they cannot drift.
CONTACT_INFO_TAG = "achi_contact_info"


def _ensure_directory_tag(contact) -> None:
    """Make the contact visible in the Contacts directory.

    Reassigned rather than appended: module_tags is a JSON column and only a
    new value is change-tracked (same idiom as custom_properties above).
    """
    tags = list(contact.module_tags or [])
    if CONTACT_INFO_TAG not in tags:
        contact.module_tags = [*tags, CONTACT_INFO_TAG]


def _write_contact_phones(contact, phones) -> None:
    """Persist the Add Log popup's labelled numbers to the ONE place the Contacts
    page also reads/writes — ``custom_properties[CONTACT_INFO_TAG]["phones"]`` — and
    mirror the first onto the canonical ``primary_phone``. Tags the contact into the
    directory so the numbers show on the Contacts page too. This is what keeps the
    log and Contacts 100% in sync: both edit the same array on the same row.

    ``phones`` is a list of ``{"label","number"}`` dicts (from ContactPatch); blanks
    are dropped and the list is capped at 8, matching the Contacts editor.
    """
    items: list[dict] = []
    for p in phones or []:
        number = str((p or {}).get("number") or "").strip()
        if not number:
            continue
        label = (str((p or {}).get("label") or "Mobile").strip() or "Mobile")[:32]
        items.append({"label": label, "number": number[:50]})
        if len(items) >= 8:
            break
    props = dict(contact.custom_properties or {})
    bucket = dict(props.get(CONTACT_INFO_TAG) or {})
    bucket["phones"] = items
    props[CONTACT_INFO_TAG] = bucket
    contact.custom_properties = props
    contact.primary_phone = items[0]["number"] if items else None
    _ensure_directory_tag(contact)


def _write_contact_emails(contact, emails) -> None:
    """Like _write_contact_phones, for the labelled ``emails`` array — mirrors the
    first onto ``primary_email``. Same shared bucket the Contacts page edits."""
    items: list[dict] = []
    for e in emails or []:
        address = str((e or {}).get("address") or "").strip()
        if not address:
            continue
        label = (str((e or {}).get("label") or "Other").strip() or "Other")[:32]
        items.append({"label": label, "address": address[:255]})
        if len(items) >= 8:
            break
    props = dict(contact.custom_properties or {})
    bucket = dict(props.get(CONTACT_INFO_TAG) or {})
    bucket["emails"] = items
    props[CONTACT_INFO_TAG] = bucket
    contact.custom_properties = props
    contact.primary_email = items[0]["address"] if items else None
    _ensure_directory_tag(contact)


def _write_contact_related(contact, related) -> None:
    """Additional contact people — mini contact cards stored in the shared bucket's
    ``related_contacts`` array (extras only; there is no canonical column). Each is
    normalised to the card shape; a legacy ``{name, tag}`` row is folded into
    first_name / last_name / role so old data survives a re-save."""
    items: list[dict] = []
    for raw in related or []:
        r = raw or {}
        first = str(r.get("first_name") or "").strip()
        last = str(r.get("last_name") or "").strip()
        if not first and not last and str(r.get("name") or "").strip():
            parts = str(r.get("name")).strip().split(None, 1)
            first = parts[0]
            last = parts[1] if len(parts) > 1 else ""
        phone = str(r.get("phone") or "").strip()
        email = str(r.get("email") or "").strip()
        role = str(r.get("role") or r.get("tag") or "").strip() or None
        if not (first or last or phone or email):
            continue
        items.append({
            "prefix": (str(r.get("prefix") or "").strip() or None),
            "first_name": (first[:128] or None),
            "last_name": (last[:128] or None),
            "role": (role[:64] if role else None),
            "phone_label": (str(r.get("phone_label") or "").strip()[:32] or None),
            "phone": (phone[:50] or None),
            "email": (email[:255] or None),
            "primary": bool(r.get("primary")),
        })
        if len(items) >= 8:
            break
    props = dict(contact.custom_properties or {})
    bucket = dict(props.get(CONTACT_INFO_TAG) or {})
    bucket["related_contacts"] = items
    props[CONTACT_INFO_TAG] = bucket
    contact.custom_properties = props
    _ensure_directory_tag(contact)


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


def _like_contains(column, value: str):
    """Case-insensitive contains with SQL wildcard characters escaped."""

    escaped = (
        value.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )
    return column.ilike(f"%{escaped}%", escape="\\")


def _effective_value(primary, fallback):
    """Mirror the API's canonical-contact then lead-snapshot fallback."""

    return func.coalesce(
        func.nullif(primary, ""),
        fallback,
    )


def _case_insensitive_choices(column, values: list[str]):
    return func.lower(column).in_(
        [value.casefold() for value in values]
    )


def _csv_token_matches(column, value: str):
    """Match one complete token in a comma-separated database field."""

    pattern = (
        rf"(^|,\s*){re.escape(value.strip())}(\s*,|$)"
    )
    return column.op("~*")(pattern)


def _combine_multi(predicates: list, mode: str):
    if mode == "all":
        return and_(*predicates)

    return or_(*predicates)


def _log_filter_predicates(
    filters: LogFilterParams,
) -> tuple:
    """Translate validated grid filters into allowlisted SQL predicates."""

    effective_first = _effective_value(
        Contact.first_name,
        ContactFile.lead_first_name,
    )
    effective_last = _effective_value(
        Contact.last_name,
        ContactFile.lead_last_name,
    )
    effective_company = _effective_value(
        Contact.company_name,
        ContactFile.lead_company,
    )
    effective_mobile = _effective_value(
        Contact.primary_phone,
        ContactFile.lead_mobile,
    )
    effective_email = _effective_value(
        Contact.primary_email,
        ContactFile.lead_email,
    )
    effective_full_name = func.trim(
        func.concat(
            func.coalesce(effective_first, ""),
            " ",
            func.coalesce(effective_last, ""),
        )
    )

    achi_prefix = (
        Contact.custom_properties["achi"]["prefix"].as_string()
    )
    contact_info_prefix = (
        Contact.custom_properties[
            CONTACT_INFO_TAG
        ]["prefix"].as_string()
    )
    effective_prefix = func.coalesce(
        func.nullif(achi_prefix, ""),
        func.nullif(contact_info_prefix, ""),
        ContactFile.lead_prefix,
    )

    visible_when = func.coalesce(
        FileLog.occurred_at,
        FileLog.created_at,
    )

    attachment_exists = (
        select(1)
        .select_from(LogAttachment)
        .where(LogAttachment.log_id == FileLog.id)
        .correlate(FileLog)
        .exists()
    )

    email_present = (
        func.nullif(
            func.trim(effective_email),
            "",
        ).is_not(None)
    )
    sent_email_exists = (
        select(1)
        .select_from(AchiEmail)
        .where(
            AchiEmail.status == "sent",
            func.lower(func.trim(AchiEmail.to_email))
            == func.lower(func.trim(effective_email)),
        )
        .correlate(Contact, ContactFile)
        .exists()
    )

    predicates: list = []

    if filters.q:
        searchable = (
            effective_full_name,
            effective_first,
            effective_last,
            effective_company,
            ContactFile.file_number,
            ContactFile.log_code,
            ContactFile.city,
            FileLog.description,
            FileLog.log_type,
            effective_mobile,
            effective_email,
            FileLog.category,
            FileLog.tags,
            FileLog.updates,
            ContactFile.street,
        )
        predicates.append(
            or_(
                *(
                    _like_contains(column, filters.q)
                    for column in searchable
                )
            )
        )

    if filters.number:
        predicates.append(
            _like_contains(
                ContactFile.log_code,
                filters.number,
            )
        )

    if filters.when_from:
        predicates.append(visible_when >= filters.when_from)

    if filters.when_to:
        predicates.append(visible_when <= filters.when_to)

    if filters.status:
        predicates.append(
            ContactFile.status.in_(filters.status)
        )

    if filters.stages:
        predicates.append(
            ContactFile.stage.in_(filters.stages)
        )

    if filters.origins:
        origin_predicates = [
            ContactFile.origin_module.in_(filters.origins)
        ]

        if filters.include_legacy_origins:
            legacy_predicate = ContactFile.origin_module.is_(None)

            if filters.legacy_log_type:
                legacy_predicate = and_(
                    legacy_predicate,
                    _case_insensitive_choices(
                        FileLog.log_type,
                        filters.legacy_log_type,
                    ),
                )

            origin_predicates.append(legacy_predicate)

        predicates.append(or_(*origin_predicates))

    if filters.stage:
        predicates.append(
            ContactFile.stage.in_(filters.stage)
        )

    if filters.prefix:
        predicates.append(
            _case_insensitive_choices(
                effective_prefix,
                filters.prefix,
            )
        )

    if filters.first:
        predicates.append(
            _like_contains(effective_first, filters.first)
        )

    if filters.last:
        predicates.append(
            _like_contains(effective_last, filters.last)
        )

    if filters.company:
        predicates.append(
            _like_contains(
                effective_company,
                filters.company,
            )
        )

    owner_predicates = []

    if filters.owner:
        owner_predicates.append(
            ContactFile.owner_user_id.in_(filters.owner)
        )

    if filters.unassigned:
        owner_predicates.append(
            ContactFile.owner_user_id.is_(None)
        )

    if owner_predicates:
        predicates.append(or_(*owner_predicates))

    if filters.mobile:
        digits = re.sub(r"\D", "", filters.mobile)

        if digits:
            normalized_mobile = func.regexp_replace(
                effective_mobile,
                "[^0-9]",
                "",
                "g",
            )
            predicates.append(
                normalized_mobile.like(f"%{digits}%")
            )
        else:
            predicates.append(
                _like_contains(
                    effective_mobile,
                    filters.mobile,
                )
            )

    if filters.email:
        predicates.append(
            _like_contains(effective_email, filters.email)
        )

    if filters.email_state == "sent":
        predicates.append(
            and_(email_present, sent_email_exists)
        )
    elif filters.email_state == "not_sent":
        predicates.append(
            and_(email_present, ~sent_email_exists)
        )
    elif filters.email_state == "missing":
        predicates.append(~email_present)

    if filters.has_map is not None:
        has_map = (
            func.nullif(
                func.trim(ContactFile.maps_url),
                "",
            ).is_not(None)
        )
        predicates.append(
            has_map if filters.has_map else ~has_map
        )

    if filters.description:
        predicates.append(
            _like_contains(
                FileLog.description,
                filters.description,
            )
        )

    if filters.has_attachment is not None:
        predicates.append(
            attachment_exists
            if filters.has_attachment
            else ~attachment_exists
        )

    if filters.has_drawing is not None:
        has_drawing = (
            func.coalesce(FileLog.has_drawing, 0) > 0
        )
        predicates.append(
            has_drawing
            if filters.has_drawing
            else ~has_drawing
        )

    if filters.log_type:
        predicates.append(
            _case_insensitive_choices(
                FileLog.log_type,
                filters.log_type,
            )
        )

    if filters.type:
        predicates.append(
            _case_insensitive_choices(
                FileLog.log_type,
                filters.type,
            )
        )

    if filters.communication:
        channel_predicates = []

        for channel in filters.communication:
            encoded_channel = json.dumps(
                channel,
                ensure_ascii=False,
            )
            tally_pattern = (
                rf"{re.escape(encoded_channel)}"
                rf"\s*:\s*[1-9][0-9]*"
            )
            channel_predicates.append(
                or_(
                    func.lower(FileLog.communication)
                    == channel.casefold(),
                    FileLog.comm_tally.op("~*")(
                        tally_pattern
                    ),
                )
            )

        predicates.append(
            _combine_multi(
                channel_predicates,
                filters.communication_mode,
            )
        )

    if filters.last_touch_from:
        predicates.append(
            visible_when >= filters.last_touch_from
        )

    if filters.last_touch_to:
        predicates.append(
            visible_when <= filters.last_touch_to
        )

    if filters.deliverable:
        deliverable_predicates = []

        for deliverable in filters.deliverable:
            deliverable_predicates.append(
                select(1)
                .select_from(LogAttachment)
                .where(
                    LogAttachment.log_id == FileLog.id,
                    _csv_token_matches(
                        LogAttachment.deliverables,
                        deliverable,
                    ),
                )
                .correlate(FileLog)
                .exists()
            )

        predicates.append(
            _combine_multi(
                deliverable_predicates,
                filters.deliverable_mode,
            )
        )

    if filters.tag:
        tag_predicates = [
            _csv_token_matches(FileLog.tags, tag)
            for tag in filters.tag
        ]
        predicates.append(
            _combine_multi(
                tag_predicates,
                filters.tag_mode,
            )
        )

    if filters.updates:
        predicates.append(
            _like_contains(
                FileLog.updates,
                filters.updates,
            )
        )

    if filters.follow_up_from:
        predicates.append(
            FileLog.follow_up_date
            >= filters.follow_up_from
        )

    if filters.follow_up_to:
        predicates.append(
            FileLog.follow_up_date
            <= filters.follow_up_to
        )

    if filters.follow_up_state:
        today = (
            filters.today
            or datetime.now(timezone.utc).date()
        )
        closed_statuses = ("done", "cancelled")

        overdue = and_(
            FileLog.follow_up_date.is_not(None),
            FileLog.follow_up_date < today,
            ContactFile.status.not_in(closed_statuses),
        )

        if filters.follow_up_state == "overdue":
            predicates.append(overdue)
        elif filters.follow_up_state == "scheduled":
            predicates.append(
                and_(
                    FileLog.follow_up_date.is_not(None),
                    ~overdue,
                )
            )
        elif filters.follow_up_state == "missing":
            predicates.append(
                FileLog.follow_up_date.is_(None)
            )

    if filters.country:
        predicates.append(
            _case_insensitive_choices(
                ContactFile.country,
                filters.country,
            )
        )

    if filters.district:
        predicates.append(
            _case_insensitive_choices(
                ContactFile.district,
                filters.district,
            )
        )

    if filters.city:
        predicates.append(
            _case_insensitive_choices(
                ContactFile.city,
                filters.city,
            )
        )

    if filters.street:
        predicates.append(
            _like_contains(
                ContactFile.street,
                filters.street,
            )
        )

    return tuple(predicates)

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
        await self._assign_new_code(f)   # permanent global General Log "#"
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

    async def name_for(self, contact_id: str | None) -> str | None:
        if not contact_id:   # rows with no phone/email have no contact
            return None
        return _display_name(await self.session.get(Contact, contact_id))

    # ── General Log permanent numeric "#" assignment ────────────────────────

    async def _assign_new_code(self, f: ContactFile) -> None:
        """Assign one permanent global numeric Log number.

        Allocation is serialized with a PostgreSQL transaction-scoped advisory
        lock so concurrent creates cannot receive the same number.

        During the temporary migration period, legacy prefix-coded rows still
        count as occupied records. This keeps newly-created numeric IDs above
        the existing population so they do not need to change during the later
        one-time renumbering.
        """
        await self.session.execute(
            select(func.pg_advisory_xact_lock(_LOG_NUMBER_LOCK))
        )

        codes = list(
            (
                await self.session.execute(
                    select(ContactFile.log_code)
                )
            ).scalars().all()
        )

        numeric_numbers = [
            int(value.strip())
            for value in codes
            if isinstance(value, str)
            and _NUMERIC_LOG_CODE_RE.fullmatch(value.strip())
        ]

        # While legacy prefix-coded rows still exist, the total ContactFile
        # population reserves their future numeric slots. Once migration is
        # complete, max_numeric keeps numbering monotonic even if gaps exist.
        existing_count = len(codes)
        max_numeric = max(numeric_numbers, default=0)

        f.log_code = str(max(existing_count, max_numeric) + 1)


    async def update(self, f: ContactFile, data: ContactFileUpdate) -> ContactFile:
        d = data.model_dump(exclude_unset=True)
        for k, v in d.items():
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
        contact = await self.session.get(Contact, f.contact_id) if f.contact_id else None
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

    async def delete_log(self, log: FileLog, *, user_id: str | None = None) -> None:
        """Soft-delete one log entry: the row stays so it can be restored from the
        Deleted Logs view. The file stays too (files are plumbing)."""
        log.deleted_at = datetime.now(timezone.utc)
        log.deleted_by = user_id
        await self.session.commit()

    async def restore_log(self, log: FileLog) -> None:
        """Undo a soft delete — the log returns to the active grid."""
        log.deleted_at = None
        log.deleted_by = None
        await self.session.commit()

    async def hard_delete_log(self, log: FileLog) -> None:
        """Permanently delete a log: its attachment rows cascade with the row, so
        we only need to reclaim the storage blobs ourselves (same row-then-blob
        ordering as delete_attachment, so a failure leaves the invisible half)."""
        keys = [a.storage_key for a in await self.list_attachments(log.id)]
        await self.session.delete(log)
        await self.session.commit()
        backend = get_storage_backend()
        for key in keys:
            try:
                await backend.delete(key)
            except Exception:  # noqa: BLE001 - the row is gone; a stale blob is not worth a 500
                logger.warning("ACHI: could not delete attachment blob %s", key, exc_info=True)

    async def update_contact(self, file: ContactFile, data) -> None:
        """Inline-edit the file's linked canonical contact (name/company/phone/…).

        Contact identity is owned by the Contacts directory, but the grid lets the
        front desk fix a typo without leaving the log. Only the sent fields change.
        """
        d = data.model_dump(exclude_unset=True)
        c = await self.session.get(Contact, file.contact_id) if file.contact_id else None

        # No contact yet. This is the normal state for a name-only row: by the
        # rules in _resolve_contacts, a name we cannot reach does not earn a
        # directory Contact. Returning here silently dropped the edit — the API
        # answered 200 {"ok": true} and the phone number the user had just typed
        # never landed anywhere, so it also never reached Contacts. Instead:
        # write what was typed onto the file, and promote it to a real contact
        # the moment a phone or email makes it reachable.
        if c is None:
            if "first_name" in d:
                file.lead_first_name = d["first_name"] or None
            if "last_name" in d:
                file.lead_last_name = d["last_name"] or None
            if "company_name" in d:
                file.lead_company = d["company_name"] or None
            if "prefix" in d:
                file.lead_prefix = d["prefix"] or None
            if "mobile" in d:
                file.lead_mobile = d["mobile"] or None
            # A phone list makes the row reachable just like a single mobile — take
            # the first number as the lead number so promotion below fires, then
            # write the full list onto the contact it creates.
            phone_list = d.get("phones")
            if phone_list is not None:
                first_number = next((str((p or {}).get("number") or "").strip()
                                     for p in phone_list if str((p or {}).get("number") or "").strip()), None)
                file.lead_mobile = first_number or None
            if "email" in d:
                file.lead_email = (d["email"] or "").strip().lower() or None
            # An email list makes the row reachable too — seed the lead email from
            # the first address so promotion fires; the full list is written below.
            email_list = d.get("emails")
            if email_list is not None:
                first_email = next((str((e or {}).get("address") or "").strip()
                                    for e in email_list if str((e or {}).get("address") or "").strip()), None)
                if first_email:
                    file.lead_email = first_email.lower()
            related_list = d.get("related_contacts")
            if "role" in d:
                file.lead_role = d["role"] or None

            phone = (file.lead_mobile or "").strip()
            email = (file.lead_email or "").strip()
            if phone or email:
                # Reachable now — same resolution the quick-create path uses, so
                # a row promoted here and a row created complete end up identical.
                person, company_contact, _matched = await self._resolve_contacts(
                    first=(file.lead_first_name or "").strip(),
                    last=(file.lead_last_name or "").strip(),
                    company=(file.lead_company or "").strip(),
                    phone=phone, email=email,
                    prefix=file.lead_prefix, user_id=file.owner_user_id,
                )
                if person is not None:
                    file.contact_id = str(person.id)
                    if phone_list is not None:
                        _write_contact_phones(person, phone_list)
                    if email_list is not None:
                        _write_contact_emails(person, email_list)
                    if related_list is not None:
                        _write_contact_related(person, related_list)
                if company_contact is not None:
                    file.company_contact_id = str(company_contact.id)
            await self.session.commit()
            return

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
        # The full labelled lists win over lone `mobile`/`email`: they rewrite the
        # shared achi_contact_info bucket (+ primary_phone/email), so Contacts sees it.
        if d.get("phones") is not None:
            _write_contact_phones(c, d["phones"])
        if d.get("emails") is not None:
            _write_contact_emails(c, d["emails"])
        if d.get("related_contacts") is not None:
            _write_contact_related(c, d["related_contacts"])
        await self.session.commit()

    async def update_log(self, log: FileLog, data) -> FileLog:
        """Apply only the fields the caller sent (inline grid edits one cell)."""
        d = data.model_dump(exclude_unset=True)
        # has_drawing is ours to decide, not the client's: derive it from the
        # payload so the flag can never disagree with the blob it describes.
        if "drawing" in d:
            d["drawing"] = d["drawing"] or ""
            d["has_drawing"] = 1 if _drawing_has_shapes(d["drawing"]) else 0
        # tags is NOT NULL: the grid clears it by PATCHing null, so coerce to ""
        # rather than let a cleared field violate the column.
        if "tags" in d and d["tags"] is None:
            d["tags"] = ""
        for k, v in d.items():
            setattr(log, k, v)
        await self.session.commit()
        await self.session.refresh(log)
        return log

    # ── Attachments (the Files button in the description popup) ────────────

    async def list_attachments(self, log_id: str) -> list[LogAttachment]:
        q = (
            select(LogAttachment)
            .where(LogAttachment.log_id == log_id)
            .order_by(LogAttachment.created_at)
        )
        return list((await self.session.execute(q)).scalars())

    async def add_attachment(
        self, log: FileLog, *, filename: str, content_type: str, content: bytes, user_id: str | None
    ) -> LogAttachment:
        """Store the bytes, then record the row.

        Storage first: an orphaned blob is invisible and costs disk, whereas a row
        pointing at a key that was never written is a broken download link the user
        sees. Failing the write aborts before anything is committed.
        """
        att = LogAttachment(
            log_id=log.id,
            filename=filename,
            content_type=content_type or "application/octet-stream",
            size_bytes=len(content),
            storage_key="",
            uploaded_by=user_id,
        )
        att.storage_key = f"achi/logs/{log.id}/{att.id}/{_safe_filename(filename)}"
        await get_storage_backend().put(att.storage_key, content)
        self.session.add(att)
        await self.session.commit()
        await self.session.refresh(att)
        return att

    async def get_attachment(self, attachment_id: str) -> LogAttachment | None:
        return await self.session.get(LogAttachment, attachment_id)

    async def update_attachment_deliverables(
        self,
        att: LogAttachment,
        deliverables: list[str],
    ) -> LogAttachment:
        """Save the selected General Log deliverable classifications."""

        att.deliverables = ",".join(deliverables)

        await self.session.commit()
        await self.session.refresh(att)

        return att

    async def read_attachment(self, att: LogAttachment) -> bytes:
        return await get_storage_backend().get(att.storage_key)

    async def delete_attachment(self, att: LogAttachment) -> None:
        """Row first, then the blob.

        The opposite order to upload, and for the same reason: whichever half is
        left behind should be the invisible one. A delete that removes the row but
        leaks the blob is tidy from the user's side; the reverse is a dead link.
        """
        key = att.storage_key
        await self.session.delete(att)
        await self.session.commit()
        try:
            await get_storage_backend().delete(key)
        except Exception:  # noqa: BLE001 - the row is gone; a stale blob is not worth a 500
            logger.warning("ACHI: could not delete attachment blob %s", key, exc_info=True)

    async def attachment_counts(self, log_ids: list[str]) -> dict[str, int]:
        """Attachment count per log — one grouped query, not one per row."""
        if not log_ids:
            return {}

        q = (
            select(LogAttachment.log_id, func.count(LogAttachment.id))
            .where(LogAttachment.log_id.in_(log_ids))
            .group_by(LogAttachment.log_id)
        )

        return {
            log_id: n
            for log_id, n in (await self.session.execute(q)).all()
        }

    async def attachment_deliverables(
        self,
        log_ids: list[str],
    ) -> dict[str, list[str]]:
        """Union of selected deliverables across each log's attachments."""

        if not log_ids:
            return {}

        rows = (
            await self.session.execute(
                select(
                    LogAttachment.log_id,
                    LogAttachment.deliverables,
                ).where(
                    LogAttachment.log_id.in_(log_ids)
                )
            )
        ).all()

        result: dict[str, list[str]] = {}

        for log_id, raw in rows:
            if not raw:
                continue

            bucket = result.setdefault(log_id, [])
            seen = {item.lower() for item in bucket}

            for item in raw.split(","):
                name = item.strip()

                if not name:
                    continue

                key = name.lower()

                if key not in seen:
                    seen.add(key)
                    bucket.append(name)

        return result


    async def doc_signals(self, file_ids: list[str]) -> tuple[set[str], set[str], set[str]]:
        """For the CRM "Docs" pills: which files have a survey / survey with
        measurements / a quotation. Three membership sets in two grouped queries,
        not one per row. (BOQ and Costing have no data source yet.)"""
        if not file_ids:
            return set(), set(), set()
        surveys = (await self.session.execute(
            select(SiteSurvey.file_id, SiteSurvey.has_measurements)
            .where(SiteSurvey.file_id.in_(file_ids))
        )).all()
        survey_files = {fid for fid, _ in surveys if fid}
        measured_files = {fid for fid, has_m in surveys if fid and has_m}
        quote_files = set((await self.session.execute(
            select(Quotation.file_id).where(Quotation.file_id.in_(file_ids))
        )).scalars().all())
        return survey_files, measured_files, quote_files

    async def communication_summary(self, file_ids: list[str]) -> dict[str, dict]:
        """Per file: how its logs break down by communication channel, plus the
        most recent touch. Powers the General Log's Communication pills (EM 4,
        PH 3, …) and the "Last Touch · N total" sub-line.

        One query over the files' active logs; counts, total and latest touch are
        folded in Python so this stays one round-trip regardless of row count and
        avoids DB-specific NULLS-ordering. Each log's per-channel `comm_tally`
        counters are summed into `counts`; a legacy single `communication` value
        counts as one on its channel. `total` is the sum of all channel counts
        across the file; `last_channel` is the busiest channel of the most recent
        touch.
        """
        if not file_ids:
            return {}
        rows = (await self.session.execute(
            select(
                FileLog.file_id, FileLog.communication, FileLog.comm_tally,
                FileLog.occurred_at, FileLog.created_at,
            ).where(
                FileLog.file_id.in_(file_ids),
                FileLog.deleted_at.is_(None),
            )
        )).all()
        summary: dict[str, dict] = {}
        for file_id, channel, tally_json, occurred_at, created_at in rows:
            entry = summary.setdefault(
                file_id, {"counts": {}, "total": 0, "last_at": None, "last_channel": None}
            )
            per = parse_comm_tally(tally_json)
            if not per:
                ch = (channel or "").strip()
                if ch:
                    per = {ch: 1}
            for ch, n in per.items():
                entry["counts"][ch] = entry["counts"].get(ch, 0) + n
                entry["total"] += n
            when = occurred_at or created_at
            if when is not None and (entry["last_at"] is None or when > entry["last_at"]):
                entry["last_at"] = when
                entry["last_channel"] = max(per, key=per.get) if per else None
        return summary

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
        first = (p.first_name or "").strip()
        last = (p.last_name or "").strip()
        company = (p.company_name or "").strip()
        phone = (p.mobile or "").strip()
        email = (p.email or "").strip()

        person_contact, company_contact, matched_by = await self._resolve_contacts(
            first=first, last=last, company=company, phone=phone, email=email,
            prefix=p.prefix, user_id=user_id,
        )
        # The file hangs off the person when there is one, otherwise the company.
        primary = person_contact or company_contact
        contact_id = str(primary.id) if primary is not None else None

        f = None if (data.new_file or contact_id is None) else await self._open_file_for(contact_id)
        file_created = f is None
        if f is None:
            site = data.site.model_dump() if data.site else {}
            f = ContactFile(
                file_number=await _next_file_number(self.session),
                contact_id=contact_id,
                company_contact_id=str(company_contact.id) if company_contact is not None else None,
                # Keep what was typed regardless — a row with no contact details
                # still has to show who it is about.
                lead_prefix=p.prefix or None,
                lead_first_name=first or None,
                lead_last_name=last or None,
                lead_company=company or None,
                lead_mobile=phone or None,
                lead_email=email or None,
                lead_role=(p.role or "").strip() or None,
                lead_company_type=(p.company_type or "").strip() or None,
                lead_socials=json.dumps([s.model_dump() for s in p.socials]) if p.socials else None,
                subject=data.subject,
                stage=data.stage,
                origin_module=data.origin_module,
                owner_user_id=user_id,
                tenant_id=user_id,
                **site,
            )
            await self._assign_new_code(f)
            self.session.add(f)
            await self.session.flush()

        # The grid captures file status on the same draft row as the call. This
        # also intentionally reopens/updates a reused file when the user chooses
        # a different status for the new entry.
        f.status = data.status

        log = FileLog(
            file_id=f.id,
            created_by=user_id,
            log_type=data.log_type,
            category=data.category,
            reference=data.reference,
            tags=data.tags,
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
            f"existing, by {matched_by}" if matched_by else "new",
        )
        return {
            "log": log, "file_id": f.id, "file_number": f.file_number,
            "file_created": file_created, "contact_id": contact_id,
            # Falls back to what was typed when no Contact was created (no phone/email).
            "contact_name": _display_name(primary) or " ".join(x for x in (first, last) if x).strip() or company or None,
            "contact_created": primary is not None and matched_by is None,
            "contact_matched_by": matched_by,
            "company_contact_id": str(company_contact.id) if company_contact is not None else None,
        }

    async def _find_contact(
        self, *, email: str = "", phone: str = "", company: str = "", tenant_id: str | None = None
    ) -> Contact | None:
        """Find an existing directory contact by email, then phone, then company.

        The bridge only dedupes on email, which would create a fresh row on every
        call for a phone-only or company-only contact. Matching phone and company
        name too is what stops the directory filling with duplicates.
        """
        scope = []
        if tenant_id is not None:
            scope.append(or_(Contact.tenant_id == tenant_id, Contact.created_by == tenant_id))

        async def _one(pred):
            q = select(Contact).where(pred, Contact.is_active.is_(True), *scope)
            return (await self.session.execute(q.order_by(Contact.created_at.desc()).limit(1))).scalar_one_or_none()

        if email:
            hit = await _one(func.lower(Contact.primary_email) == email.lower())
            if hit is not None:
                return hit
        normalized = _normalize_phone(phone)
        if normalized:
            hit = await _one(_phone_matches(Contact.primary_phone, normalized))
            if hit is not None:
                return hit
        return None

    async def _find_company_contact(self, company: str, tenant_id: str | None) -> Contact | None:
        """The company's OWN contact: matching company name and no person name.

        Requiring the name to be empty is what keeps a person who merely *works*
        at the company (their contact carries company_name too) from being
        mistaken for the company itself.
        """
        scope = []
        if tenant_id is not None:
            scope.append(or_(Contact.tenant_id == tenant_id, Contact.created_by == tenant_id))
        q = (
            select(Contact)
            .where(
                func.lower(Contact.company_name) == company.lower(),
                Contact.is_active.is_(True),
                or_(Contact.first_name.is_(None), Contact.first_name == ""),
                or_(Contact.last_name.is_(None), Contact.last_name == ""),
                *scope,
            )
            .order_by(Contact.created_at.desc())
            .limit(1)
        )
        return (await self.session.execute(q)).scalar_one_or_none()

    async def _resolve_contacts(
        self, *, first: str, last: str, company: str, phone: str, email: str,
        prefix: str | None, user_id: str | None,
    ) -> tuple[Contact | None, Contact | None, str | None]:
        """Who gets a directory Contact for this row.

        Rules:
          * No phone and no email -> no contact at all. A name we cannot reach is
            not a contact; it stays on the file as typed.
          * A person name + reachable -> a person contact.
          * A company named -> its OWN separate contact, so "Anthony Karam / ASKII"
            yields two contacts, not one row with a company field.
          * The person keeps the phone/email; the company only takes them when
            there is no person to own them.

        The third element says how the PRIMARY contact (person, else company) was
        matched to an existing row — "email", "phone" or "company" — and is None
        when it was created fresh (or when the row earned no contact). Decided
        here, at the point of resolution, so the caller's "already existed"
        status can never disagree with what actually happened.
        """
        if not (phone or email):
            return None, None, None

        person = None
        person_matched = None
        if first or last:
            person = await self._find_contact(email=email, phone=phone, tenant_id=user_id)
            if person is not None:
                if email and (person.primary_email or "").lower() == email.lower():
                    person_matched = "email"
                else:
                    person_matched = "phone"
            if person is None:
                person = Contact(
                    contact_type="lead",
                    first_name=first or None,
                    last_name=last or None,
                    company_name=company or None,
                    primary_email=email.lower() or None,
                    primary_phone=phone or None,
                    module_tags=[MODULE_TAG],
                    custom_properties={MODULE_TAG.split("_", 1)[0]: {"prefix": prefix, "is_company": False}},
                    tenant_id=user_id,
                    created_by=user_id,
                )
                self.session.add(person)
            else:
                if not person.first_name and first:
                    person.first_name = first
                if not person.last_name and last:
                    person.last_name = last
                if not person.primary_email and email:
                    person.primary_email = email.lower()
                if not person.primary_phone and phone:
                    person.primary_phone = phone

        org = None
        org_matched = None
        if company:
            org = await self._find_company_contact(company, user_id)
            if org is not None and person is not None and org is person:
                org = None  # never let the person double as their own company
            if org is not None:
                org_matched = "company"
            if org is None:
                org = Contact(
                    contact_type="lead",
                    company_name=company,
                    # Only inherit the contact details when nobody else owns them.
                    primary_email=(email.lower() or None) if person is None else None,
                    primary_phone=(phone or None) if person is None else None,
                    module_tags=[MODULE_TAG],
                    custom_properties={MODULE_TAG.split("_", 1)[0]: {"is_company": True}},
                    tenant_id=user_id,
                    created_by=user_id,
                )
                self.session.add(org)

        # New AND reused rows get the directory tag: rows created before this
        # fix carry only the log tag, so the first log that touches them again
        # is what promotes them into the Contacts page.
        for contact in (person, org):
            if contact is not None:
                _ensure_directory_tag(contact)

        await self.session.flush()
        return person, org, (person_matched if person is not None else org_matched)

    async def _open_file_for(self, contact_id: str) -> ContactFile | None:
        row = await self.session.execute(
            select(ContactFile)
            .where(ContactFile.contact_id == contact_id, ContactFile.status == "open")
            .order_by(ContactFile.created_at.desc())
            .limit(1)
        )
        return row.scalar_one_or_none()

    async def list_logs(
        self,
        *,
        params: LogListParams,
    ) -> tuple[list[tuple], int]:
        """Return one ordered page of logs and its full filtered total."""

        assigned_user = aliased(User)
        predicates = _log_filter_predicates(params)

        effective_first = _effective_value(Contact.first_name, ContactFile.lead_first_name)
        effective_last = _effective_value(Contact.last_name, ContactFile.lead_last_name)
        effective_company = _effective_value(Contact.company_name, ContactFile.lead_company)
        visible_when = func.coalesce(FileLog.occurred_at, FileLog.created_at)

        sequence_rows = None
        if params.module_sequence and not params.deleted:
            # This scope intentionally excludes transient search/column filters.
            # A module code is a stable chronological business rank, not a row index.
            sequence_scope = LogFilterParams(
                stages=params.sequence_stages,
                origins=params.sequence_origins,
                include_legacy_origins=params.sequence_include_legacy_origins,
                legacy_log_type=params.sequence_legacy_log_type,
            )
            sequence_rows = (
                select(
                    FileLog.id.label("log_id"),
                    func.row_number().over(
                        order_by=(
                            ContactFile.created_at.asc(),
                            FileLog.created_at.asc(),
                            ContactFile.id.asc(),
                            FileLog.id.asc(),
                        ),
                    ).label("module_sequence"),
                )
                .join(ContactFile, FileLog.file_id == ContactFile.id)
                .outerjoin(Contact, ContactFile.contact_id == Contact.id)
                .where(FileLog.deleted_at.is_(None), *_log_filter_predicates(sequence_scope))
                .subquery()
            )

        stage_sort_order = case(
            {stage: index for index, stage in enumerate((
                "prospect", "outreach", "follow_up", "first_contact",
                "second_follow_up", "enquiry", "site_survey", "drawing",
                "takeoff", "boq", "resources", "plan", "costing",
                "pricing", "quotation", "negotiation", "accepted",
                "cancelled", "on_hold",
            ))},
            value=ContactFile.stage,
            else_=999,
        )
        sort_columns = {
            "code": ContactFile.log_code,
            "occurred_at": visible_when,
            "status": ContactFile.status,
            # Stages are a workflow, not alphabetic labels: Prospect must be
            # first, followed by the canonical pipeline sequence.
            "stage": stage_sort_order,
            "first_name": effective_first,
            "last_name": effective_last,
            "company": effective_company,
            "country": ContactFile.country,
            "district": ContactFile.district,
            "city": ContactFile.city,
            "owner": User.full_name,
            "category": FileLog.category,
            "follow_up_date": FileLog.follow_up_date,
            "created_at": FileLog.created_at,
            "updated_at": FileLog.updated_at,
            "log_type": FileLog.log_type,
        }
        sort_by = params.sort_by or ""
        sort_column = sort_columns.get(sort_by)
        if sort_column is not None:
            text_sort_fields = {
                "first_name", "last_name", "company", "country", "district",
                "city", "owner", "category", "log_type", "status",
            }
            if sort_by in text_sort_fields:
                sort_column = func.lower(sort_column)
            primary_order = (
                sort_column.asc().nulls_last()
                if params.sort_dir == "asc"
                else sort_column.desc().nulls_last()
            )
            ordering = (primary_order, FileLog.created_at.asc(), FileLog.id.asc())
        elif params.deleted:
            ordering = (FileLog.deleted_at.desc(), FileLog.id.desc())
        else:
            ordering = (FileLog.created_at.desc(), FileLog.id.desc())

        columns = [
            FileLog,
            ContactFile,
            Contact,
            User.full_name,
            assigned_user.full_name,
        ]
        if sequence_rows is not None:
            columns.append(sequence_rows.c.module_sequence)

        query = (
            select(*columns)
            .join(
                ContactFile,
                FileLog.file_id == ContactFile.id,
            )
            .outerjoin(
                Contact,
                ContactFile.contact_id == Contact.id,
            )
            .outerjoin(
                User,
                ContactFile.owner_user_id == User.id,
            )
            .outerjoin(
                assigned_user,
                ContactFile.assigned_to_user_id
                == assigned_user.id,
            )
            .where(
                FileLog.deleted_at.is_not(None)
                if params.deleted
                else FileLog.deleted_at.is_(None),
                *predicates,
            )
            .order_by(*ordering)
            .offset(params.offset)
            .limit(params.limit)
        )

        if sequence_rows is not None:
            query = query.outerjoin(sequence_rows, sequence_rows.c.log_id == FileLog.id)

        count_query = (
            select(func.count(FileLog.id))
            .select_from(FileLog)
            .join(ContactFile, FileLog.file_id == ContactFile.id)
            .outerjoin(Contact, ContactFile.contact_id == Contact.id)
            .where(
                FileLog.deleted_at.is_not(None)
                if params.deleted
                else FileLog.deleted_at.is_(None),
                *predicates,
            )
        )
        rows = list((await self.session.execute(query)).all())
        total = int((await self.session.execute(count_query)).scalar_one())
        return rows, total

    async def log_stats(
        self,
        *,
        filters: LogFilterParams,
    ) -> dict[str, int]:
        """Dashboard totals using the same filters as the table."""

        now = datetime.now(timezone.utc)
        month_start = datetime(
            now.year,
            now.month,
            1,
            tzinfo=timezone.utc,
        )

        if now.month == 12:
            next_month = datetime(
                now.year + 1,
                1,
                1,
                tzinfo=timezone.utc,
            )
        else:
            next_month = datetime(
                now.year,
                now.month + 1,
                1,
                tzinfo=timezone.utc,
            )

        base_predicates = (
            FileLog.deleted_at.is_(None),
            *_log_filter_predicates(filters),
        )

        def count_statement(*extra_predicates):
            return (
                select(func.count(FileLog.id))
                .join(
                    ContactFile,
                    FileLog.file_id == ContactFile.id,
                )
                .outerjoin(
                    Contact,
                    ContactFile.contact_id == Contact.id,
                )
                .where(
                    *base_predicates,
                    *extra_predicates,
                )
            )

        total = (
            await self.session.execute(
                count_statement()
            )
        ).scalar_one()

        open_count = (
            await self.session.execute(
                count_statement(
                    ContactFile.status == "open",
                )
            )
        ).scalar_one()

        done_count = (
            await self.session.execute(
                count_statement(
                    ContactFile.status == "done",
                )
            )
        ).scalar_one()

        this_month = (
            await self.session.execute(
                count_statement(
                    FileLog.created_at >= month_start,
                    FileLog.created_at < next_month,
                )
            )
        ).scalar_one()

        return {
            "total": total,
            "open": open_count,
            "this_month": this_month,
            "done": done_count,
        }

    # ── cross-module links ────────────────────────────────────────────────
    async def contact_links(self, contact_id: str) -> dict:
        """Everything attached to one contact, across ACHI and upstream CRM.

        The contact is already the shared spine: quick_log writes through
        contacts/bridge.py, so an ACHI file and a CRM record about the same
        person point at the same Contact row. This reads that relationship back
        rather than duplicating anything — deliberately no CRM Lead is created
        from a call log, because ACHI already runs its own stage pipeline and a
        mirrored lead would be a second source of truth for the same enquiry.

        Join reliability differs per record type and the caller should know it:

          achi files    exact   — ContactFile.contact_id
          opportunities exact   — Opportunity.primary_contact_id, though that
                                  column carries no FK constraint upstream, so
                                  nothing guarantees it points at a Contact
          crm leads     BY EMAIL — oe_crm_lead stores contact_name/email/phone
                                  and no contact id at all. A lead with no email,
                                  or a different one, cannot be matched. This is
                                  the same key the bridge dedupes contacts on.

        CRM is imported inside the function on purpose: the partner pack can
        disable upstream modules, and a top-level import would take this module
        down with it.
        """
        contact = await self.session.get(Contact, contact_id)
        if contact is None:
            return {}

        files = (await self.session.execute(
            select(ContactFile)
            .where(ContactFile.contact_id == str(contact_id))
            .order_by(ContactFile.created_at.desc())
        )).scalars().all()

        leads: list = []
        opps: list = []
        crm_available = True
        try:
            from app.modules.crm.models import Lead as CrmLead
            from app.modules.crm.models import Opportunity as CrmOpportunity

            email = (contact.primary_email or "").strip().lower()
            if email:
                leads = list((await self.session.execute(
                    select(CrmLead).where(func.lower(CrmLead.contact_email) == email)
                )).scalars().all())
            opps = list((await self.session.execute(
                select(CrmOpportunity).where(CrmOpportunity.primary_contact_id == contact.id)
            )).scalars().all())
        except Exception:          # CRM disabled or its schema moved
            crm_available = False
            logger.info("achi: CRM not available for contact links")

        return {
            "contact_id": str(contact.id),
            "contact_name": _display_name(contact),
            "email": contact.primary_email,
            "phone": contact.primary_phone,
            "crm_available": crm_available,
            "achi_files": [
                {"id": f.id, "file_number": f.file_number, "stage": f.stage,
                 "status": f.status, "subject": f.subject, "project_id": f.project_id}
                for f in files
            ],
            "crm_leads": [
                {"id": str(l.id), "contact_name": l.contact_name, "status": l.status,
                 "source": l.source, "matched_on": "email"}
                for l in leads
            ],
            "crm_opportunities": [
                {"id": str(o.id), "name": getattr(o, "name", None),
                 "stage": getattr(o, "stage", None), "amount": getattr(o, "amount", None)}
                for o in opps
            ],
        }
