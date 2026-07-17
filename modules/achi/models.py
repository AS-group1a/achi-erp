"""ACHI tables.

Namespace every table `achi_*` so we never collide with an upstream `oe_*` table.
This matters: schema is built by create_all (app/main.py:2553), not migrations,
and drift is healed only additively — a name collision would be ugly to unpick.
"""

from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, Numeric, String, func

from app.database import Base


class ScaffoldComponent(Base):
    """Placeholder proving the module owns real schema.

    Scaffolding is hire plant, so the real model will want weight, hire rate and
    replacement value — mirroring the custom Item fields we already run in Frappe.
    """

    __tablename__ = "achi_scaffold_component"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code = Column(String(64), nullable=False, unique=True, index=True)
    description = Column(String(255), nullable=False, default="")
    weight_kg = Column(Numeric(10, 3), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
