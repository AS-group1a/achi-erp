"""Business logic and authorization for ACHI Team Tasks.

Every write is authorized again here even when its route also has a role
dependency. Task mutations lock the row, update it, and append the audit event
in the same database transaction.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, NoReturn, Sequence

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .task_models import (
    AchiTask,
    AchiTaskComment,
    AchiTaskEvent,
    AchiTaskWorkRequest,
)
from .task_schemas import (
    TASK_PRIORITIES,
    TASK_STATUSES,
    TaskAccessOut,
    TaskApproveIn,
    TaskAssigneeOut,
    TaskCancelIn,
    TaskCommentCreateIn,
    TaskCreateIn,
    TaskDeleteIn,
    TaskListOut,
    TaskOut,
    TaskProgressIn,
    TaskReopenIn,
    TaskReturnIn,
    TaskUpdateIn,
    WorkRequestCreateIn,
    WorkRequestListOut,
    WorkRequestOut,
)


_MANAGER_ROLES = frozenset({"admin", "manager"})
_WRITER_ROLES = frozenset({"admin", "manager", "editor"})
_TERMINAL_STATUSES = frozenset({"completed", "cancelled"})
_WORK_REQUEST_STATUSES = frozenset(
    {"pending", "acknowledged", "cancelled"}
)

_PENDING_REQUEST_CONSTRAINT = (
    "uq_achi_task_work_request_pending_user"
)

_TASK_EVENT_TYPES = frozenset(
    {
        "created",
        "assigned",
        "reassigned",
        "unassigned",
        "updated",
        "started",
        "blocked",
        "resumed",
        "submitted",
        "approved",
        "returned",
        "cancelled",
        "reopened",
        "deleted",
        "comment_added",
    }
)


@dataclass(frozen=True)
class TaskActor:
    """Safe task identity loaded from the live upstream User row."""

    id: str
    display_name: str
    role: str

    @property
    def is_manager(self) -> bool:
        return self.role in _MANAGER_ROLES

    @property
    def can_write(self) -> bool:
        return self.role in _WRITER_ROLES


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _not_found(detail: str = "Task not found") -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=detail,
    )


def _forbidden(detail: str) -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=detail,
    )


def _conflict(detail: str) -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=detail,
    )


def _unprocessable(detail: str) -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=detail,
    )


def _display_name(user: User) -> str:
    """Return a safe display name without exposing the user's email."""

    name = (user.full_name or "").strip()
    return name or f"User {str(user.id)[:8]}"


def _canonical_uuid(value: str, *, detail: str) -> str:
    """Validate a UUID and return its canonical string form."""

    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        _unprocessable(detail)


def _new_task_identity() -> tuple[str, str]:
    """Return a UUID primary key and collision-resistant task number.

    Base32 represents all 128 UUID bits in 26 characters. ``TASK-`` plus that
    token fits the model's String(32) without using unsafe MAX + 1 numbering.
    """

    task_uuid = uuid.uuid4()
    token = (
        base64.b32encode(task_uuid.bytes)
        .decode("ascii")
        .rstrip("=")
    )
    return str(task_uuid), f"TASK-{token}"


