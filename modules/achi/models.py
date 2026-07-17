"""ACHI tables.

Everything is namespaced ``achi_*``. Schema is built by create_all (main.py:2553),
not migrations, and drift is healed additively only — a collision with an upstream
``oe_*`` table would be painful to unpick.
"""

from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ClientFile(Base):
    """A file opened for a person or company before they are a client.

    Deliberately mirrors the Frappe `CRM Log`: identity lives INLINE on the file
    (prefix/first/last/company/mobile/email) rather than as a link, because a file
    is opened *before* the person exists anywhere else — "they open a file for you,
    but you aren't a student yet".

    NOT linked to a project. Upstream's oe_phonelog forces a NOT-NULL project_id,
    which is why we don't use it: a prospect has no project. Ownership is a user.

    ``contact_id`` is the bridge back to OCE's canonical directory and is nullable
    on purpose — the row exists even if the contact sync ever fails.
    """

    __tablename__ = "achi_client_file"
    __table_args__ = (
        Index("ix_achi_client_file_stage_status", "stage", "status"),
        Index("ix_achi_client_file_owner", "owner_user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    # ── Identity, carried inline ──────────────────────────────────────────
    # is_company decides whether company_name or first/last is the display name.
    # Frappe answered this with `prefix` + `company_name`; same idea, explicit flag.
    is_company: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    prefix: Mapped[str | None] = mapped_column(String(16), nullable=True)   # Mr/Ms/Mrs/Dr/Eng/Arch
    first_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    company_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    mobile: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    tel: Mapped[str | None] = mapped_column(String(32), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)

    # ── Funnel ────────────────────────────────────────────────────────────
    # prospect -> lead -> site_survey -> measurements -> client (mirrors Frappe)
    stage: Mapped[str] = mapped_column(String(32), nullable=False, default="prospect")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")

    # ── Where the work is ─────────────────────────────────────────────────
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    district: Mapped[str | None] = mapped_column(String(128), nullable=True)
    city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    street: Mapped[str | None] = mapped_column(String(255), nullable=True)
    site_location: Mapped[str | None] = mapped_column(Text, nullable=True)
    maps_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    # ── Links out ─────────────────────────────────────────────────────────
    # Set by contacts/bridge.py::ensure_contact_for_person. No FK constraint: a
    # hard FK to an upstream table would couple our schema to theirs, and
    # create_all gives us no migration path if they rename it.
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    owner_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    assigned_to_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    tenant_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    logs: Mapped[list["FileLog"]] = relationship(
        back_populates="file", cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def display_name(self) -> str:
        if self.is_company:
            return (self.company_name or "").strip() or "(unnamed company)"
        parts = [self.prefix, self.first_name, self.last_name]
        return " ".join(p for p in parts if p) or "(unnamed)"


class FileLog(Base):
    """One entry against a file — a call, a quotation sent, a site visit."""

    __tablename__ = "achi_file_log"
    __table_args__ = (Index("ix_achi_file_log_file_occurred", "file_id", "occurred_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_client_file.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # inbound_call | outbound_call | quotation | field | job | transfer | note
    log_type: Mapped[str] = mapped_column(String(32), nullable=False, default="note")
    occurred_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    follow_up_date: Mapped[str | None] = mapped_column(Date, nullable=True)
    follow_up_notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    file: Mapped[ClientFile] = relationship(back_populates="logs")
