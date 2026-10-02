"""HR routes, mounted under /api/v1/achi/hr by router.py.

Everyone signed in may read a company's employee list (Projects assigns work
from it); only managers and admins may change it.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select

from app.dependencies import CurrentUserId, SessionDep
from app.modules.users.models import User

from .hr_models import COMPANIES, AchiHrEmployee
from .project_models import AchiProjectTask

hr_router = APIRouter(prefix="/hr")
_UI_DIR = Path(__file__).parent / "ui"
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}

Company = Literal["achi", "arara"]
_MANAGER_ROLES = frozenset({"admin", "manager"})


class EmployeeIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    company: Company
    full_name: str = Field(min_length=1, max_length=255)
    job_title: str = Field(default="", max_length=128)
    team: str = Field(default="", max_length=128)
    email: str = Field(default="", max_length=255)
    phone: str = Field(default="", max_length=64)
    user_id: str | None = Field(default=None, max_length=36)
    notes: str = Field(default="", max_length=5000)
    active: bool = True

    @field_validator("email")
    @classmethod
    def _email_shape(cls, value: str) -> str:
        if value and "@" not in value:
            raise ValueError("email must be an email address")
        return value.lower()


class EmployeeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    job_title: str | None = Field(default=None, max_length=128)
    team: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    user_id: str | None = Field(default=None, max_length=36)
    notes: str | None = Field(default=None, max_length=5000)
    active: bool | None = None

    @field_validator("email")
    @classmethod
    def _email_shape(cls, value: str | None) -> str | None:
        if value and "@" not in value:
            raise ValueError("email must be an email address")
        return value.lower() if value else value


class EmployeeOut(BaseModel):
    id: str
    company: Company
    full_name: str
    job_title: str
    team: str
    email: str
    phone: str
    user_id: str | None
    user_name: str | None = None
    notes: str
    active: bool
    open_tasks: int = 0


async def _user(session, user_id: str) -> User:
    try:
        uid = uuid.UUID(str(user_id))
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authenticated user") from None
    user = (await session.execute(select(User).where(User.id == uid, User.is_active.is_(True)))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
    return user


async def _require_manager(session, user_id: str) -> User:
    user = await _user(session, user_id)
    if (user.role or "").strip().lower() not in _MANAGER_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers and admins can change HR records")
    return user


async def _check_login(session, user_id: str | None) -> None:
    """A linked login account must be a real, active user."""
    if not user_id:
        return
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "user_id must be a valid user") from None
    if (await session.execute(select(User.id).where(User.id == uid, User.is_active.is_(True)))).first() is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The linked login account is not an active user")


async def _out(session, rows: list[AchiHrEmployee]) -> list[EmployeeOut]:
    ids = [row.id for row in rows]
    counts: dict[str, int] = {}
    if ids:
        counts = dict((await session.execute(
            select(AchiProjectTask.assignee_employee_id, func.count())
            .where(
                AchiProjectTask.assignee_employee_id.in_(ids),
                AchiProjectTask.deleted_at.is_(None),
                AchiProjectTask.status != "done",
            )
            .group_by(AchiProjectTask.assignee_employee_id)
        )).all())
    user_ids = []
    for row in rows:
        if not row.user_id:
            continue
        try:
            user_ids.append(uuid.UUID(row.user_id))
        except ValueError:
            pass
    names: dict[str, str] = {}
    if user_ids:
        users = (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        names = {str(u.id): (u.full_name or u.email or "").strip() for u in users}
    return [
        EmployeeOut(
            id=row.id, company=row.company, full_name=row.full_name, job_title=row.job_title,
            team=row.team, email=row.email, phone=row.phone, user_id=row.user_id,
            user_name=names.get(row.user_id or ""), notes=row.notes, active=row.active,
            open_tasks=counts.get(row.id, 0),
        )
        for row in rows
    ]


@hr_router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def hr_ui() -> HTMLResponse:
    return HTMLResponse((_UI_DIR / "hr.html").read_text(encoding="utf-8"), headers=_NO_STORE)


@hr_router.get("/hr.js", response_class=PlainTextResponse, include_in_schema=False)
def hr_js() -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / "hr.js").read_text(encoding="utf-8"), media_type="application/javascript", headers=_NO_STORE)


@hr_router.get("/companies")
async def list_companies() -> list[dict[str, str]]:
    return [{"key": key, "label": label} for key, label in COMPANIES.items()]


@hr_router.get("/me")
async def hr_me(session: SessionDep, user_id: CurrentUserId) -> dict:
    """Who is asking and whether they may edit HR records."""
    user = await _user(session, user_id)
    role = (user.role or "").strip().lower()
    return {"user_id": str(user.id), "role": role, "can_manage": role in _MANAGER_ROLES}


@hr_router.get("/users")
async def list_login_users(session: SessionDep, user_id: CurrentUserId) -> list[dict[str, str]]:
    """Active login accounts an employee can be linked to."""
    await _user(session, user_id)
    users = (await session.execute(
        select(User).where(User.is_active.is_(True)).order_by(User.full_name, User.email)
    )).scalars().all()
    return [{"user_id": str(u.id), "name": (u.full_name or "").strip() or u.email, "email": u.email} for u in users]


@hr_router.get("/employees", response_model=list[EmployeeOut])
async def list_employees(
    session: SessionDep,
    user_id: CurrentUserId,
    company: Annotated[Company, Query()],
    include_inactive: Annotated[bool, Query()] = False,
) -> list[EmployeeOut]:
    await _user(session, user_id)
    query = select(AchiHrEmployee).where(AchiHrEmployee.company == company)
    if not include_inactive:
        query = query.where(AchiHrEmployee.active.is_(True))
    rows = (await session.execute(query.order_by(AchiHrEmployee.full_name))).scalars().all()
    return await _out(session, list(rows))


@hr_router.post("/employees", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
async def create_employee(data: EmployeeIn, session: SessionDep, user_id: CurrentUserId) -> EmployeeOut:
    await _require_manager(session, user_id)
    await _check_login(session, data.user_id)
    row = AchiHrEmployee(**data.model_dump())
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return (await _out(session, [row]))[0]


@hr_router.patch("/employees/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: str, data: EmployeeUpdate, session: SessionDep, user_id: CurrentUserId,
) -> EmployeeOut:
    await _require_manager(session, user_id)
    row = await session.get(AchiHrEmployee, employee_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    changes = data.model_dump(exclude_unset=True)
    if "user_id" in changes:
        changes["user_id"] = changes["user_id"] or None
        await _check_login(session, changes["user_id"])
    for key, value in changes.items():
        if value is None and key != "user_id":
            continue
        setattr(row, key, value)
    await session.commit()
    await session.refresh(row)
    return (await _out(session, [row]))[0]


@hr_router.delete("/employees/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_employee(employee_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    """Remove someone added by mistake. People with tasks are deactivated instead,
    so the tasks keep showing who did them."""
    await _require_manager(session, user_id)
    row = await session.get(AchiHrEmployee, employee_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found")
    has_tasks = (await session.execute(
        select(AchiProjectTask.id).where(AchiProjectTask.assignee_employee_id == employee_id).limit(1)
    )).first()
    if has_tasks is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This person has tasks. Mark them inactive instead, so their tasks keep their name.",
        )
    await session.delete(row)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
