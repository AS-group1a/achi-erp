"""Users — create staff accounts and choose what each one may open.

Modelled on OpenConstructionERP's own Users admin (app/modules/users/router.py:
admin_create_user / update_user), and it goes through the same UserService so
passwords, the role whitelist and the role-change audit trail behave exactly
as they do there. What this page adds on top:

  * ERP access  — full OpenConstructionERP vs ACHI pages only (access.py);
  * Page access — which ACHI pages the user sees (AchiPageAccess).

Page access is a navigation rule, not a data wall: the ACHI pages share their
data APIs (the Log, Contacts and Files pages all read /logs), so a blocked page
is hidden from the menu and shows "no access" if opened, while the data rules
stay those of the role and the ERP-access gate.

Everything that changes an account is admin-only; any user may ask which
pages they themselves may open (chrome.js does, on every ACHI page).
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import select

from app.dependencies import CurrentUserId, OptionalUserPayload, RequireRole, SessionDep, SettingsDep
from app.modules.users.models import User
from app.modules.users.schemas import AdminUserCreate, _validate_strong_password
from app.modules.users.service import UserService, hash_password

from .models import AchiFullAccess, AchiPageAccess

users_router = APIRouter(prefix="/users")

_UI_DIR = Path(__file__).parent / "ui"

# The pages a user can be given, in menu order. ``paths`` are the page
# addresses chrome.js matches against location.pathname to hide the menu link
# and to show "no access" when a blocked page is opened directly.
PAGES: list[dict] = [
    {"key": "log", "label": "Log", "hint": "Call log and General Log",
     "paths": ["/api/v1/achi/ui", "/api/v1/achi/general-log/ui"]},
    {"key": "contacts", "label": "Contacts", "hint": "People and companies",
     "paths": ["/api/v1/achi/contact-info/ui"]},
    {"key": "crm", "label": "CRM", "hint": "Enquiry pipeline and prospects",
     "paths": ["/api/v1/achi/crm/ui", "/api/v1/achi/prospect/ui"]},
    {"key": "site_visit", "label": "Site Visit", "hint": "Site visits and surveys",
     "paths": ["/api/v1/achi/site-visit/ui", "/api/v1/achi/survey/ui"]},
    {"key": "files", "label": "Files", "hint": "Enquiry files",
     "paths": ["/api/v1/achi/files/ui"]},
    {"key": "workspaces", "label": "Stage workspaces", "hint": "Drawing, M/T, BOQ, Resources, Plan, Quotation",
     "paths": ["/api/v1/achi/draw/ui", "/api/v1/achi/mt/ui", "/api/v1/achi/boq/ui",
               "/api/v1/achi/resource/ui", "/api/v1/achi/plan/ui", "/api/v1/achi/quotation/ui"]},
    {"key": "planner", "label": "Planner", "hint": "Schedules and reminders",
     "paths": ["/api/v1/achi/planner/ui"]},
    {"key": "tasks", "label": "Team Tasks", "hint": "Assign and follow up tasks",
     "paths": ["/api/v1/achi/tasks/ui"]},
]
PAGE_KEYS = [p["key"] for p in PAGES]

Role = Literal["admin", "manager", "editor", "viewer"]


class UserRowOut(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime | None
    full_access: bool       # full OpenConstructionERP, not just the ACHI pages
    pages: list[str]        # page keys this user may open (all of them when unrestricted)
    all_pages: bool         # True when no page is restricted


class UserCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    email: EmailStr
    full_name: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=12, max_length=128)
    role: Role = "editor"
    is_active: bool = True
    full_access: bool = False
    pages: list[str] | None = None   # None = every page


class UserUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    role: Role | None = None
    is_active: bool | None = None
    full_access: bool | None = None
    pages: list[str] | None = None
    all_pages: bool | None = None    # True clears any page restriction
    password: str | None = Field(default=None, min_length=12, max_length=128)

    @field_validator("password")
    @classmethod
    def _strong(cls, v: str | None) -> str | None:
        return _validate_strong_password(v) if v else v


def _clean_pages(pages: list[str] | None) -> list[str] | None:
    if pages is None:
        return None
    unknown = [p for p in pages if p not in PAGE_KEYS]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown page: {', '.join(unknown)}")
    return [k for k in PAGE_KEYS if k in pages]


async def _page_row(session, user_id: str) -> AchiPageAccess | None:
    return (
        await session.execute(select(AchiPageAccess).where(AchiPageAccess.user_id == user_id))
    ).scalar_one_or_none()


async def _set_pages(session, user_id: str, pages: list[str] | None) -> None:
    """None (or every page ticked) removes the restriction entirely."""
    row = await _page_row(session, user_id)
    if pages is None or set(pages) == set(PAGE_KEYS):
        if row is not None:
            await session.delete(row)
        return
    if row is None:
        session.add(AchiPageAccess(user_id=user_id, pages=json.dumps(pages)))
    else:
        row.pages = json.dumps(pages)


async def _set_full_access(session, user_id: str, on: bool) -> None:
    row = (
        await session.execute(select(AchiFullAccess).where(AchiFullAccess.user_id == user_id))
    ).scalar_one_or_none()
    if on and row is None:
        session.add(AchiFullAccess(user_id=user_id, note="granted from Users page"))
    elif not on and row is not None:
        await session.delete(row)


def _pages_of(row: AchiPageAccess | None, role: str) -> list[str] | None:
    """Allowed page keys, or None for every page."""
    if role == "admin" or row is None:
        return None
    try:
        saved = json.loads(row.pages or "[]")
    except ValueError:
        return None
    return [k for k in PAGE_KEYS if k in saved]


def _row_out(user: User, full: set[str], page_rows: dict[str, AchiPageAccess]) -> UserRowOut:
    uid = str(user.id)
    pages = _pages_of(page_rows.get(uid), user.role)
    return UserRowOut(
        id=uid,
        email=user.email,
        full_name=user.full_name or "",
        role=user.role,
        is_active=user.is_active,
        last_login_at=user.last_login_at,
        created_at=getattr(user, "created_at", None),
        full_access=user.role == "admin" or uid in full,
        pages=list(PAGE_KEYS) if pages is None else pages,
        all_pages=pages is None,
    )


async def _lookups(session) -> tuple[set[str], dict[str, AchiPageAccess]]:
    full = set((await session.execute(select(AchiFullAccess.user_id))).scalars().all())
    rows = (await session.execute(select(AchiPageAccess))).scalars().all()
    return full, {r.user_id: r for r in rows}


async def _one(session, user_id: str) -> UserRowOut:
    user = await session.get(User, uuid.UUID(user_id))
    if user is None or user.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    full, rows = await _lookups(session)
    return _row_out(user, full, rows)


@users_router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def users_ui() -> HTMLResponse:
    """The Users page. A static shell like every ACHI page; its data calls are
    admin-only below."""
    return HTMLResponse(
        (_UI_DIR / "users.html").read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@users_router.get("/pages")
async def list_pages() -> list[dict]:
    return [{k: p[k] for k in ("key", "label", "hint", "paths")} for p in PAGES]


@users_router.get("/me/pages")
async def my_pages(session: SessionDep, payload: OptionalUserPayload = None) -> dict:
    """Which pages the caller may open. Anyone may ask about themselves; an
    unidentified caller gets every page so nothing is hidden before login."""
    everything = {"all": True, "pages": PAGE_KEYS, "blocked_paths": [], "is_admin": False}
    if not payload or not payload.get("sub"):
        return everything
    try:
        user = await session.get(User, uuid.UUID(payload["sub"]))
    except ValueError:
        return everything
    if user is None:
        return everything
    pages = _pages_of(await _page_row(session, str(user.id)), user.role)
    if pages is None:
        return {**everything, "is_admin": user.role == "admin"}
    blocked = [path for p in PAGES if p["key"] not in pages for path in p["paths"]]
    return {"all": False, "pages": pages, "blocked_paths": blocked, "is_admin": False}


@users_router.get("/", dependencies=[Depends(RequireRole("admin"))])
async def list_users(session: SessionDep) -> list[UserRowOut]:
    users = (
        await session.execute(select(User).where(User.deleted_at.is_(None)).order_by(User.full_name, User.email))
    ).scalars().all()
    full, rows = await _lookups(session)
    return [_row_out(u, full, rows) for u in users]


@users_router.post("/", status_code=201, dependencies=[Depends(RequireRole("admin"))])
async def create_user(data: UserCreateIn, session: SessionDep, settings: SettingsDep) -> UserRowOut:
    pages = _clean_pages(data.pages)
    try:
        # Same schema + service as OCE's own "Add user" — password strength,
        # role whitelist and duplicate-email 409 all come from there.
        spec = AdminUserCreate(
            email=data.email, password=data.password, full_name=data.full_name,
            role=data.role, is_active=data.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, _first_error(exc)) from exc
    user = await UserService(session, settings).admin_create(spec)
    uid = str(user.id)
    await _set_full_access(session, uid, data.full_access)
    await _set_pages(session, uid, pages)
    await session.commit()
    return await _one(session, uid)


@users_router.patch("/{user_id}", dependencies=[Depends(RequireRole("admin"))])
async def update_user(
    user_id: str, data: UserUpdateIn, session: SessionDep, settings: SettingsDep, actor_id: CurrentUserId
) -> UserRowOut:
    try:
        uid = uuid.UUID(user_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found") from exc
    user = await session.get(User, uid)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    # An admin cannot lock themselves out from this page.
    if str(uid) == str(actor_id):
        if data.role is not None and data.role != "admin":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't remove your own admin role.")
        if data.is_active is False:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't deactivate your own account.")

    fields: dict = {}
    for name in ("full_name", "role", "is_active"):
        value = getattr(data, name)
        if value is not None:
            fields[name] = value
    if fields:
        # Through UserService so a role change writes OCE's audit entry.
        await UserService(session, settings).update_profile(uid, **fields)
    if data.password:
        # Bumping password_changed_at signs the user out of existing sessions,
        # the same way OCE's own password change does.
        await UserService(session, settings).user_repo.update_fields(
            uid, hashed_password=hash_password(data.password), password_changed_at=datetime.now(UTC)
        )
    if data.full_access is not None:
        await _set_full_access(session, str(uid), data.full_access)
    if data.all_pages:
        await _set_pages(session, str(uid), None)
    elif data.pages is not None:
        await _set_pages(session, str(uid), _clean_pages(data.pages))
    await session.commit()
    return await _one(session, str(uid))


def _first_error(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if callable(errors):
        try:
            first = errors()[0]
            return str(first.get("msg", exc)).removeprefix("Value error, ")
        except (IndexError, TypeError):
            pass
    return str(exc)
