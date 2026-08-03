"""ACHI tables.

Domain shape (this is the bit to get right):

    Contact ──has──> File(s)          an enquiry: prospect -> lead -> survey -> measurements
       │
       └─ becomes a Client ──has──> Project(s)     the actual work, in OCE's own oe_projects

A **file belongs to a contact**, never to a client — clients have projects. One
contact may hold several files (two separate enquiries, a year apart). The file
closes by converting into an OCE Project.

Identity (name, company, email, phone) lives on the CONTACT and is NOT duplicated
here: contacts/bridge.py states the Contact table is "the canonical store for
person data". The file holds only what is true of *this enquiry*.

Everything is namespaced ``achi_*``. Schema is create_all (main.py:2553), healed
additively only — a collision with an upstream ``oe_*`` table would be painful.
"""

from __future__ import annotations

import uuid

from sqlalchemy import Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ContactFile(Base):
    """An enquiry opened against a contact, before there is any project."""

    __tablename__ = "achi_contact_file"
    __table_args__ = (
        Index("ix_achi_contact_file_stage_status", "stage", "status"),
        Index("ix_achi_contact_file_owner", "owner_user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    # The owner of the file. NOT NULL: a file without a contact is meaningless —
    # "contacts have files". No FK constraint to oe_contacts_contact: a hard FK
    # would couple our schema to theirs, and create_all offers no migration path
    # if they rename the table.
    # Nullable on purpose: a row is only linked to a directory Contact when we
    # actually have a way to reach someone (phone or email). A name with no
    # contact details is not a contact — it would be junk in the directory — so
    # the typed identity is kept on the file instead (lead_* below).
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # When a company is named alongside a person, the company gets its OWN
    # contact and is linked here; contact_id stays the person.
    company_contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    # What the user typed. Always stored, so the grid can show the row whether or
    # not a Contact was created, and so we know what was entered at the time.
    lead_prefix: Mapped[str | None] = mapped_column(String(16), nullable=True)
    lead_first_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lead_last_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lead_company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lead_mobile: Mapped[str | None] = mapped_column(String(32), nullable=True)
    lead_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lead_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lead_company_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Social handles typed in Add Log, stored as a JSON array of {platform, handle}.
    lead_socials: Mapped[str | None] = mapped_column(Text, nullable=True)

    # prospect -> lead -> site_survey -> measurements  (mirrors the Frappe CRM Log)
    # There is deliberately no "client" stage: becoming a client is not a file
    # state, it is the file converting into a project.
    stage: Mapped[str] = mapped_column(String(32), nullable=False, default="prospect")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")

    # This enquiry's site — a contact's second file may be a different address,
    # which is exactly why this lives on the file and not the contact.
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    district: Mapped[str | None] = mapped_column(String(128), nullable=True)
    city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    street: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_location: Mapped[str | None] = mapped_column(Text, nullable=True)
    maps_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    # Building-level address detail the Add Log popup collects beside the street.
    site_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    site_building: Mapped[str | None] = mapped_column(String(64), nullable=True)
    site_floor: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # The outcome. Set when the contact becomes a client and the work is real:
    # the file converts into an OCE project (oe_projects_project). Nullable —
    # most files never convert, and that is the point of tracking them.
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    converted_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), nullable=True)

    owner_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assigned_to_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    subject: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    logs: Mapped[list["FileLog"]] = relationship(
        back_populates="file", cascade="all, delete-orphan", lazy="selectin"
    )


