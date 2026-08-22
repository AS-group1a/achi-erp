"""Request and response contracts for the ACHI Planner."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


PLANNER_EVENT_TYPES = (
    "meeting", "appointment", "event", "reminder", "time_block",
    "task_block", "site_visit", "call", "follow_up", "deadline",
)
PLANNER_EVENT_STATUSES = ("scheduled", "cancelled")
PLANNER_VISIBILITIES = ("team", "private")

PlannerEventType = Literal[
    "meeting", "appointment", "event", "reminder", "time_block",
    "task_block", "site_visit", "call", "follow_up", "deadline",
]
PlannerEventStatus = Literal["scheduled", "cancelled"]
PlannerVisibility = Literal["team", "private"]
PlannerAttendeeRole = Literal["required", "optional"]
PlannerResponseStatus = Literal["pending", "accepted", "tentative", "declined"]


class PlannerInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PlannerAttendeeIn(PlannerInput):
    user_id: str | None = Field(default=None, min_length=1, max_length=36)
    external_name: str = Field(default="", max_length=255)
    external_email: str | None = Field(default=None, max_length=255)
    role: PlannerAttendeeRole = "required"

    @model_validator(mode="after")
    def valid_person(self) -> "PlannerAttendeeIn":
        if bool(self.user_id) == bool(self.external_email):
            raise ValueError("provide exactly one internal user or external email")
        if self.external_email and "@" not in self.external_email:
            raise ValueError("external_email must be an email address")
        return self


class PlannerAttendeeOut(BaseModel):
    id: str
    user_id: str | None
    display_name: str
    external_email: str | None
    role: PlannerAttendeeRole
    response_status: PlannerResponseStatus


def _validate_reminder_minutes(value: list[int]) -> list[int]:
    """Keep a predictable, bounded in-app reminder schedule."""
    if len(value) > 5:
        raise ValueError("at most five reminders are allowed")
    if any(minutes < 1 or minutes > 525_600 for minutes in value):
        raise ValueError("reminder minutes must be between 1 and 525600")
    if len(set(value)) != len(value):
        raise ValueError("reminder minutes must be unique")
    return sorted(value, reverse=True)


class PlannerEventCreateIn(PlannerInput):
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    event_type: PlannerEventType = "event"
    start_at: datetime
    end_at: datetime
    all_day: bool = False
    timezone: str = Field(default="Asia/Beirut", min_length=1, max_length=64)
    location: str = Field(default="", max_length=500)
    meeting_url: str = Field(default="", max_length=1024)
    visibility: PlannerVisibility = "team"
    reminder_minutes: list[int] = Field(default_factory=list)
    attendees: list[PlannerAttendeeIn] = Field(default_factory=list, max_length=100)
    recurrence_rule: str | None = Field(default=None, min_length=6, max_length=1024)
    recurrence_end_at: datetime | None = None
    related_task_id: str | None = Field(default=None, min_length=1, max_length=36)
    related_record_type: str | None = Field(default=None, min_length=1, max_length=32)
    related_record_id: str | None = Field(default=None, min_length=1, max_length=64)
    related_record_label: str = Field(default="", max_length=255)

    @field_validator("start_at", "end_at", "recurrence_end_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        # ``recurrence_end_at`` is optional.  The UI intentionally submits
        # null when a repeating event has no end date, so only actual datetime
        # values need timezone validation.
        if value is None:
            return value
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("datetime values must include a timezone")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value

    @field_validator("reminder_minutes")
    @classmethod
    def valid_reminders(cls, value: list[int]) -> list[int]:
        return _validate_reminder_minutes(value)

    @model_validator(mode="after")
    def valid_window_and_links(self) -> "PlannerEventCreateIn":
        if self.end_at <= self.start_at:
            raise ValueError("end_at must be after start_at")
        if (self.related_record_type is None) != (self.related_record_id is None):
            raise ValueError("related_record_type and related_record_id must be provided together")
        if self.related_record_label and self.related_record_id is None:
            raise ValueError("related_record_label requires a related record")
        if self.recurrence_end_at is not None and self.recurrence_end_at < self.start_at:
            raise ValueError("recurrence_end_at must not be before start_at")
        return self


class PlannerEventUpdateIn(PlannerInput):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    event_type: PlannerEventType | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    all_day: bool | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    location: str | None = Field(default=None, max_length=500)
    meeting_url: str | None = Field(default=None, max_length=1024)
    visibility: PlannerVisibility | None = None
    reminder_minutes: list[int] | None = None
    attendees: list[PlannerAttendeeIn] | None = Field(default=None, max_length=100)
    recurrence_rule: str | None = Field(default=None, min_length=6, max_length=1024)
    recurrence_end_at: datetime | None = None
    status: PlannerEventStatus | None = None
    related_task_id: str | None = Field(default=None, min_length=1, max_length=36)
    related_record_type: str | None = Field(default=None, min_length=1, max_length=32)
    related_record_id: str | None = Field(default=None, min_length=1, max_length=64)
    related_record_label: str | None = Field(default=None, max_length=255)

    @field_validator("start_at", "end_at", "recurrence_end_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("datetime values must include a timezone")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value

    @field_validator("reminder_minutes")
    @classmethod
    def valid_reminders(cls, value: list[int] | None) -> list[int] | None:
        return None if value is None else _validate_reminder_minutes(value)

    @model_validator(mode="after")
    def nonempty_patch(self) -> "PlannerEventUpdateIn":
        if not self.model_fields_set:
            raise ValueError("provide at least one field to update")
        return self


class PlannerTaskBlockCreateIn(PlannerInput):
    """Create one scheduling block linked to an existing Team Task."""

    task_id: str = Field(min_length=1, max_length=36)
    start_at: datetime
    end_at: datetime
    timezone: str = Field(default="Asia/Beirut", min_length=1, max_length=64)

    @field_validator("start_at", "end_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("datetime values must include a timezone")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value

    @model_validator(mode="after")
    def valid_window(self) -> "PlannerTaskBlockCreateIn":
        if self.end_at <= self.start_at:
            raise ValueError("end_at must be after start_at")
        return self


class PlannerRsvpIn(PlannerInput):
    response_status: PlannerResponseStatus


class PlannerConflictQueryIn(PlannerInput):
    user_ids: list[str] = Field(min_length=1, max_length=100)
    start_at: datetime
    end_at: datetime
    exclude_event_id: str | None = Field(default=None, max_length=36)

    @field_validator("start_at", "end_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("datetime values must include a timezone")
        return value

    @model_validator(mode="after")
    def valid_window(self) -> "PlannerConflictQueryIn":
        if self.end_at <= self.start_at:
            raise ValueError("end_at must be after start_at")
        return self


class PlannerConflictOut(BaseModel):
    user_id: str
    display_name: str
    start_at: datetime
    end_at: datetime
    title: str


class PlannerEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    description: str
    event_type: PlannerEventType
    status: PlannerEventStatus
    visibility: PlannerVisibility
    start_at: datetime
    end_at: datetime
    all_day: bool
    timezone: str
    location: str
    meeting_url: str
    reminder_minutes: list[int] = Field(default_factory=list)
    attendees: list[PlannerAttendeeOut] = Field(default_factory=list)
    organizer_user_id: str
    organizer_name: str
    created_by_user_id: str
    related_task_id: str | None
    related_record_type: str | None
    related_record_id: str | None
    related_record_label: str
    recurrence_rule: str | None
    recurrence_end_at: datetime | None
    instance_key: str
    created_at: datetime
    updated_at: datetime


class PlannerEventListOut(BaseModel):
    items: list[PlannerEventOut]


class PlannerTaskOut(BaseModel):
    id: str
    task_number: str
    title: str
    priority: str
    task_type: str
    status: str
    assigned_to_name: str
    due_at: datetime | None
    scheduled_block_count: int = 0


class PlannerTaskListOut(BaseModel):
    items: list[PlannerTaskOut]


class PlannerUserOut(BaseModel):
    user_id: str
    display_name: str
    role: str


class PlannerRelatedRecordOut(BaseModel):
    """A lightweight existing ACHI record offered as a Planner link target."""

    record_type: Literal["contact_file"]
    record_id: str
    label: str
    stage: str
    location: str = ""


class PlannerSourceEventOut(BaseModel):
    """A read-only calendar projection owned by another ACHI module."""

    id: str
    title: str
    start_at: datetime
    end_at: datetime
    all_day: bool = True
    event_type: Literal["follow_up", "site_visit"] = "follow_up"
    visibility: PlannerVisibility = "team"
    source: Literal["crm_follow_up", "site_visit"] = "crm_follow_up"
    related_record_type: Literal["contact_file", "site_survey"]
    related_record_id: str
    related_record_label: str
