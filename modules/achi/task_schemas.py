"""Strict request and response schemas for ACHI Team Tasks.

Supervisor and employee inputs are intentionally separate. This prevents an
employee from submitting supervisor-only fields such as assignee, priority,
completion state, or deletion state.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


TASK_STATUSES = (
    "unassigned",
    "to_do",
    "in_progress",
    "blocked",
    "ready_for_review",
    "completed",
    "cancelled",
)

TASK_PRIORITIES = (
    "low",
    "normal",
    "high",
    "urgent",
)

TaskStatus = Literal[
    "unassigned",
    "to_do",
    "in_progress",
    "blocked",
    "ready_for_review",
    "completed",
    "cancelled",
]

TaskPriority = Literal[
    "low",
    "normal",
    "high",
    "urgent",
]

TaskProgressAction = Literal[
    "start",
    "block",
    "resume",
    "submit",
]

WorkRequestStatus = Literal[
    "pending",
    "acknowledged",
    "cancelled",
]


class StrictInput(BaseModel):
    """Base for request bodies that must reject unknown fields."""

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
    )


class OrmOutput(BaseModel):
    """Base for responses built from SQLAlchemy model objects."""

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Supervisor task inputs
# ---------------------------------------------------------------------------


class TaskCreateIn(StrictInput):
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)

    assigned_to_user_id: str | None = Field(
        default=None,
        min_length=36,
        max_length=36,
    )
    priority: TaskPriority = "normal"
    due_at: datetime | None = None

    related_type: str | None = Field(default=None, min_length=1, max_length=32)
    related_id: str | None = Field(default=None, min_length=1, max_length=64)
    related_label: str = Field(default="", max_length=255)

    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: datetime | None) -> datetime | None:
        if value is not None and (
            value.tzinfo is None or value.utcoffset() is None
        ):
            raise ValueError("due_at must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_related_reference(self) -> "TaskCreateIn":
        if (self.related_type is None) != (self.related_id is None):
            raise ValueError(
                "related_type and related_id must either both be provided "
                "or both be omitted"
            )
        if self.related_label and self.related_id is None:
            raise ValueError(
                "related_label cannot be provided without related_id"
            )
        return self


class TaskUpdateIn(StrictInput):
    """Supervisor-editable fields.

    `assigned_to_user_id=null` explicitly unassigns a task.
    `due_at=null` explicitly clears its deadline.
    Status is deliberately absent and must use lifecycle endpoints.
    """

    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)

    assigned_to_user_id: str | None = Field(
        default=None,
        min_length=36,
        max_length=36,
    )
    priority: TaskPriority | None = None
    due_at: datetime | None = None

    related_type: str | None = Field(default=None, min_length=1, max_length=32)
    related_id: str | None = Field(default=None, min_length=1, max_length=64)
    related_label: str | None = Field(default=None, max_length=255)


    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: datetime | None) -> datetime | None:
        if value is not None and (
            value.tzinfo is None or value.utcoffset() is None
        ):
            raise ValueError("due_at must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_patch(self) -> "TaskUpdateIn":
        if not self.model_fields_set:
            raise ValueError("provide at least one field to update")

        non_nullable = ("title", "description", "priority", "related_label")
        for field_name in non_nullable:
            if (
                field_name in self.model_fields_set
                and getattr(self, field_name) is None
            ):
                raise ValueError(f"{field_name} cannot be null")

        return self


class TaskApproveIn(StrictInput):
    note: str = Field(default="", max_length=5_000)


class TaskReturnIn(StrictInput):
    note: str = Field(min_length=1, max_length=5_000)


class TaskCancelIn(StrictInput):
    reason: str = Field(min_length=1, max_length=2_000)


class TaskReopenIn(StrictInput):
    note: str = Field(min_length=1, max_length=2_000)


class TaskDeleteIn(StrictInput):
    reason: str = Field(min_length=1, max_length=2_000)


# ---------------------------------------------------------------------------
# Employee inputs
# ---------------------------------------------------------------------------


class TaskProgressIn(StrictInput):
    """The only lifecycle operations an assigned employee may request."""

    action: TaskProgressAction
    reason: str | None = Field(default=None, min_length=1, max_length=2_000)
    note: str = Field(default="", max_length=5_000)

    @model_validator(mode="after")
    def validate_action_fields(self) -> "TaskProgressIn":
        if self.action == "block":
            if not self.reason:
                raise ValueError("reason is required when blocking a task")
        elif self.reason is not None:
            raise ValueError("reason is only accepted for the block action")

        if self.action != "submit" and self.note:
            raise ValueError("note is only accepted for the submit action")

        return self


class TaskCommentCreateIn(StrictInput):
    body: str = Field(min_length=1, max_length=5_000)


class WorkRequestCreateIn(StrictInput):
    message: str = Field(default="", max_length=500)


# ---------------------------------------------------------------------------
# Safe API responses
# ---------------------------------------------------------------------------


class TaskOut(OrmOutput):
    id: str
    task_number: str

    title: str
    description: str
    status: TaskStatus
    priority: TaskPriority

    assigned_to_user_id: str | None
    assigned_to_name: str
    assigned_at: datetime | None

    created_by_user_id: str
    created_by_name: str

    due_at: datetime | None
    started_at: datetime | None

    blocked_at: datetime | None
    blocked_reason: str

    submitted_at: datetime | None
    completed_at: datetime | None
    completed_by_user_id: str | None
    completed_by_name: str
    review_note: str

    related_type: str | None
    related_id: str | None
    related_label: str

    is_deleted: bool
    deleted_at: datetime | None
    deleted_by_user_id: str | None

    created_at: datetime
    updated_at: datetime


class TaskListOut(BaseModel):
    items: list[TaskOut]
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)


class TaskAccessOut(BaseModel):
    user_id: str
    display_name: str
    role: str

    can_manage_team: bool
    can_progress_tasks: bool
    can_comment: bool
    can_request_work: bool


class TaskAssigneeOut(BaseModel):
    """Sanitized employee directory—never exposes passwords or tokens."""

    user_id: str
    display_name: str
    role: str


class TaskCommentOut(OrmOutput):
    id: str
    task_id: str
    author_user_id: str
    author_name: str
    body: str
    kind: str
    created_at: datetime
    updated_at: datetime


class TaskEventOut(OrmOutput):
    """Full audit history. The router will expose this to supervisors only."""

    id: str
    task_id: str
    actor_user_id: str
    actor_name: str
    event_type: str
    from_status: str | None
    to_status: str | None
    details: str
    created_at: datetime
    updated_at: datetime


class WorkRequestOut(OrmOutput):
    id: str
    requester_user_id: str
    requester_name: str
    message: str
    status: WorkRequestStatus

    handled_by_user_id: str | None
    handled_by_name: str
    handled_at: datetime | None

    created_at: datetime
    updated_at: datetime


class WorkRequestListOut(BaseModel):
    items: list[WorkRequestOut]
    total: int = Field(ge=0)


class MessageOut(BaseModel):
    detail: str