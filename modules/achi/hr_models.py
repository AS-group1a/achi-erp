"""HR: the people of each company (Achi Scaffolding and ARARA).

Employees are not login accounts. A technician or developer can be assigned
work without ever signing in; ``user_id`` optionally links the person to the
account they use when they do.
"""

from __future__ import annotations

import uuid

from sqlalchemy import Boolean, DateTime, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# The two companies the system serves. Every HR and Projects row belongs to
# exactly one of them, and nothing is shared between them.
COMPANIES: dict[str, str] = {"achi": "Achi Scaffolding", "arara": "ARARA"}


class AchiHrEmployee(Base):
    """One person employed by Achi Scaffolding or ARARA."""

    __tablename__ = "achi_hr_employee"
    __table_args__ = (Index("ix_achi_hr_employee_company_active", "company", "active"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    job_title: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    # Free text so a company can name its own teams ("Backend", "Site crew 2").
    team: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    phone: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    # No FK to the upstream users table, matching Team Tasks and Planner.
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
