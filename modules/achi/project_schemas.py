"""Request and response shapes for Projects."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Company = Literal["achi", "arara"]
ProjectStatus = Literal["planned", "active", "on_hold", "done"]
TaskStatus = Literal["backlog", "todo", "in_progress", "review", "done"]
TaskPriority = Literal["low", "normal", "high", "urgent"]
# Palette keys the page knows how to draw.
ProjectColor = Literal["blue", "teal", "green", "amber", "red", "purple", "slate"]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _check_window(start: date | None, end: date | None, what: str) -> None:
    if start and end and end < start:
        raise ValueError(f"{what} cannot be before the start date")


class ProjectIn(_In):
    company: Company
    name: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    status: ProjectStatus = "active"
    color: ProjectColor = "blue"
    lead_employee_id: str | None = Field(default=None, max_length=36)
    start_date: date | None = None
    end_date: date | None = None

    @model_validator(mode="after")
    def _window(self) -> "ProjectIn":
        _check_window(self.start_date, self.end_date, "The end date")
        return self


class ProjectUpdate(_In):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    status: ProjectStatus | None = None
    color: ProjectColor | None = None
    lead_employee_id: str | None = Field(default=None, max_length=36)
    start_date: date | None = None
    end_date: date | None = None


class ProjectOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    name: str
    description: str
    status: ProjectStatus
    color: ProjectColor
    lead_employee_id: str | None
    lead_name: str | None = None
    start_date: date | None
    end_date: date | None
    task_count: int = 0
    done_count: int = 0
    created_at: datetime | None = None


class TaskIn(_In):
    company: Company
    project_id: str = Field(min_length=1, max_length=36)
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    status: TaskStatus = "todo"
    priority: TaskPriority = "normal"
    assignee_employee_id: str | None = Field(default=None, max_length=36)
    start_date: date | None = None
    due_date: date | None = None

    @model_validator(mode="after")
    def _window(self) -> "TaskIn":
        _check_window(self.start_date, self.due_date, "The due date")
        return self


class TaskUpdate(_In):
    project_id: str | None = Field(default=None, min_length=1, max_length=36)
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    assignee_employee_id: str | None = Field(default=None, max_length=36)
    start_date: date | None = None
    due_date: date | None = None
    position: float | None = None


class TaskOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    project_id: str
    project_code: str
    project_name: str
    project_color: ProjectColor
    title: str
    description: str
    status: TaskStatus
    priority: TaskPriority
    assignee_employee_id: str | None
    assignee_name: str | None = None
    start_date: date | None
    due_date: date | None
    position: float
    created_at: datetime | None = None
    completed_at: datetime | None = None


def project_code(number: int) -> str:
    return f"PRJ-{number}"


def task_code(number: int) -> str:
    return f"TSK-{number}"