class FileLog(Base):
    """One entry against a file — a call, a quotation sent, a site visit."""

    __tablename__ = "achi_file_log"
    __table_args__ = (Index("ix_achi_file_log_file_occurred", "file_id", "occurred_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_contact_file.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # inbound_call | outbound_call | quotation | field | job | transfer | note
    log_type: Mapped[str] = mapped_column(String(32), nullable=False, default="note")
    # Lead | Site Surveys | Measurements Take Off | Estimation | Quotation | Jobs
    # (the Frappe crm_log "Category" column). Free-form; the UI offers the set.
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # How the enquiry reached us. Free-form so Add Log's "+ Add New" values save.
    reference: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Free-form labels the user attaches to a log so a row can be found fast —
    # stored as one comma-separated string (e.g. "urgent, vip, north branch")
    # rather than a side table, because the grid searches it as plain text and
    # never joins on it. NOT NULL/"" like description so a row always has a value.
    tags: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    occurred_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # The Frappe crm_log "Updates" column — running notes distinct from the
    # original description.
    updates: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    follow_up_date: Mapped[str | None] = mapped_column(Date, nullable=True)
    follow_up_notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # The sketch drawn in the description popup — a JSON array of shapes, exactly
    # the payload the canvas tool round-trips. Stored as text, never queried into:
    # to us it is opaque, and giving it structure would tie our schema to the
    # drawing tool's internals. ``has_drawing`` is the cheap flag the grid reads
    # to light up the Drawing button without shipping the whole blob in a list.
    drawing: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    has_drawing: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    file: Mapped[ContactFile] = relationship(back_populates="logs")
    attachments: Mapped[list["LogAttachment"]] = relationship(
        back_populates="log", cascade="all, delete-orphan", lazy="selectin"
    )


class LogAttachment(Base):
    """A file attached to a log entry from the description popup.

    The bytes live in the platform storage backend (``app.core.storage``), not in
    the row: it already abstracts local-disk vs S3, so an operator who points
    STORAGE_BACKEND at a bucket gets our attachments there for free. The row holds
    only the key plus what the UI needs to render a list without a HEAD per file.
    """

    __tablename__ = "achi_log_attachment"
    __table_args__ = (Index("ix_achi_log_attachment_log", "log_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    log_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_file_log.id", ondelete="CASCADE"), nullable=False
    )

    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False, default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)

    uploaded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    log: Mapped[FileLog] = relationship(back_populates="attachments")


# ── Site survey ───────────────────────────────────────────────────────────
#
# The survey follows the job as it actually happens: you take an address from the
# office, you drive there, you find out whether a truck can even get in, you
# arrive, you photograph it, you talk to whoever is on site, and you sketch what
# you saw. Each of those is a field here, in that order, because the person
# filling it in is standing on the site with a phone.


class SiteSurvey(Base):
    """A visit to a site to work out what scaffolding the quotation needs."""

    __tablename__ = "achi_site_survey"
    __table_args__ = (
        Index("ix_achi_site_survey_status", "status"),
        Index("ix_achi_site_survey_file", "file_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    survey_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    # Active Site Survey contract. These fields mirror frappe-bench's
    # ``Site Survey`` DocType. Legacy ACHI workflow columns remain below because
    # this installation heals schemas additively and never drops columns.
    survey_date: Mapped[str | None] = mapped_column(Date, nullable=True)
    assigned_to: Mapped[str | None] = mapped_column(String(255), nullable=True)
    customer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lead: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_maps_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    site_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    roof_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    site_area: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    updates: Mapped[str | None] = mapped_column(Text, nullable=True)
    has_measurements: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # Where it came from. A survey usually follows an enquiry, but one can be
    # raised on its own, so both links are optional.
    file_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("achi_contact_file.id", ondelete="SET NULL"), nullable=True
    )
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # Who it is for, as typed — same reasoning as the call log: a survey must read
    # correctly even when there is no directory contact behind it.
    lead_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lead_company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lead_mobile: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 1. Where am I going
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    district: Mapped[str | None] = mapped_column(String(128), nullable=True)
    city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    street: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_location: Mapped[str | None] = mapped_column(Text, nullable=True)
    maps_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    scheduled_for: Mapped[str | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 2. Can we actually get the kit in — the questions that decide the price
    truck_access: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")   # yes|tight|no|unknown
    parking: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")        # on_site|street|none|unknown
    road_notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    access_notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # 3. On site
    arrived_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), nullable=True)
    people_met: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Canvas JSON from the same drawing tool the call log uses.
    drawing: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    has_drawing: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # 4. Outcome
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="Draft")

    owner_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    attachments: Mapped[list["SurveyAttachment"]] = relationship(
        back_populates="survey", cascade="all, delete-orphan", lazy="selectin"
    )
    measurements: Mapped[list["SurveyMeasurement"]] = relationship(
        back_populates="survey", cascade="all, delete-orphan", lazy="selectin"
    )


