"""Projects and their tasks, kept per company (Achi Scaffolding or ARARA).

A brand-new module for the tech teams; it does not reuse Team Tasks
(task_models.py). Tasks are assigned to HR employees (hr_models.py), not to
login accounts, so people who never sign in can still own work.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

PROJECT_STATUSES = ("planned", "active", "on_hold", "done")
# Board columns, left to right.
TASK_STATUSES = ("backlog", "todo", "in_progress", "review", "done")
TASK_PRIORITIES = ("low", "normal", "high", "urgent")


class AchiProject(Base):
    """A body of work (a product, a feature, a job) owned by one company."""

    __tablename__ = "achi_project"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_project_company_number"),
        Index("ix_achi_project_company_status", "company", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    # PRJ-<number>, sequential within the company.
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", server_default="active")
    # One of the page's palette keys, so a project keeps its colour everywhere.
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="blue", server_default="blue")
    lead_employee_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AchiProjectTask(Base):
    """One piece of work inside a project."""

    __tablename__ = "achi_project_task"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_project_task_company_number"),
        Index("ix_achi_project_task_company_status", "company", "status"),
        Index("ix_achi_project_task_project", "achi_project_id"),
        Index("ix_achi_project_task_assignee", "assignee_employee_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    # TSK-<number>, sequential within the company.
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # Stored as achi_project_id on purpose: the ERP treats any table with a
    # column literally named "project_id" as belonging to one of ITS projects
    # (projects/service.py deletes those rows with an ERP project; backups
    # scope by it). These tasks belong to an achi_project, not an ERP project.
    project_id: Mapped[str] = mapped_column("achi_project_id", String(36), ForeignKey("achi_project.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="todo", server_default="todo")
    priority: Mapped[str] = mapped_column(String(16), nullable=False, default="normal", server_default="normal")
    assignee_employee_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Order inside a board column; lower first. Floats let a card be dropped
    # between two others without renumbering the column.
    position: Mapped[float] = mapped_column(Float, nullable=False, default=0, server_default="0")
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
