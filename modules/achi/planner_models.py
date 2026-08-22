"""Database models for ACHI's calendar-native Planner records.

Planner events describe time.  They may *link* to a Team Task or an operational
record, but they never duplicate either record or change its workflow.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AchiPlannerEvent(Base):
    """One calendar-native item in the ACHI Planner."""

    __tablename__ = "achi_planner_event"
    __table_args__ = (
        Index("ix_achi_planner_event_window", "start_at", "end_at"),
        Index("ix_achi_planner_event_organizer_window", "organizer_user_id", "start_at"),
        Index("ix_achi_planner_event_task", "related_task_id"),
        Index("ix_achi_planner_event_record", "related_record_type", "related_record_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )

    # meeting | appointment | event | reminder | time_block | task_block |
    # site_visit | call | follow_up | deadline
    event_type: Mapped[str] = mapped_column(String(32), nullable=False, default="event", server_default="event")
    # scheduled | cancelled
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="scheduled", server_default="scheduled")
    # team | private.  Private details are masked for other users by the API.
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="team", server_default="team")

    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # IANA name used to interpret/edit the time. Stored separately from the
    # timezone-aware instants so a calendar can retain its intended locale.
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Beirut", server_default="Asia/Beirut")

    location: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    meeting_url: Mapped[str] = mapped_column(String(1024), nullable=False, default="", server_default="")

    # User IDs intentionally do not use upstream FKs, matching Team Tasks.
    organizer_user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    organizer_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)

    # These are links only. They allow several task_block rows for one task.
    related_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    related_record_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    related_record_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    related_record_label: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")

    # Kept as standard RRULE text for a later recurrence phase. No future
    # occurrence rows are manufactured in this first phase.
    recurrence_rule: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    recurrence_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    reminders: Mapped[list["AchiPlannerReminder"]] = relationship(
        back_populates="event", cascade="all, delete-orphan", lazy="selectin"
    )
    attendees: Mapped[list["AchiPlannerEventAttendee"]] = relationship(
        back_populates="event", cascade="all, delete-orphan", lazy="selectin"
    )


class AchiPlannerReminder(Base):
    """One reminder offset for a Planner event."""

    __tablename__ = "achi_planner_reminder"
    __table_args__ = (
        Index("uq_achi_planner_reminder_event_offset", "event_id", "minutes_before", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_planner_event.id", ondelete="CASCADE"), nullable=False
    )
    minutes_before: Mapped[int] = mapped_column(Integer, nullable=False)
    # ``in_app`` is always available.  The background worker can additionally
    # deliver email when SMTP is explicitly configured in deployment.
    delivery: Mapped[str] = mapped_column(String(24), nullable=False, default="in_app", server_default="in_app")

    event: Mapped["AchiPlannerEvent"] = relationship(back_populates="reminders")


class AchiPlannerReminderDelivery(Base):
    """Idempotent record of one attempted reminder delivery.

    Occurrences are virtual for repeating events, so the occurrence start is
    part of the unique key.  This prevents a restarted worker from sending the
    same reminder twice.
    """

    __tablename__ = "achi_planner_reminder_delivery"
    __table_args__ = (
        Index(
            "uq_achi_planner_reminder_delivery_once",
            "event_id", "occurrence_start", "minutes_before", "recipient", "channel",
            unique=True,
        ),
        Index("ix_achi_planner_reminder_delivery_attempted", "attempted_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_planner_event.id", ondelete="CASCADE"), nullable=False
    )
    occurrence_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    minutes_before: Mapped[int] = mapped_column(Integer, nullable=False)
    recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    # email | push.  Push is reserved until VAPID/subscription configuration exists.
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", server_default="queued")
    error: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AchiPlannerEventAttendee(Base):
    """An internal ACHI user or an external person invited to one event."""

    __tablename__ = "achi_planner_event_attendee"
    __table_args__ = (
        Index("ix_achi_planner_attendee_user_window", "attendee_user_id", "event_id"),
        Index("ix_achi_planner_attendee_event", "event_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_planner_event.id", ondelete="CASCADE"), nullable=False
    )
    # No upstream FK by design; IDs/names remain meaningful after account changes.
    attendee_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    external_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="required", server_default="required")
    response_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", server_default="pending")

    event: Mapped["AchiPlannerEvent"] = relationship(back_populates="attendees")
