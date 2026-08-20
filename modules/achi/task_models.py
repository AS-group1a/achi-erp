"""Isolated database models for ACHI team task management.

These tables do not reuse or modify Log, CRM, Contacts, Comments, Survey, or
Quotation records. Existing OCE users are referenced by ID without foreign-key
constraints so task history survives user deactivation or removal.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AchiTask(Base):
    """One piece of work assigned by a supervisor to an employee."""

    __tablename__ = "achi_task"
    __table_args__ = (
        Index("ix_achi_task_assignee_status", "assigned_to_user_id", "status"),
        Index("ix_achi_task_status_due", "status", "due_at"),
        Index("ix_achi_task_creator", "created_by_user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    task_number: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        unique=True,
        index=True,
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default="",
    )

    # unassigned | to_do | in_progress | blocked |
    # ready_for_review | completed | cancelled
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="unassigned",
        server_default="unassigned",
    )

    # low | normal | high | urgent
    priority: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="normal",
        server_default="normal",
    )

    # task | feature | issue | bug | chore
    task_type: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="task",
        server_default="task",
    )

    # User IDs intentionally have no hard foreign keys to the upstream User
    # table. The stored names preserve readable history after a user is renamed
    # or deactivated.
    assigned_to_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
        index=True,
    )
    assigned_to_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    created_by_user_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
    )
    created_by_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )

    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    blocked_reason: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default="",
    )

    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    completed_by_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )
    completed_by_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )
    review_note: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default="",
    )

    # Optional connection to existing ERP work. These are plain references;
    # they do not modify or constrain the linked feature's database tables.
    # Examples: log, crm, contact, project, survey, quotation.
    related_type: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
    )
    related_id: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )
    related_label: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )

    # Tasks use recoverable soft deletion. No first-version API will permanently
    # delete a task or its audit history.
    is_deleted: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    deleted_by_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )

    comments: Mapped[list["AchiTaskComment"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        lazy="raise",
    )
    events: Mapped[list["AchiTaskEvent"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        lazy="raise",
    )
    
    attachments: Mapped[list["AchiTaskAttachment"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    

class AchiTaskAttachment(Base):
    """A file owned by a Team Task; bytes live in the shared storage backend."""

    __tablename__ = "achi_task_attachment"
    __table_args__ = (
        Index("ix_achi_task_attachment_task_created", "task_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    task_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("achi_task.id", ondelete="CASCADE"),
        nullable=False,
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        default="application/octet-stream",
        server_default="application/octet-stream",
    )
    size_bytes: Mapped[int] = mapped_column(
        nullable=False,
        default=0,
        server_default="0",
    )
    storage_key: Mapped[str] = mapped_column(
        String(512),
        nullable=False,
    )
    uploaded_by: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=text("CURRENT_TIMESTAMP"),
        nullable=False,
    )

    task: Mapped["AchiTask"] = relationship(
        back_populates="attachments",
    )

class AchiTaskComment(Base):
    """A discussion message belonging only to a task."""

    __tablename__ = "achi_task_comment"
    __table_args__ = (
        Index("ix_achi_task_comment_task_created", "task_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    task_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("achi_task.id", ondelete="CASCADE"),
        nullable=False,
    )

    author_user_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
    )
    author_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)

    # comment | blocked_reason | review_submission | supervisor_review
    kind: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="comment",
        server_default="comment",
    )

    task: Mapped["AchiTask"] = relationship(back_populates="comments")


class AchiTaskEvent(Base):
    """Immutable audit event for every important task transition."""

    __tablename__ = "achi_task_event"
    __table_args__ = (
        Index("ix_achi_task_event_task_created", "task_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    task_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("achi_task.id", ondelete="CASCADE"),
        nullable=False,
    )

    actor_user_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
    )
    actor_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )

    # created | assigned | reassigned | started | blocked |
    # submitted | approved | reopened | cancelled | deleted
    event_type: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
    )
    from_status: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
    )
    to_status: Mapped[str | None] = mapped_column(
        String(32),
        nullable=True,
    )

    # Optional human-readable context or JSON text. No sensitive token or
    # attachment bytes should ever be stored here.
    details: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        server_default="",
    )

    task: Mapped["AchiTask"] = relationship(back_populates="events")


class AchiTaskWorkRequest(Base):
    """An employee's persistent “I need another task” request."""

    __tablename__ = "achi_task_work_request"
    __table_args__ = (
        Index(
            "ix_achi_task_work_request_user_status",
            "requester_user_id",
            "status",
        ),
        Index(
            "uq_achi_task_work_request_pending_user",
            "requester_user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )

    requester_user_id: Mapped[str] = mapped_column(
        String(36),
        nullable=False,
        index=True,
    )
    requester_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )
    message: Mapped[str] = mapped_column(
        String(500),
        nullable=False,
        default="",
        server_default="",
    )

    # pending | acknowledged | cancelled
    status: Mapped[str] = mapped_column(
        String(24),
        nullable=False,
        default="pending",
        server_default="pending",
    )

    handled_by_user_id: Mapped[str | None] = mapped_column(
        String(36),
        nullable=True,
    )
    handled_by_name: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
    )
    handled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
