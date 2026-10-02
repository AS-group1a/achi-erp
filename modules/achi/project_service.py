"""Projects business rules: numbering, company separation and permissions."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .hr_models import COMPANIES, AchiHrEmployee
from .project_models import AchiProject, AchiProjectTask
from .project_schemas import (
    ProjectIn,
    ProjectOut,
    ProjectUpdate,
    TaskIn,
    TaskOut,
    TaskUpdate,
    project_code,
    task_code,
)

_WRITER_ROLES = frozenset({"admin", "manager", "editor"})
_MANAGER_ROLES = frozenset({"admin", "manager"})
# Transaction-scoped advisory locks serialise number allocation per company,
# so two people creating at once never receive the same PRJ-/TSK- number.
_PROJECT_NUMBER_LOCK = 681_246_101
_TASK_NUMBER_LOCK = 681_246_102
_COMPANY_INDEX = {key: index for index, key in enumerate(COMPANIES)}


def _now() -> datetime:
    return datetime.now(UTC)


class ProjectService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── people and permissions ──────────────────────────────────────────────

    async def actor(self, user_id: str) -> User:
        try:
            uid = uuid.UUID(str(user_id))
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authenticated user") from None
        user = (await self.session.execute(
            select(User).where(User.id == uid, User.is_active.is_(True))
        )).scalar_one_or_none()
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
        return user

    @staticmethod
    def role(user: User) -> str:
        return (user.role or "").strip().lower()

    async def require_writer(self, user_id: str) -> User:
        user = await self.actor(user_id)
        if self.role(user) not in _WRITER_ROLES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account can view Projects but not change them")
        return user

    async def require_manager(self, user_id: str) -> User:
        user = await self.actor(user_id)
        if self.role(user) not in _MANAGER_ROLES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers and admins can delete a project")
        return user

    async def access(self, user_id: str) -> dict:
        user = await self.actor(user_id)
        role = self.role(user)
        return {"role": role, "can_write": role in _WRITER_ROLES, "can_manage": role in _MANAGER_ROLES}

    async def _employee(self, employee_id: str | None, company: str) -> AchiHrEmployee | None:
        if not employee_id:
            return None
        row = await self.session.get(AchiHrEmployee, employee_id)
        if row is None or row.company != company:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That person is not an employee of this company")
        if not row.active:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That person is marked inactive in HR")
        return row

    async def _names(self, ids: set[str]) -> dict[str, str]:
        ids = {i for i in ids if i}
        if not ids:
            return {}
        rows = (await self.session.execute(
            select(AchiHrEmployee.id, AchiHrEmployee.full_name).where(AchiHrEmployee.id.in_(ids))
        )).all()
        return dict(rows)

    async def _next_number(self, model, lock_key: int, company: str) -> int:
        await self.session.execute(select(func.pg_advisory_xact_lock(lock_key, _COMPANY_INDEX[company])))
        current = (await self.session.execute(
            select(func.max(model.number)).where(model.company == company)
        )).scalar()
        return int(current or 0) + 1

    # ── projects ────────────────────────────────────────────────────────────

    async def _project(self, project_id: str, company: str | None = None) -> AchiProject:
        row = await self.session.get(AchiProject, project_id)
        if row is None or row.deleted_at is not None or (company and row.company != company):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        return row

    async def _project_out(self, rows: list[AchiProject]) -> list[ProjectOut]:
        ids = [row.id for row in rows]
        counts: dict[str, tuple[int, int]] = {}
        if ids:
            for project_id, total, done in (await self.session.execute(
                select(
                    AchiProjectTask.project_id,
                    func.count(),
                    func.sum(case((AchiProjectTask.status == "done", 1), else_=0)),
                )
                .where(AchiProjectTask.project_id.in_(ids), AchiProjectTask.deleted_at.is_(None))
                .group_by(AchiProjectTask.project_id)
            )).all():
                counts[project_id] = (int(total or 0), int(done or 0))
        names = await self._names({row.lead_employee_id for row in rows if row.lead_employee_id})
        return [
            ProjectOut(
                id=row.id, company=row.company, number=row.number, code=project_code(row.number),
                name=row.name, description=row.description, status=row.status, color=row.color,
                lead_employee_id=row.lead_employee_id, lead_name=names.get(row.lead_employee_id or ""),
                start_date=row.start_date, end_date=row.end_date,
                task_count=counts.get(row.id, (0, 0))[0], done_count=counts.get(row.id, (0, 0))[1],
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def list_projects(self, user_id: str, company: str) -> list[ProjectOut]:
        await self.actor(user_id)
        order = case({"active": 0, "planned": 1, "on_hold": 2, "done": 3}, value=AchiProject.status, else_=4)
        rows = (await self.session.execute(
            select(AchiProject)
            .where(AchiProject.company == company, AchiProject.deleted_at.is_(None))
            .order_by(order, AchiProject.number.desc())
        )).scalars().all()
        return await self._project_out(list(rows))

    async def create_project(self, user_id: str, data: ProjectIn) -> ProjectOut:
        user = await self.require_writer(user_id)
        await self._employee(data.lead_employee_id, data.company)
        row = AchiProject(
            **data.model_dump(),
            number=await self._next_number(AchiProject, _PROJECT_NUMBER_LOCK, data.company),
            created_by_user_id=str(user.id),
        )
        self.session.add(row)
        await self.session.commit()
        await self.session.refresh(row)
        return (await self._project_out([row]))[0]

    async def update_project(self, user_id: str, project_id: str, data: ProjectUpdate) -> ProjectOut:
        await self.require_writer(user_id)
        row = await self._project(project_id)
        changes = data.model_dump(exclude_unset=True)
        if "lead_employee_id" in changes:
            changes["lead_employee_id"] = changes["lead_employee_id"] or None
            await self._employee(changes["lead_employee_id"], row.company)
        start = changes.get("start_date", row.start_date)
        end = changes.get("end_date", row.end_date)
        if start and end and end < start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The end date cannot be before the start date")
        for key, value in changes.items():
            if value is None and key in {"name", "description", "status", "color"}:
                continue
            setattr(row, key, value)
        await self.session.commit()
        await self.session.refresh(row)
        return (await self._project_out([row]))[0]

    async def delete_project(self, user_id: str, project_id: str) -> None:
        """Soft delete: the project and its tasks disappear but stay recoverable."""
        await self.require_manager(user_id)
        row = await self._project(project_id)
        now = _now()
        row.deleted_at = now
        await self.session.execute(
            update(AchiProjectTask)
            .where(AchiProjectTask.project_id == row.id, AchiProjectTask.deleted_at.is_(None))
            .values(deleted_at=now)
        )
        await self.session.commit()

    # ── tasks ───────────────────────────────────────────────────────────────

    async def _task(self, task_id: str) -> AchiProjectTask:
        row = await self.session.get(AchiProjectTask, task_id)
        if row is None or row.deleted_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
        return row

    async def _task_out(self, rows: list[AchiProjectTask]) -> list[TaskOut]:
        project_ids = {row.project_id for row in rows}
        projects: dict[str, AchiProject] = {}
        if project_ids:
            projects = {
                p.id: p for p in (await self.session.execute(
                    select(AchiProject).where(AchiProject.id.in_(project_ids))
                )).scalars().all()
            }
        names = await self._names({row.assignee_employee_id for row in rows if row.assignee_employee_id})
        out = []
        for row in rows:
            project = projects.get(row.project_id)
            out.append(TaskOut(
                id=row.id, company=row.company, number=row.number, code=task_code(row.number),
                project_id=row.project_id,
                project_code=project_code(project.number) if project else "",
                project_name=project.name if project else "",
                project_color=project.color if project else "slate",
                title=row.title, description=row.description, status=row.status, priority=row.priority,
                assignee_employee_id=row.assignee_employee_id,
                assignee_name=names.get(row.assignee_employee_id or ""),
                start_date=row.start_date, due_date=row.due_date, position=row.position,
                created_at=row.created_at, completed_at=row.completed_at,
            ))
        return out

    async def _end_of_column(self, company: str, status_key: str) -> float:
        top = (await self.session.execute(
            select(func.max(AchiProjectTask.position)).where(
                AchiProjectTask.company == company,
                AchiProjectTask.status == status_key,
                AchiProjectTask.deleted_at.is_(None),
            )
        )).scalar()
        return float(top or 0) + 1

    async def list_tasks(self, user_id: str, company: str, project_id: str | None) -> list[TaskOut]:
        await self.actor(user_id)
        query = (
            select(AchiProjectTask)
            .join(AchiProject, AchiProject.id == AchiProjectTask.project_id)
            .where(
                AchiProjectTask.company == company,
                AchiProjectTask.deleted_at.is_(None),
                AchiProject.deleted_at.is_(None),
            )
        )
        if project_id:
            query = query.where(AchiProjectTask.project_id == project_id)
        rows = (await self.session.execute(
            query.order_by(AchiProjectTask.position, AchiProjectTask.number)
        )).scalars().all()
        return await self._task_out(list(rows))

    async def create_task(self, user_id: str, data: TaskIn) -> TaskOut:
        user = await self.require_writer(user_id)
        await self._project(data.project_id, data.company)
        await self._employee(data.assignee_employee_id, data.company)
        row = AchiProjectTask(
            **data.model_dump(),
            number=await self._next_number(AchiProjectTask, _TASK_NUMBER_LOCK, data.company),
            position=await self._end_of_column(data.company, data.status),
            created_by_user_id=str(user.id),
            completed_at=_now() if data.status == "done" else None,
        )
        self.session.add(row)
        await self.session.commit()
        await self.session.refresh(row)
        return (await self._task_out([row]))[0]

    async def update_task(self, user_id: str, task_id: str, data: TaskUpdate) -> TaskOut:
        await self.require_writer(user_id)
        row = await self._task(task_id)
        changes = data.model_dump(exclude_unset=True)
        if changes.get("project_id"):
            await self._project(changes["project_id"], row.company)
        if "assignee_employee_id" in changes:
            changes["assignee_employee_id"] = changes["assignee_employee_id"] or None
            await self._employee(changes["assignee_employee_id"], row.company)
        start = changes.get("start_date", row.start_date)
        due = changes.get("due_date", row.due_date)
        if start and due and due < start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The due date cannot be before the start date")
        new_status = changes.get("status")
        if new_status and new_status != row.status:
            row.completed_at = _now() if new_status == "done" else None
            # Moved to another column without a drop position: land at the bottom.
            if changes.get("position") is None:
                changes["position"] = await self._end_of_column(row.company, new_status)
        for key, value in changes.items():
            if value is None and key in {"project_id", "title", "description", "status", "priority", "position"}:
                continue
            setattr(row, key, value)
        await self.session.commit()
        await self.session.refresh(row)
        return (await self._task_out([row]))[0]

    async def delete_task(self, user_id: str, task_id: str) -> None:
        await self.require_writer(user_id)
        row = await self._task(task_id)
        row.deleted_at = _now()
        await self.session.commit()
