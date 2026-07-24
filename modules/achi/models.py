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
