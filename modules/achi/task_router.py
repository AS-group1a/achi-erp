"""HTTP routes for ACHI Team Tasks.

Mounted under /api/v1/achi by the ACHI module router. Static collection routes
are declared before /{task_id}, so names such as "mine" and "team" cannot be
interpreted as task IDs.
"""

from __future__ import annotations

from pathlib import Path
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse, PlainTextResponse
from app.dependencies import CurrentUserId, RequireRole, SessionDep

from .task_schemas import (
    TaskAccessOut,
    TaskApproveIn,
    TaskAssigneeOut,
    TaskCancelIn,
    TaskCommentCreateIn,
    TaskCommentOut,
    TaskCreateIn,
    TaskDeleteIn,
    TaskEventOut,
    TaskListOut,
    TaskOut,
    TaskPriority,
    TaskProgressIn,
    TaskReopenIn,
    TaskReturnIn,
    TaskStatus,
    TaskUpdateIn,
    WorkRequestCreateIn,
    WorkRequestListOut,
    WorkRequestOut,
    WorkRequestStatus,
)
from .task_service import TaskService


task_router = APIRouter(prefix="/tasks")

_UI_DIR = Path(__file__).parent / "ui"


@task_router.get(
    "/ui",
    response_class=HTMLResponse,
    include_in_schema=False,
    summary="Team Tasks UI",
)
def team_tasks_ui() -> HTMLResponse:
    return HTMLResponse(
        (_UI_DIR / "team_tasks.html").read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@task_router.get(
    "/team_tasks.css",
    response_class=PlainTextResponse,
    include_in_schema=False,
)


def team_tasks_css() -> PlainTextResponse:
    return PlainTextResponse(
        (_UI_DIR / "team_tasks.css").read_text(encoding="utf-8"),
        media_type="text/css",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@task_router.get(
    "/team_tasks.js",
    response_class=PlainTextResponse,
    include_in_schema=False,
)


def team_tasks_js() -> PlainTextResponse:
    return PlainTextResponse(
        (_UI_DIR / "team_tasks.js").read_text(encoding="utf-8"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, max-age=0"},
    )



TaskStatusFilter = Annotated[
    list[TaskStatus] | None,
    Query(
        alias="status",
        description=(
            "Repeat to include multiple statuses, for example "
            "?status=to_do&status=blocked"
        ),
    ),
]

TaskPriorityFilter = Annotated[
    list[TaskPriority] | None,
    Query(
        alias="priority",
        description=(
            "Repeat to include multiple priorities, for example "
            "?priority=high&priority=urgent"
        ),
    ),
]

WorkRequestStatusFilter = Annotated[
    list[WorkRequestStatus] | None,
    Query(
        alias="status",
        description="Repeat to include multiple work-request statuses",
    ),
]

SearchFilter = Annotated[
    str | None,
    Query(max_length=200),
]

DueFilter = Annotated[
    datetime | None,
    Query(
        description=(
            "Timezone-aware ISO 8601 timestamp, for example "
            "2026-08-12T15:00:00+03:00"
        )
    ),
]

OffsetFilter = Annotated[
    int,
    Query(ge=0),
]

LimitFilter = Annotated[
    int,
    Query(ge=1, le=200),
]


def _aware_utc(
    value: datetime | None,
    *,
    field_name: str,
) -> datetime | None:
    """Reject ambiguous timestamps and normalize valid values to UTC."""

    if value is None:
        return None

    if value.tzinfo is None or value.utcoffset() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must include a timezone",
        )

    return value.astimezone(timezone.utc)


def _due_window(
    due_after: datetime | None,
    due_before: datetime | None,
) -> tuple[datetime | None, datetime | None]:
    """Validate and normalize the task deadline filter window."""

    normalized_after = _aware_utc(
        due_after,
        field_name="due_after",
    )
    normalized_before = _aware_utc(
        due_before,
        field_name="due_before",
    )

    if (
        normalized_after is not None
        and normalized_before is not None
        and normalized_after > normalized_before
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="due_after cannot be later than due_before",
        )

    return normalized_after, normalized_before


# ---------------------------------------------------------------------------
# Current-user access and task lists
# ---------------------------------------------------------------------------


@task_router.get(
    "/access/me",
    response_model=TaskAccessOut,
    summary="Current user's Team Tasks capabilities",
)
async def task_access_me(
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskAccessOut:
    return await TaskService(session).get_access(user_id)


@task_router.get(
    "/mine",
    response_model=TaskListOut,
    summary="Tasks assigned to the current user",
)
async def list_my_tasks(
    session: SessionDep,
    user_id: CurrentUserId,
    statuses: TaskStatusFilter = None,
    priorities: TaskPriorityFilter = None,
    search: SearchFilter = None,
    due_after: DueFilter = None,
    due_before: DueFilter = None,
    overdue_only: Annotated[bool, Query()] = False,
    offset: OffsetFilter = 0,
    limit: LimitFilter = 50,
) -> TaskListOut:
    normalized_after, normalized_before = _due_window(
        due_after,
        due_before,
    )

    return await TaskService(session).list_mine(
        user_id,
        statuses=statuses,
        priorities=priorities,
        search=search,
        due_after=normalized_after,
        due_before=normalized_before,
        overdue_only=overdue_only,
        offset=offset,
        limit=limit,
    )


@task_router.get(
    "/team",
    response_model=TaskListOut,
    summary="Supervisor team task board",
)
async def list_team_tasks(
    session: SessionDep,
    user_id: CurrentUserId,
    statuses: TaskStatusFilter = None,
    priorities: TaskPriorityFilter = None,
    assigned_to_user_id: Annotated[
        UUID | None,
        Query(description="Filter by one assignee"),
    ] = None,
    unassigned_only: Annotated[bool, Query()] = False,
    search: SearchFilter = None,
    due_after: DueFilter = None,
    due_before: DueFilter = None,
    overdue_only: Annotated[bool, Query()] = False,
    include_deleted: Annotated[bool, Query()] = False,
    offset: OffsetFilter = 0,
    limit: LimitFilter = 100,
) -> TaskListOut:
    normalized_after, normalized_before = _due_window(
        due_after,
        due_before,
    )

    return await TaskService(session).list_team(
        user_id,
        statuses=statuses,
        priorities=priorities,
        assigned_to_user_id=(
            str(assigned_to_user_id)
            if assigned_to_user_id is not None
            else None
        ),
        unassigned_only=unassigned_only,
        search=search,
        due_after=normalized_after,
        due_before=normalized_before,
        overdue_only=overdue_only,
        include_deleted=include_deleted,
        offset=offset,
        limit=limit,
    )


@task_router.get(
    "/assignees",
    response_model=list[TaskAssigneeOut],
    summary="Sanitized active-user task directory",
)
async def list_task_assignees(
    session: SessionDep,
    user_id: CurrentUserId,
) -> list[TaskAssigneeOut]:
    return await TaskService(session).list_assignees(user_id)


# ---------------------------------------------------------------------------
# Work requests
# ---------------------------------------------------------------------------


@task_router.post(
    "/work-requests",
    response_model=WorkRequestOut,
    summary="Request another task",
)
async def request_more_work(
    data: WorkRequestCreateIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> WorkRequestOut:
    row = await TaskService(session).request_work(
        user_id,
        data,
    )
    return WorkRequestOut.model_validate(row)


@task_router.get(
    "/work-requests/mine",
    response_model=WorkRequestListOut,
    summary="Current user's work requests",
)
async def list_my_work_requests(
    session: SessionDep,
    user_id: CurrentUserId,
    statuses: WorkRequestStatusFilter = None,
    offset: OffsetFilter = 0,
    limit: LimitFilter = 50,
) -> WorkRequestListOut:
    return await TaskService(session).list_my_work_requests(
        user_id,
        request_status=statuses,
        offset=offset,
        limit=limit,
    )


@task_router.get(
    "/work-requests/team",
    response_model=WorkRequestListOut,
    summary="Supervisor work-request queue",
)
async def list_team_work_requests(
    session: SessionDep,
    user_id: CurrentUserId,
    statuses: WorkRequestStatusFilter = None,
    requester_user_id: Annotated[
        UUID | None,
        Query(description="Filter by requesting user"),
    ] = None,
    offset: OffsetFilter = 0,
    limit: LimitFilter = 100,
) -> WorkRequestListOut:
    return await TaskService(session).list_work_requests(
        user_id,
        request_status=statuses,
        requester_user_id=(
            str(requester_user_id)
            if requester_user_id is not None
            else None
        ),
        offset=offset,
        limit=limit,
    )


@task_router.post(
    "/work-requests/{request_id}/acknowledge",
    response_model=WorkRequestOut,
    summary="Acknowledge a pending work request",
)
async def acknowledge_work_request(
    request_id: UUID,
    session: SessionDep,
    user_id: CurrentUserId,
) -> WorkRequestOut:
    row = await TaskService(session).acknowledge_work_request(
        user_id,
        str(request_id),
    )
    return WorkRequestOut.model_validate(row)


@task_router.post(
    "/work-requests/{request_id}/cancel",
    response_model=WorkRequestOut,
    summary="Cancel the current user's pending work request",
)
async def cancel_my_work_request(
    request_id: UUID,
    session: SessionDep,
    user_id: CurrentUserId,
) -> WorkRequestOut:
    row = await TaskService(session).cancel_my_work_request(
        user_id,
        str(request_id),
    )
    return WorkRequestOut.model_validate(row)


# ---------------------------------------------------------------------------
# Supervisor task creation
# ---------------------------------------------------------------------------


@task_router.post(
    "",
    response_model=TaskOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create and optionally assign a task",
)
async def create_task(
    data: TaskCreateIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).create_task(
        user_id,
        data,
    )
    return TaskOut.model_validate(task)


# ---------------------------------------------------------------------------
# Task detail and lifecycle
# ---------------------------------------------------------------------------


@task_router.get(
    "/{task_id}",
    response_model=TaskOut,
    summary="Get one visible task",
)
async def get_task(
    task_id: UUID,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).get_task(
        user_id,
        str(task_id),
    )
    return TaskOut.model_validate(task)


@task_router.patch(
    "/{task_id}",
    response_model=TaskOut,
    summary="Edit task metadata or assignment",
)
async def update_task(
    task_id: UUID,
    data: TaskUpdateIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).update_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.patch(
    "/{task_id}/progress",
    response_model=TaskOut,
    summary="Progress the current user's assigned task",
)
async def progress_task(
    task_id: UUID,
    data: TaskProgressIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).progress_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.post(
    "/{task_id}/approve",
    response_model=TaskOut,
    dependencies=[Depends(RequireRole("manager"))],
    summary="Approve submitted work",
)
async def approve_task(
    task_id: UUID,
    data: TaskApproveIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).approve_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.post(
    "/{task_id}/return",
    response_model=TaskOut,
    dependencies=[Depends(RequireRole("manager"))],
    summary="Return submitted work for changes",
)
async def return_task(
    task_id: UUID,
    data: TaskReturnIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).return_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.post(
    "/{task_id}/cancel",
    response_model=TaskOut,
    dependencies=[Depends(RequireRole("manager"))],
    summary="Cancel a non-terminal task",
)
async def cancel_task(
    task_id: UUID,
    data: TaskCancelIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).cancel_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.post(
    "/{task_id}/reopen",
    response_model=TaskOut,
    dependencies=[Depends(RequireRole("manager"))],
    summary="Reopen a completed or cancelled task",
)
async def reopen_task(
    task_id: UUID,
    data: TaskReopenIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).reopen_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


@task_router.delete(
    "/{task_id}",
    response_model=TaskOut,
    dependencies=[Depends(RequireRole("manager"))],
    summary="Soft-delete a task and preserve its audit trail",
)
async def soft_delete_task(
    task_id: UUID,
    data: TaskDeleteIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskOut:
    task = await TaskService(session).soft_delete_task(
        user_id,
        str(task_id),
        data,
    )
    return TaskOut.model_validate(task)


# ---------------------------------------------------------------------------
# Task comments and manager-only audit history
# ---------------------------------------------------------------------------


@task_router.get(
    "/{task_id}/comments",
    response_model=list[TaskCommentOut],
    summary="List comments for one visible task",
)
async def list_task_comments(
    task_id: UUID,
    session: SessionDep,
    user_id: CurrentUserId,
) -> list[TaskCommentOut]:
    rows = await TaskService(session).list_comments(
        user_id,
        str(task_id),
    )
    return [
        TaskCommentOut.model_validate(row)
        for row in rows
    ]


@task_router.post(
    "/{task_id}/comments",
    response_model=TaskCommentOut,
    status_code=status.HTTP_201_CREATED,
    summary="Comment on one visible task",
)
async def add_task_comment(
    task_id: UUID,
    data: TaskCommentCreateIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> TaskCommentOut:
    row = await TaskService(session).add_comment(
        user_id,
        str(task_id),
        data,
    )
    return TaskCommentOut.model_validate(row)


@task_router.get(
    "/{task_id}/history",
    response_model=list[TaskEventOut],
    summary="Full manager-only task audit history",
)
async def list_task_history(
    task_id: UUID,
    session: SessionDep,
    user_id: CurrentUserId,
) -> list[TaskEventOut]:
    rows = await TaskService(session).list_history(
        user_id,
        str(task_id),
    )
    return [
        TaskEventOut.model_validate(row)
        for row in rows
    ]
