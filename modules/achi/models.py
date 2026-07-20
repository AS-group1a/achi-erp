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

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String, Text, func
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
    contact_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)

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