def _json_details(details: dict[str, Any] | None) -> str:
    if not details:
        return ""

    return json.dumps(
        details,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _normalise_choices(
    raw: str | Sequence[str] | None,
    *,
    allowed: Sequence[str],
    field_name: str,
) -> tuple[str, ...]:
    if raw is None:
        return ()

    values = (raw,) if isinstance(raw, str) else tuple(raw)
    values = tuple(
        dict.fromkeys(value for value in values if value)
    )

    invalid = sorted(set(values) - set(allowed))
    if invalid:
        _unprocessable(
            f"Invalid {field_name}: {', '.join(invalid)}"
        )

    return values


def _validate_page(offset: int, limit: int) -> None:
    if offset < 0:
        _unprocessable("offset must be at least 0")

    if limit < 1 or limit > 200:
        _unprocessable("limit must be between 1 and 200")


def _escaped_search(value: str) -> str:
    """Escape wildcard characters before using an ILIKE pattern."""

    return (
        value.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def _integrity_constraint_name(
    error: IntegrityError,
) -> str | None:
    """Extract a PostgreSQL constraint name across DBAPI wrappers."""

    pending: list[BaseException] = [error]
    original = getattr(error, "orig", None)
    if isinstance(original, BaseException):
        pending.append(original)

    seen: set[int] = set()
    messages: list[str] = []

    while pending:
        candidate = pending.pop()
        identity = id(candidate)
        if identity in seen:
            continue

        seen.add(identity)
        messages.append(str(candidate))

        direct = getattr(candidate, "constraint_name", None)
        if direct:
            return str(direct)

        diagnostic = getattr(candidate, "diag", None)
        from_diagnostic = getattr(
            diagnostic,
            "constraint_name",
            None,
        )
        if from_diagnostic:
            return str(from_diagnostic)

        for linked in (
            getattr(candidate, "__cause__", None),
            getattr(candidate, "__context__", None),
        ):
            if isinstance(linked, BaseException):
                pending.append(linked)

    quoted_names = (
        f'"{_PENDING_REQUEST_CONSTRAINT}"',
        f"'{_PENDING_REQUEST_CONSTRAINT}'",
    )
    if any(
        quoted_name in message
        for message in messages
        for quoted_name in quoted_names
    ):
        return _PENDING_REQUEST_CONSTRAINT

    return None


class TaskService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ------------------------------------------------------------------
    # Identity and authorization
    # ------------------------------------------------------------------

    async def _actor(
        self,
        actor_id: str,
        *,
        for_update: bool = False,
    ) -> TaskActor:
        """Reload the authenticated user from the live database."""

        try:
            user_pk = uuid.UUID(str(actor_id))
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authenticated user",
            ) from None

        statement = select(User).where(
            User.id == user_pk,
            User.is_active.is_(True),
        )

        if for_update:
            statement = statement.with_for_update()

        user = (
            await self.session.execute(statement)
        ).scalar_one_or_none()

        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive",
            )

        return TaskActor(
            id=str(user.id),
            display_name=_display_name(user),
            role=(user.role or "").strip().lower(),
        )

    @staticmethod
    def _require_manager(actor: TaskActor) -> None:
        if not actor.is_manager:
            _forbidden("Task supervisor access required")

    @staticmethod
    def _require_writer(actor: TaskActor) -> None:
        if not actor.can_write:
            _forbidden("This account has read-only task access")

    async def _assignee(self, user_id: str) -> TaskActor:
        """Resolve an active user who is allowed to progress tasks."""

        try:
            user_pk = uuid.UUID(str(user_id))
        except (TypeError, ValueError, AttributeError):
            _unprocessable(
                "assigned_to_user_id must be a valid UUID"
            )

        user = (
            await self.session.execute(
                select(User).where(
                    User.id == user_pk,
                    User.is_active.is_(True),
                    func.lower(User.role).in_(
                        sorted(_WRITER_ROLES)
                    ),
                )
            )
        ).scalar_one_or_none()

        if user is None:
            _unprocessable(
                "Assignee was not found, is inactive, "
                "or cannot progress tasks"
            )

        return TaskActor(
            id=str(user.id),
            display_name=_display_name(user),
            role=(user.role or "").strip().lower(),
        )

    async def get_access(self, actor_id: str) -> TaskAccessOut:
        actor = await self._actor(actor_id)

        return TaskAccessOut(
            user_id=actor.id,
            display_name=actor.display_name,
            role=actor.role,
            can_manage_team=actor.is_manager,
            can_progress_tasks=actor.can_write,
            can_comment=actor.can_write,
            can_request_work=actor.can_write,
        )

    # ------------------------------------------------------------------
    # Task lookup and paging
    # ------------------------------------------------------------------

    async def _visible_task(
        self,
        actor: TaskActor,
        task_id: str,
        *,
        for_update: bool = False,
        include_deleted: bool = False,
    ) -> AchiTask:
        conditions: list[Any] = [AchiTask.id == task_id]

        if not actor.is_manager:
            conditions.extend(
                (
                    AchiTask.assigned_to_user_id == actor.id,
                    AchiTask.is_deleted.is_(False),
                )
            )
        elif not include_deleted:
            conditions.append(
                AchiTask.is_deleted.is_(False)
            )

        statement = select(AchiTask).where(*conditions)

        if for_update:
            statement = (
                statement.execution_options(
                    populate_existing=True
                )
                .with_for_update()
            )

        task = (
            await self.session.execute(statement)
        ).scalar_one_or_none()

        if task is None:
            # Employees receive 404 for another employee's task. This avoids
            # revealing whether a guessed task ID exists.
            _not_found()

        return task

    async def _owned_task_for_update(
        self,
        actor: TaskActor,
        task_id: str,
    ) -> AchiTask:
        task = (
            await self.session.execute(
                select(AchiTask)
                .where(
                    AchiTask.id == task_id,
                    AchiTask.assigned_to_user_id == actor.id,
                    AchiTask.is_deleted.is_(False),
                )
                .execution_options(populate_existing=True)
                .with_for_update()
            )
        ).scalar_one_or_none()

        if task is None:
            _not_found()

        return task

    async def _manager_task_for_update(
        self,
        actor: TaskActor,
        task_id: str,
        *,
        include_deleted: bool = False,
    ) -> AchiTask:
        self._require_manager(actor)

        conditions: list[Any] = [AchiTask.id == task_id]

        if not include_deleted:
            conditions.append(
                AchiTask.is_deleted.is_(False)
            )

        task = (
            await self.session.execute(
                select(AchiTask)
                .where(*conditions)
                .execution_options(populate_existing=True)
                .with_for_update()
            )
        ).scalar_one_or_none()

        if task is None:
            _not_found()

        return task

    async def get_task(
        self,
        actor_id: str,
        task_id: str,
        *,
        include_deleted: bool = False,
    ) -> AchiTask:
        actor = await self._actor(actor_id)

        if include_deleted and not actor.is_manager:
            _forbidden("Task supervisor access required")

        return await self._visible_task(
            actor,
            task_id,
            include_deleted=include_deleted,
        )

    async def _task_page(
        self,
        conditions: list[Any],
        *,
        offset: int,
        limit: int,
    ) -> TaskListOut:
        _validate_page(offset, limit)

        total = (
            await self.session.execute(
                select(func.count(AchiTask.id)).where(
                    *conditions
                )
            )
        ).scalar_one()

        rows = (
            await self.session.execute(
                select(AchiTask)
                .where(*conditions)
                .order_by(
                    AchiTask.updated_at.desc(),
                    AchiTask.created_at.desc(),
                )
                .offset(offset)
                .limit(limit)
            )
        ).scalars().all()

        return TaskListOut(
            items=[
                TaskOut.model_validate(row)
                for row in rows
            ],
            total=int(total),
            offset=offset,
            limit=limit,
        )

    @staticmethod
    def _add_task_filters(
        conditions: list[Any],
        *,
        statuses: str | Sequence[str] | None,
        priorities: str | Sequence[str] | None,
        search: str | None,
        due_before: datetime | None,
        due_after: datetime | None,
        overdue_only: bool,
    ) -> None:
        status_values = _normalise_choices(
            statuses,
            allowed=TASK_STATUSES,
            field_name="status",
        )
        priority_values = _normalise_choices(
            priorities,
            allowed=TASK_PRIORITIES,
            field_name="priority",
        )

        if status_values:
            conditions.append(
                AchiTask.status.in_(status_values)
            )

        if priority_values:
            conditions.append(
                AchiTask.priority.in_(priority_values)
            )

        term = (search or "").strip()

        if len(term) > 200:
            _unprocessable(
                "search must be at most 200 characters"
            )

        if term:
            pattern = f"%{_escaped_search(term)}%"
            conditions.append(
                or_(
                    AchiTask.task_number.ilike(
                        pattern,
                        escape="\\",
                    ),
                    AchiTask.title.ilike(
                        pattern,
                        escape="\\",
                    ),
                    AchiTask.description.ilike(
                        pattern,
                        escape="\\",
                    ),
                    AchiTask.assigned_to_name.ilike(
                        pattern,
                        escape="\\",
                    ),
                )
            )

        if due_before is not None:
            conditions.append(
                AchiTask.due_at <= due_before
            )

        if due_after is not None:
            conditions.append(
                AchiTask.due_at >= due_after
            )

        if overdue_only:
            conditions.extend(
                (
                    AchiTask.due_at.is_not(None),
                    AchiTask.due_at < _now(),
                    AchiTask.status.not_in(
                        _TERMINAL_STATUSES
                    ),
                )
            )

    async def list_mine(
        self,
        actor_id: str,
        *,
        statuses: str | Sequence[str] | None = None,
        priorities: str | Sequence[str] | None = None,
        search: str | None = None,
        due_before: datetime | None = None,
        due_after: datetime | None = None,
        overdue_only: bool = False,
        offset: int = 0,
        limit: int = 50,
    ) -> TaskListOut:
        actor = await self._actor(actor_id)

        conditions: list[Any] = [
            AchiTask.assigned_to_user_id == actor.id,
            AchiTask.is_deleted.is_(False),
        ]

        self._add_task_filters(
            conditions,
            statuses=statuses,
            priorities=priorities,
            search=search,
            due_before=due_before,
            due_after=due_after,
            overdue_only=overdue_only,
        )

        return await self._task_page(
            conditions,
            offset=offset,
            limit=limit,
        )

    async def list_team(
        self,
        actor_id: str,
        *,
        statuses: str | Sequence[str] | None = None,
        priorities: str | Sequence[str] | None = None,
        assigned_to_user_id: str | None = None,
        unassigned_only: bool = False,
        search: str | None = None,
        due_before: datetime | None = None,
        due_after: datetime | None = None,
        overdue_only: bool = False,
        include_deleted: bool = False,
        offset: int = 0,
        limit: int = 100,
    ) -> TaskListOut:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        if assigned_to_user_id and unassigned_only:
            _unprocessable(
                "assigned_to_user_id and unassigned_only "
                "cannot be combined"
            )

        conditions: list[Any] = []

        if not include_deleted:
            conditions.append(
                AchiTask.is_deleted.is_(False)
            )

        if assigned_to_user_id:
            conditions.append(
                AchiTask.assigned_to_user_id
                == _canonical_uuid(
                    assigned_to_user_id,
                    detail=(
                        "assigned_to_user_id must be "
                        "a valid UUID"
                    ),
                )
            )
        elif unassigned_only:
            conditions.append(
                AchiTask.assigned_to_user_id.is_(None)
            )

        self._add_task_filters(
            conditions,
            statuses=statuses,
            priorities=priorities,
            search=search,
            due_before=due_before,
            due_after=due_after,
            overdue_only=overdue_only,
        )

        return await self._task_page(
            conditions,
            offset=offset,
            limit=limit,
        )

    # ------------------------------------------------------------------
    # Audit and transaction helpers
    # ------------------------------------------------------------------

    def _add_event(
        self,
        task: AchiTask,
        actor: TaskActor,
        event_type: str,
        *,
        from_status: str | None,
        to_status: str | None,
        details: dict[str, Any] | None = None,
    ) -> AchiTaskEvent:
        if event_type not in _TASK_EVENT_TYPES:
            raise RuntimeError(
                f"Unknown task event type: {event_type}"
            )

        event = AchiTaskEvent(
            id=str(uuid.uuid4()),
            task_id=task.id,
            actor_user_id=actor.id,
            actor_name=actor.display_name,
            event_type=event_type,
            from_status=from_status,
            to_status=to_status,
            details=_json_details(details),
        )
        self.session.add(event)
        return event

    def _add_comment(
        self,
        task: AchiTask,
        actor: TaskActor,
        *,
        body: str,
        kind: str,
    ) -> AchiTaskComment:
        comment = AchiTaskComment(
            id=str(uuid.uuid4()),
            task_id=task.id,
            author_user_id=actor.id,
            author_name=actor.display_name,
            body=body,
            kind=kind,
        )
        self.session.add(comment)
        return comment

    async def _commit_and_refresh(
        self,
        *rows: Any,
    ) -> None:
        try:
            await self.session.commit()
        except Exception:
            await self.session.rollback()
            raise

        for row in rows:
            await self.session.refresh(row)

    @staticmethod
    def _reset_lifecycle(task: AchiTask) -> None:
        task.started_at = None
        task.blocked_at = None
        task.blocked_reason = ""
        task.submitted_at = None
        task.completed_at = None
        task.completed_by_user_id = None
        task.completed_by_name = ""
        task.review_note = ""

    # ------------------------------------------------------------------
    # Supervisor creation and metadata
    # ------------------------------------------------------------------

    async def create_task(
        self,
        actor_id: str,
        data: TaskCreateIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        values = data.model_dump()
        requested_assignee = values.pop(
            "assigned_to_user_id"
        )
        assignee = (
            await self._assignee(requested_assignee)
            if requested_assignee
            else None
        )

        task_id, task_number = _new_task_identity()
        now = _now()
        initial_status = (
            "to_do" if assignee else "unassigned"
        )

        task = AchiTask(
            id=task_id,
            task_number=task_number,
            status=initial_status,
            assigned_to_user_id=(
                assignee.id if assignee else None
            ),
            assigned_to_name=(
                assignee.display_name if assignee else ""
            ),
            assigned_at=now if assignee else None,
            created_by_user_id=actor.id,
            created_by_name=actor.display_name,
            **values,
        )
        self.session.add(task)

        self._add_event(
            task,
            actor,
            "created",
            from_status=None,
            to_status="unassigned",
            details={"task_number": task_number},
        )

        if assignee:
            self._add_event(
                task,
                actor,
                "assigned",
                from_status="unassigned",
                to_status="to_do",
                details={
                    "assigned_to_user_id": assignee.id,
                    "assigned_to_name": (
                        assignee.display_name
                    ),
                },
            )

        await self._commit_and_refresh(task)
        return task

    @staticmethod
    def _resolve_related_patch(
        task: AchiTask,
        values: dict[str, Any],
    ) -> tuple[str | None, str | None, str]:
        relation_keys = {
            "related_type",
            "related_id",
            "related_label",
        }

        if not relation_keys.intersection(values):
            return (
                task.related_type,
                task.related_id,
                task.related_label,
            )

        explicit_type = values.get(
            "related_type",
            task.related_type,
        )
        explicit_id = values.get(
            "related_id",
            task.related_id,
        )
        explicit_label = values.get(
            "related_label",
            task.related_label,
        )

        clearing_type = (
            "related_type" in values
            and values["related_type"] is None
        )
        clearing_id = (
            "related_id" in values
            and values["related_id"] is None
        )

        if clearing_type or clearing_id:
            if (
                "related_type" in values
                and values["related_type"] is not None
            ) or (
                "related_id" in values
                and values["related_id"] is not None
            ):
                _unprocessable(
                    "Cannot clear and set a related "
                    "reference in the same request"
                )

            return None, None, ""

        if bool(explicit_type) != bool(explicit_id):
            _unprocessable(
                "related_type and related_id must both be set"
            )

        if not explicit_type and explicit_label:
            _unprocessable(
                "related_label requires related_type "
                "and related_id"
            )

        return (
            explicit_type,
            explicit_id,
            explicit_label or "",
        )

    async def update_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskUpdateIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        # This is essential. Without exclude_unset, a title-only patch would
        # accidentally clear assignment, deadline, and related references.
        values = data.model_dump(exclude_unset=True)

        assignment_present = (
            "assigned_to_user_id" in values
        )
        requested_assignee = values.get(
            "assigned_to_user_id"
        )

        assignee: TaskActor | None = None
        canonical_assignee_id: str | None = None

        if assignment_present and requested_assignee:
            assignee = await self._assignee(
                requested_assignee
            )
            canonical_assignee_id = assignee.id

        old_assignee_id = task.assigned_to_user_id
        assignment_changed = (
            assignment_present
            and canonical_assignee_id != old_assignee_id
        )

        if (
            assignment_changed
            and task.status in _TERMINAL_STATUSES
        ):
            _conflict(
                "Completed or cancelled tasks must be "
                "reopened before reassignment"
            )

        related_type, related_id, related_label = (
            self._resolve_related_patch(task, values)
        )

        changed_fields: list[str] = []
        old_status = task.status

        if assignment_changed:
            old_assignee_name = task.assigned_to_name

            task.assigned_to_user_id = (
                canonical_assignee_id
            )
            task.assigned_to_name = (
                assignee.display_name if assignee else ""
            )
            task.assigned_at = (
                _now() if assignee else None
            )

            self._reset_lifecycle(task)
            task.status = (
                "to_do"
                if canonical_assignee_id
                else "unassigned"
            )

            if old_assignee_id and canonical_assignee_id:
                event_type = "reassigned"
            elif canonical_assignee_id:
                event_type = "assigned"
            else:
                event_type = "unassigned"

            self._add_event(
                task,
                actor,
                event_type,
                from_status=old_status,
                to_status=task.status,
                details={
                    "old_assignee_user_id": (
                        old_assignee_id
                    ),
                    "old_assignee_name": (
                        old_assignee_name
                    ),
                    "new_assignee_user_id": (
                        canonical_assignee_id
                    ),
                    "new_assignee_name": (
                        assignee.display_name
                        if assignee
                        else ""
                    ),
                },
            )

        elif assignment_present and assignee:
            if (
                task.assigned_to_name
                != assignee.display_name
            ):
                task.assigned_to_name = (
                    assignee.display_name
                )
                changed_fields.append(
                    "assigned_to_name"
                )

        for field_name in (
            "title",
            "description",
            "priority",
            "due_at",
        ):
            if field_name not in values:
                continue

            new_value = values[field_name]

            if getattr(task, field_name) != new_value:
                setattr(task, field_name, new_value)
                changed_fields.append(field_name)

        if {
            "related_type",
            "related_id",
            "related_label",
        }.intersection(values):
            for field_name, new_value in (
                ("related_type", related_type),
                ("related_id", related_id),
                ("related_label", related_label),
            ):
                if getattr(task, field_name) != new_value:
                    setattr(task, field_name, new_value)
                    changed_fields.append(field_name)

        if changed_fields:
            self._add_event(
                task,
                actor,
                "updated",
                from_status=task.status,
                to_status=task.status,
                details={
                    "changed_fields": sorted(
                        set(changed_fields)
                    )
                },
            )

        if not assignment_changed and not changed_fields:
            await self.session.commit()
            return task

        await self._commit_and_refresh(task)
        return task

    # ------------------------------------------------------------------
    # Employee lifecycle
    # ------------------------------------------------------------------

    async def progress_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskProgressIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)

        # Ownership is checked before role. Another employee's task therefore
        # appears nonexistent, while a viewer gets 403 on their own task.
        task = await self._owned_task_for_update(
            actor,
            task_id,
        )
        self._require_writer(actor)

        previous = task.status
        now = _now()
        details: dict[str, Any] = {}

        if data.action == "start":
            if previous != "to_do":
                _conflict(
                    f"Cannot start a task from status "
                    f"'{previous}'"
                )

            task.status = "in_progress"
            task.started_at = task.started_at or now
            task.blocked_at = None
            task.blocked_reason = ""
            event_type = "started"

        elif data.action == "block":
            if previous not in {"to_do", "in_progress"}:
                _conflict(
                    f"Cannot block a task from status "
                    f"'{previous}'"
                )

            reason = data.reason or ""

            task.status = "blocked"
            task.started_at = task.started_at or now
            task.blocked_at = now
            task.blocked_reason = reason
            details["has_reason"] = True
            event_type = "blocked"

            self._add_comment(
                task,
                actor,
                body=reason,
                kind="blocked_reason",
            )

        elif data.action == "resume":
            if previous != "blocked":
                _conflict(
                    f"Cannot resume a task from status "
                    f"'{previous}'"
                )

            had_reason = bool(task.blocked_reason)

            task.status = "in_progress"
            task.blocked_at = None
            task.blocked_reason = ""
            details["had_blocked_reason"] = had_reason
            event_type = "resumed"

        elif data.action == "submit":
            if previous != "in_progress":
                _conflict(
                    f"Cannot submit a task from status "
                    f"'{previous}'"
                )

            task.status = "ready_for_review"
            task.submitted_at = now
            task.review_note = ""
            event_type = "submitted"
            details["has_note"] = bool(data.note)

            if data.note:
                self._add_comment(
                    task,
                    actor,
                    body=data.note,
                    kind="review_submission",
                )

        else:
            _unprocessable(
                "Unsupported task progress action"
            )

        self._add_event(
            task,
            actor,
            event_type,
            from_status=previous,
            to_status=task.status,
            details=details,
        )

        await self._commit_and_refresh(task)
        return task

    # ------------------------------------------------------------------
    # Supervisor lifecycle
    # ------------------------------------------------------------------

    async def approve_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskApproveIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        if task.status != "ready_for_review":
            _conflict(
                "Only a task ready for review can be approved"
            )

        previous = task.status
        task.status = "completed"
        task.completed_at = _now()
        task.completed_by_user_id = actor.id
        task.completed_by_name = actor.display_name
        task.review_note = data.note

        if data.note:
            self._add_comment(
                task,
                actor,
                body=data.note,
                kind="supervisor_review",
            )

        self._add_event(
            task,
            actor,
            "approved",
            from_status=previous,
            to_status="completed",
            details={"has_note": bool(data.note)},
        )

        await self._commit_and_refresh(task)
        return task

    async def return_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskReturnIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        if task.status != "ready_for_review":
            _conflict(
                "Only a task ready for review can be returned"
            )

        previous = task.status
        task.status = "in_progress"
        task.submitted_at = None
        task.review_note = data.note
        task.completed_at = None
        task.completed_by_user_id = None
        task.completed_by_name = ""

        self._add_comment(
            task,
            actor,
            body=data.note,
            kind="supervisor_review",
        )
        self._add_event(
            task,
            actor,
            "returned",
            from_status=previous,
            to_status="in_progress",
            details={"has_note": True},
        )

        await self._commit_and_refresh(task)
        return task

    async def cancel_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskCancelIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        if task.status in _TERMINAL_STATUSES:
            _conflict(
                "Completed or cancelled tasks cannot "
                "be cancelled"
            )

        previous = task.status
        task.status = "cancelled"

        self._add_comment(
            task,
            actor,
            body=data.reason,
            kind="supervisor_review",
        )
        self._add_event(
            task,
            actor,
            "cancelled",
            from_status=previous,
            to_status="cancelled",
            details={"has_reason": True},
        )

        await self._commit_and_refresh(task)
        return task

    async def reopen_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskReopenIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        if task.status not in _TERMINAL_STATUSES:
            _conflict(
                "Only a completed or cancelled task "
                "can be reopened"
            )

        previous = task.status

        self._reset_lifecycle(task)
        task.status = (
            "to_do"
            if task.assigned_to_user_id
            else "unassigned"
        )

        if data.note:
            self._add_comment(
                task,
                actor,
                body=data.note,
                kind="supervisor_review",
            )

        self._add_event(
            task,
            actor,
            "reopened",
            from_status=previous,
            to_status=task.status,
            details={"has_note": bool(data.note)},
        )

        await self._commit_and_refresh(task)
        return task

    async def soft_delete_task(
        self,
        actor_id: str,
        task_id: str,
        data: TaskDeleteIn,
    ) -> AchiTask:
        actor = await self._actor(actor_id)
        task = await self._manager_task_for_update(
            actor,
            task_id,
        )

        previous = task.status

        task.is_deleted = True
        task.deleted_at = _now()
        task.deleted_by_user_id = actor.id

        self._add_event(
            task,
            actor,
            "deleted",
            from_status=previous,
            to_status=previous,
            details={"has_reason": True},
        )

        self._add_comment(
            task,
            actor,
            body=data.reason,
            kind="supervisor_review",
        )

        await self._commit_and_refresh(task)
        return task

    # ------------------------------------------------------------------
    # Comments and manager-only history
    # ------------------------------------------------------------------

    async def list_comments(
        self,
        actor_id: str,
        task_id: str,
    ) -> list[AchiTaskComment]:
        actor = await self._actor(actor_id)

        await self._visible_task(actor, task_id, for_update= True,)

        return list(
            (
                await self.session.execute(
                    select(AchiTaskComment)
                    .where(
                        AchiTaskComment.task_id == task_id
                    )
                    .order_by(
                        AchiTaskComment.created_at,
                        AchiTaskComment.id,
                    )
                )
            )
            .scalars()
            .all()
        )

    async def add_comment(
        self,
        actor_id: str,
        task_id: str,
        data: TaskCommentCreateIn,
    ) -> AchiTaskComment:
        actor = await self._actor(actor_id)

        task = await self._visible_task(
            actor,
            task_id,
            for_update=True,
        )
        self._require_writer(actor)

        comment = self._add_comment(
            task,
            actor,
            body=data.body,
            kind="comment",
        )
        self._add_event(
            task,
            actor,
            "comment_added",
            from_status=task.status,
            to_status=task.status,
            details={"comment_id": comment.id},
        )

        await self._commit_and_refresh(comment)
        return comment

    async def list_history(
        self,
        actor_id: str,
        task_id: str,
    ) -> list[AchiTaskEvent]:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        task = await self._visible_task(
            actor,
            task_id,
            include_deleted=True,
        )

        return list(
            (
                await self.session.execute(
                    select(AchiTaskEvent)
                    .where(
                        AchiTaskEvent.task_id == task.id
                    )
                    .order_by(
                        AchiTaskEvent.created_at,
                        AchiTaskEvent.id,
                    )
                )
            )
            .scalars()
            .all()
        )

    # ------------------------------------------------------------------
    # Sanitized assignee directory
    # ------------------------------------------------------------------

    async def list_assignees(
        self,
        actor_id: str,
    ) -> list[TaskAssigneeOut]:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        users = (
            await self.session.execute(
                select(User)
                .where(
                    User.is_active.is_(True),
                    func.lower(User.role).in_(
                        sorted(_WRITER_ROLES)
                    ),
                )
                .order_by(User.full_name, User.id)
            )
        ).scalars().all()

        return [
            TaskAssigneeOut(
                user_id=str(user.id),
                display_name=_display_name(user),
                role=(user.role or "").strip().lower(),
            )
            for user in users
        ]

    # ------------------------------------------------------------------
    # "I need another task" requests
    # ------------------------------------------------------------------

    async def request_work(
        self,
        actor_id: str,
        data: WorkRequestCreateIn,
    ) -> AchiTaskWorkRequest:
        # Locking the stable User row serializes simultaneous requests from the
        # same employee. The partial unique index is the final DB-level guard.
        actor = await self._actor(
            actor_id,
            for_update=True,
        )
        self._require_writer(actor)

        existing = (
            await self.session.execute(
                select(AchiTaskWorkRequest)
                .where(
                    AchiTaskWorkRequest.requester_user_id
                    == actor.id,
                    AchiTaskWorkRequest.status == "pending",
                )
                .order_by(
                    AchiTaskWorkRequest.created_at
                )
                .with_for_update()
            )
        ).scalars().first()

        if existing is not None:
            await self.session.commit()
            return existing

        row = AchiTaskWorkRequest(
            id=str(uuid.uuid4()),
            requester_user_id=actor.id,
            requester_name=actor.display_name,
            message=data.message,
            status="pending",
        )
        self.session.add(row)

        try:
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()

            if (
                _integrity_constraint_name(error)
                != _PENDING_REQUEST_CONSTRAINT
            ):
                raise

            existing = (
                await self.session.execute(
                    select(AchiTaskWorkRequest)
                    .where(
                        AchiTaskWorkRequest.requester_user_id
                        == actor.id,
                        AchiTaskWorkRequest.status
                        == "pending",
                    )
                    .order_by(
                        AchiTaskWorkRequest.created_at
                    )
                )
            ).scalars().first()

            if existing is None:
                raise

            return existing

        await self.session.refresh(row)
        return row

    async def _work_request_page(
        self,
        conditions: list[Any],
        *,
        offset: int,
        limit: int,
    ) -> WorkRequestListOut:
        _validate_page(offset, limit)

        total = (
            await self.session.execute(
                select(
                    func.count(
                        AchiTaskWorkRequest.id
                    )
                ).where(*conditions)
            )
        ).scalar_one()

        rows = (
            await self.session.execute(
                select(AchiTaskWorkRequest)
                .where(*conditions)
                .order_by(
                    AchiTaskWorkRequest.created_at.desc()
                )
                .offset(offset)
                .limit(limit)
            )
        ).scalars().all()

        return WorkRequestListOut(
            items=[
                WorkRequestOut.model_validate(row)
                for row in rows
            ],
            total=int(total),
        )

    async def list_my_work_requests(
        self,
        actor_id: str,
        *,
        request_status: (
            str | Sequence[str] | None
        ) = None,
        offset: int = 0,
        limit: int = 50,
    ) -> WorkRequestListOut:
        actor = await self._actor(actor_id)

        statuses = _normalise_choices(
            request_status,
            allowed=tuple(_WORK_REQUEST_STATUSES),
            field_name="work request status",
        )

        conditions: list[Any] = [
            AchiTaskWorkRequest.requester_user_id
            == actor.id
        ]

        if statuses:
            conditions.append(
                AchiTaskWorkRequest.status.in_(statuses)
            )

        return await self._work_request_page(
            conditions,
            offset=offset,
            limit=limit,
        )

    async def list_work_requests(
        self,
        actor_id: str,
        *,
        request_status: (
            str | Sequence[str] | None
        ) = None,
        requester_user_id: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> WorkRequestListOut:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        statuses = _normalise_choices(
            request_status,
            allowed=tuple(_WORK_REQUEST_STATUSES),
            field_name="work request status",
        )

        conditions: list[Any] = []

        if statuses:
            conditions.append(
                AchiTaskWorkRequest.status.in_(statuses)
            )

        if requester_user_id:
            conditions.append(
                AchiTaskWorkRequest.requester_user_id
                == _canonical_uuid(
                    requester_user_id,
                    detail=(
                        "requester_user_id must be "
                        "a valid UUID"
                    ),
                )
            )

        return await self._work_request_page(
            conditions,
            offset=offset,
            limit=limit,
        )

    async def acknowledge_work_request(
        self,
        actor_id: str,
        request_id: str,
    ) -> AchiTaskWorkRequest:
        actor = await self._actor(actor_id)
        self._require_manager(actor)

        row = (
            await self.session.execute(
                select(AchiTaskWorkRequest)
                .where(
                    AchiTaskWorkRequest.id == request_id
                )
                .execution_options(
                    populate_existing=True
                )
                .with_for_update()
            )
        ).scalar_one_or_none()

        if row is None:
            _not_found("Work request not found")

        if row.status != "pending":
            _conflict(
                "Only a pending work request can "
                "be acknowledged"
            )

        row.status = "acknowledged"
        row.handled_by_user_id = actor.id
        row.handled_by_name = actor.display_name
        row.handled_at = _now()

        await self._commit_and_refresh(row)
        return row

    async def cancel_my_work_request(
        self,
        actor_id: str,
        request_id: str,
    ) -> AchiTaskWorkRequest:
        actor = await self._actor(actor_id)

        row = (
            await self.session.execute(
                select(AchiTaskWorkRequest)
                .where(
                    AchiTaskWorkRequest.id == request_id,
                    AchiTaskWorkRequest.requester_user_id
                    == actor.id,
                )
                .execution_options(
                    populate_existing=True
                )
                .with_for_update()
            )
        ).scalar_one_or_none()

        if row is None:
            _not_found("Work request not found")

        self._require_writer(actor)

        if row.status != "pending":
            _conflict(
                "Only a pending work request can "
                "be cancelled"
            )

        row.status = "cancelled"
        row.handled_by_user_id = actor.id
        row.handled_by_name = actor.display_name
        row.handled_at = _now()

        await self._commit_and_refresh(row)
        return row