class SurveyMeasurement(Base):
    """One row from Frappe's ``Site Survey Measurement`` child DocType."""

    __tablename__ = "achi_survey_measurement"
    __table_args__ = (Index("ix_achi_survey_measurement_survey", "survey_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    survey_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_site_survey.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    survey: Mapped[SiteSurvey] = relationship(back_populates="measurements")


class SurveyAttachment(Base):
    """A photo or document taken on the survey.

    Same shape as LogAttachment (bytes in app.core.storage, row holds the key)
    because it is the same problem; kept as its own table so a survey is not
    forced to invent a log entry just to carry a photograph.
    """

    __tablename__ = "achi_survey_attachment"
    __table_args__ = (Index("ix_achi_survey_attachment_survey", "survey_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    survey_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_site_survey.id", ondelete="CASCADE"), nullable=False
    )
    # Frappe child-table fields. For uploaded ACHI files, label is the displayed
    # filename and url is the authenticated download route.
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False, default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    uploaded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    survey: Mapped[SiteSurvey] = relationship(back_populates="attachments")


class Quotation(Base):
    """A price ACHI offers a customer, drafted from a call log row.

    OCE has no home for this. Its quotation-shaped modules — oe_rfq_bidding,
    oe_bid_management, oe_tendering — all run the other way: we solicit bids and
    suppliers answer. This is the sales side, a document we issue to whoever just
    phoned, so it is ours to model.

    The customer is copied in as text rather than only referenced. A quotation is
    a record of what was offered to whom on a day; if the contact is later renamed
    or deleted, the quotation must still read the way it was sent. Same reasoning
    as lead_* on ContactFile and SiteSurvey.
    """

    __tablename__ = "achi_quotation"
    __table_args__ = (
        Index("ix_achi_quotation_status", "status"),
        Index("ix_achi_quotation_file", "file_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    quotation_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    # Where it came from. Usually a call log row, sometimes a survey, sometimes
    # neither — all three are optional so a quotation can be raised on its own.
    file_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("achi_contact_file.id", ondelete="SET NULL"), nullable=True
    )
    survey_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("achi_site_survey.id", ondelete="SET NULL"), nullable=True
    )
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    # Who it is for, as it read when the quotation was drafted.
    customer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    customer_company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    customer_mobile: Mapped[str | None] = mapped_column(String(32), nullable=True)
    customer_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    site_address: Mapped[str | None] = mapped_column(Text, nullable=True)

    # The quick estimate. Scaffolding is priced on area for a duration, so those
    # are the two numbers someone can give on the phone; everything else is a
    # named addition. Money is stored in MINOR UNITS as integers — floats would
    # accumulate rounding across a total that has to match what the customer was
    # told. Dimensions are not money and stay numeric text.
    area_sqm: Mapped[str | None] = mapped_column(String(32), nullable=True)
    duration_weeks: Mapped[str | None] = mapped_column(String(32), nullable=True)
    rate_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)      # per m² per week
    erection_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    transport_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extras_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    discount_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    vat_percent: Mapped[str | None] = mapped_column(String(8), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")

    # Totals are STORED, not derived on read. What the customer was quoted must
    # not silently change because a rate or VAT default moved afterwards.
    subtotal_minor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    vat_minor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_minor: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    valid_until: Mapped[str | None] = mapped_column(Date, nullable=True)

    # draft -> sent -> accepted | rejected | expired
    # No index=True here: __table_args__ already declares ix_achi_quotation_status.
    # Both together emit CREATE INDEX twice and create_all aborts startup with
    # DuplicateTableError — which takes the whole app down, not just this module.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")

    owner_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class GeoCity(Base):
    """A city added by a user for a (country, district) not covered by the
    frontend's predefined GEO map.

    The predefined towns live in the page; this table holds only the ones people
    add on the fly. The dropdown shows predefined ∪ these. Kept server-side (not
    per-browser localStorage like the other picklists) because the request was
    explicit: a city added once should be there for everyone next time.

    Unique on the triple so the same city can't be stored twice for one district;
    the same city name can exist under different districts, which is correct
    (there are many 'Zahle's-worth of repeated town names).
    """

    __tablename__ = "achi_geo_city"
    __table_args__ = (
        Index("ix_achi_geo_city_lookup", "country", "district"),
        Index("uq_achi_geo_city", "country", "district", "city", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    country: Mapped[str] = mapped_column(String(64), nullable=False)
    district: Mapped[str] = mapped_column(String(128), nullable=False)
    city: Mapped[str] = mapped_column(String(128), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())


class GeoDistrict(Base):
    """A district added by a user for a country not covered by the predefined GEO
    map. Same rationale as GeoCity: hardcoding every country's administrative
    regions is infeasible, so the ones people need are added on the fly and
    stored server-side to be shared. The District dropdown shows predefined ∪
    these; cities then cascade (and add) under whichever district is chosen."""

    __tablename__ = "achi_geo_district"
    __table_args__ = (
        Index("uq_achi_geo_district", "country", "district", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    country: Mapped[str] = mapped_column(String(64), nullable=False)
    district: Mapped[str] = mapped_column(String(128), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AchiFullAccess(Base):
    """Users allowed to reach the full OpenConstructionERP app.

    Everyone NOT listed here — and who is not an admin — is limited to the ACHI
    pages (Call Log, Site Survey, Quotations). Seeded once with the users that
    existed when the limit was switched on, so current staff are grandfathered in
    and only NEW accounts are restricted. Admins can add/remove entries later.
    """

    __tablename__ = "achi_full_access"
    __table_args__ = (
        Index("uq_achi_full_access_user", "user_id", unique=True),
    )

    # id / created_at / updated_at come from Base. user_id is the natural key
    # (one row per user) and is kept unique rather than made the primary key so
    # it stays consistent with every other model here (Base owns the PK).
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    note: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")


class AchiTakeoffLink(Base):
    """Caches the OCE takeoff artifact made from a Call Log attachment, so
    opening it in the editor reuses the same drawing/document rather than
    re-uploading (and re-converting) on every click. One row per (attachment,
    kind)."""

    __tablename__ = "achi_takeoff_link"
    __table_args__ = (
        Index("uq_achi_takeoff_link", "attachment_id", "kind", unique=True),
    )

    attachment_id: Mapped[str] = mapped_column(String(36), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)          # 'dwg' | 'pdf'
    external_id: Mapped[str] = mapped_column(String(64), nullable=False)  # drawing_id / takeoff-doc id
    project_id: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")


class AchiChatMessage(Base):
    """A message in the shared Team Chat — the server-backed version of the
    comment panel's chat tab, so every teammate sees the same thread (the panel's
    Comments tab stays per-browser; this is the part that had to be shared).

    A message may be flagged as an issue and later resolved, which is what the
    filter/solve workflow in ui/comment.js reads. The author's NAME is stored on
    the row, not just their id, so the thread still reads correctly if a user is
    later renamed or removed — same reasoning as lead_*/customer_* elsewhere.

    Booleans are Integer 0/1 to match the rest of this module (has_drawing, etc.).
    """

    __tablename__ = "achi_chat_message"
    __table_args__ = (Index("ix_achi_chat_message_created", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    author_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    text: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Legacy issue/resolve flags. The UI no longer sets or shows them, but the
    # columns stay (this module heals additively and never drops columns) so old
    # rows still load. Left NOT NULL with a 0 default.
    is_issue: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    resolved: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    # Direct messages: NULL = a team-wide (public) message everyone sees; set = a
    # private 1:1 message visible only to its author and this recipient. The
    # recipient's NAME is stored too (like author_name) so a DM still reads right
    # after a rename. Privacy is enforced server-side in list_chat — the client
    # is never sent a DM it is not part of.
    recipient_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    recipient_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")

    # @mentions: a JSON array of the user ids tagged in `text`, resolved on the
    # client from the member directory at post time. Stored opaque (like the log
    # drawing blob); the client parses it to highlight "you were mentioned".
    mentions: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AchiPageComment(Base):
    """A comment left on a page in the panel's Comments tab — now shared across
    the team like the chat, so everyone sees the same threads (it used to be
    per-browser localStorage).

    Named ``achi_page_comment``, NOT ``achi_comment``: the shorter name is already
    taken in the wild by an older/other comment table (columns page/body/tag),
    and this module heals schemas additively and never drops columns, so sharing
    a table with it would fuse two incompatible shapes and break inserts. A
    distinct name is the whole defence — see models.py's header note on collisions.

    ``where`` is the page it was written on (Dashboard, Call Log…), captured on
    the client at post time and stored so the team can see where a bug was. A
    REPLY is just a comment whose ``parent_id`` points at another; the FK's
    ON DELETE CASCADE means deleting a comment takes its replies with it. Only one
    level deep — the router refuses a reply to a reply — matching the UI. The
    author's NAME is stored on the row (not only their id) so the thread still
    reads right if a user is later renamed, same as elsewhere here.

    No index=True on parent_id: the composite index below already leads with it,
    which serves both the reply lookup and the FK.
    """

    __tablename__ = "achi_page_comment"
    __table_args__ = (Index("ix_achi_page_comment_parent_created", "parent_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("achi_page_comment.id", ondelete="CASCADE"), nullable=True
    )
    author_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    author_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    where: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    text: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # A comment is often a bug/task report, so it carries a small workflow.
    # open -> testing -> done | resolved. "open" is the default (untagged) state;
    # the Comments-tab filter chips are All / Resolved / Testing / Done. Free set
    # is fine — the schema is healed additively and never drops columns, so a
    # value added later still saves. Only the top-level comment carries a status;
    # replies (parent_id set) stay plain.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open", server_default="open")

    # Who has claimed this comment, so the whole team sees "Assigned by X" and two
    # people don't fix the same thing. The NAME is stored on the row (not only the
    # id) so it still reads right after a rename — same reasoning as author_name.
    assigned_to_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assigned_to_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")

    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Images/videos dropped onto the comment. selectin so list_comments loads them
    # for every comment (and reply) in one extra query, no per-row round-trips.
    attachments: Mapped[list["AchiCommentAttachment"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )


class AchiCommentAttachment(Base):
    """An image or video attached to a page comment. Same shape as LogAttachment
    (bytes live in app.core.storage; the row holds only the key + display fields),
    so a comment can carry media without borrowing the log's attachment table."""

    __tablename__ = "achi_comment_attachment"
    __table_args__ = (Index("ix_achi_comment_attachment_comment", "comment_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    comment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_page_comment.id", ondelete="CASCADE"), nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False, default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    uploaded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AchiEmail(Base):
    """An email composed on the Log page's compose popup and sent from inside the
    site. The row is the site's OWN record of the message — kept regardless of
    what the mail server then does with it — so a sent email can be viewed and
    managed later rather than vanishing into a mailto: handoff.

    Delivery runs through app.core.email (the same pluggable EmailService the
    password-reset flow uses); ``status``/``backend``/``error`` record the
    DeliveryResult so a failed or console-only send is VISIBLE in the record
    instead of silently lost. A send that the server merely logged (email_backend
    still on "console") is stored as status="sent" with backend="console", which
    is the honest signal that it did not actually leave the building.

    The sender's NAME is stored on the row (not only the id) so the record still
    reads right after a user is renamed or removed — same reasoning as
    author_name on the chat/comment tables. ``log_id``/``file_id``/``contact_id``
    tie the email back to the enquiry it was sent from when the compose was opened
    from a saved grid row; all nullable, since an email may be composed ad hoc.
    """

    __tablename__ = "achi_email"
    __table_args__ = (
        Index("ix_achi_email_created", "created_at"),
        Index("ix_achi_email_sender", "sender_user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    sender_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    sender_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    to_email: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    # The message the user typed, stored as plain text exactly as entered; the
    # HTML actually sent is derived from this at send time, not stored twice.
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # Where the compose was opened from, so the record can be tied back to the
    # enquiry. All nullable — an ad-hoc email need not come from a specific row.
    log_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    file_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    # The DeliveryResult, recorded so a bounce/auth/console outcome stays visible.
    # status: "sent" (ok) | "failed". backend: which transport ran (console in
    # dev, smtp in prod). error: the failure reason when status == "failed".
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="sent", server_default="sent")
    backend: Mapped[str] = mapped_column(String(32), nullable=False, default="", server_default="")
    error: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
