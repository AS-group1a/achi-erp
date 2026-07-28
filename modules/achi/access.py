"""Access control for the "limit staff to the ACHI pages" feature.

The rule (set by the business): everyone who was an active user when this was
switched on keeps full OpenConstructionERP access; every NEW account from then on
is limited to the ACHI pages. Admins are always full-access.

Enforcement is at the API level (see router.authz + the Caddy forward-auth gate):
OCE's auth token is a Bearer header that only rides on API calls, so blocking the
DATA is what protects the company — a limited user simply gets 403 on any non-ACHI
API. Page navigations carry no token and cannot be identified at the proxy, so a
force-opened OCE page loads empty (all its data calls 403) rather than being
physically blocked. Data-secure, not pixel-blocked.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .models import AchiFullAccess

# Paths a LIMITED user may still reach. Everything else is denied.
#   /api/v1/achi/        — our own pages and APIs
#   /api/v1/contacts/    — the Call Log directory (the ACHI pages read/write it)
#   /api/v1/branding/    — chrome.js reads the logo/company name (GET only)
#   /api/v1/users/auth/  — login, refresh, logout (needed to authenticate at all)
#   /api/v1/users/me     — self identity only; the SPA bootstraps with it
# Derived from the actual fetches the ACHI front-end makes (grep of ui/*): it
# calls exactly these plus its own /achi routes. Deliberately tight — a limited
# user gets 403 on everything else (leads, projects, estimating, admin, …).
LIMITED_ALLOW_PREFIXES: tuple[str, ...] = (
    "/api/v1/achi/",
    "/api/v1/contacts/",
    "/api/v1/branding/",
    "/api/v1/users/auth/",
    "/api/v1/users/me",
)


def limited_path_allowed(path: str) -> bool:
    """True if a limited (ACHI-only) user may reach this API path.

    Matches at a path-segment boundary so an allowed prefix cannot leak a
    sibling — e.g. ``/api/v1/users/me`` must NOT let ``/api/v1/users/members``
    through. The query string is ignored.
    """
    path = path.split("?", 1)[0]
    for p in LIMITED_ALLOW_PREFIXES:
        bare = p.rstrip("/")
        if path == bare or path.startswith(bare + "/"):
            return True
    return False


async def enforcement_active(session: AsyncSession) -> bool:
    """True once the grandfather list has been seeded.

    Enforcement is off until then, so shipping the reverse-proxy gate changes
    nothing until an admin runs ``seed-current``. Seeding IS the on-switch — and
    because it records exactly the users who exist at that moment, no current
    user can be locked out by flipping it on.
    """
    n = (await session.execute(select(func.count()).select_from(AchiFullAccess))).scalar_one()
    return n > 0


async def has_full_access(session: AsyncSession, user_id: str | None, role: str) -> bool:
    """Full access if the user is an admin or is on the grandfathered list."""
    if role == "admin":
        return True
    if not user_id:
        return False
    return await _row_for(session, user_id) is not None


async def _row_for(session: AsyncSession, user_id: str) -> AchiFullAccess | None:
    return (
        await session.execute(select(AchiFullAccess).where(AchiFullAccess.user_id == user_id))
    ).scalar_one_or_none()


async def seed_current_users(session: AsyncSession) -> int:
    """Grant full access to every currently-active user not already listed.

    Run once when switching the limit on. Idempotent: re-running only adds users
    who have appeared since and are still active — it never removes anyone.
    """
    active = (await session.execute(select(User.id).where(User.is_active.is_(True)))).scalars().all()
    existing = set((await session.execute(select(AchiFullAccess.user_id))).scalars().all())
    added = 0
    for uid in active:
        uid = str(uid)
        if uid not in existing:
            session.add(AchiFullAccess(user_id=uid, note="seeded (grandfathered)"))
            added += 1
    if added:
        await session.commit()
    return added


async def list_full_access(session: AsyncSession) -> list[AchiFullAccess]:
    return list((await session.execute(select(AchiFullAccess))).scalars())


async def grant(session: AsyncSession, user_id: str, note: str = "") -> None:
    if await _row_for(session, user_id) is None:
        session.add(AchiFullAccess(user_id=user_id, note=note or "granted"))
        await session.commit()


async def revoke(session: AsyncSession, user_id: str) -> bool:
    row = await _row_for(session, user_id)
    if row is None:
        return False
    await session.delete(row)
    await session.commit()
    return True
