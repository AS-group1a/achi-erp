"""Which companies (Achi Scaffolding / ARARA) a signed-in user may open.

The rule, decided by the business: Achi's users and Achi's HR must not reach
ARARA. HR is the source of truth:

* admins open both companies;
* everyone else opens the companies where HR lists an active employee linked
  to their login account;
* an account linked to nobody opens Achi Scaffolding only, so every existing
  Achi user keeps exactly what they had.

Enforced by the HR and Projects APIs; chrome.js only mirrors it in the menu.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .hr_models import COMPANIES, AchiHrEmployee

DEFAULT_COMPANY = "achi"


async def allowed_companies(session: AsyncSession, user: User) -> list[str]:
    if (user.role or "").strip().lower() == "admin":
        return list(COMPANIES)
    linked = set((await session.execute(
        select(AchiHrEmployee.company).where(
            AchiHrEmployee.user_id == str(user.id), AchiHrEmployee.active.is_(True),
        )
    )).scalars())
    return [key for key in COMPANIES if key in linked] or [DEFAULT_COMPANY]


async def require_company(session: AsyncSession, user: User, company: str) -> None:
    if company not in await allowed_companies(session, user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Your account cannot open {COMPANIES.get(company, company)}. "
            "An admin can link you to that company's HR to give access.",
        )


async def active_user(session: AsyncSession, user_id: str) -> User:
    try:
        uid = uuid.UUID(str(user_id))
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authenticated user") from None
    user = (await session.execute(
        select(User).where(User.id == uid, User.is_active.is_(True))
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
    return user
