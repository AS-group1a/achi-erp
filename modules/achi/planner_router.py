"""HTTP routes and static assets for the ACHI Planner."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, status
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

from app.dependencies import CurrentUserId, SessionDep

from .planner_schemas import (
    PlannerEventCreateIn,
    PlannerEventListOut,
    PlannerEventOut,
    PlannerEventUpdateIn,
    PlannerConflictOut,
    PlannerConflictQueryIn,
    PlannerRsvpIn,
    PlannerTaskBlockCreateIn,
    PlannerTaskListOut,
    PlannerUserOut,
    PlannerRelatedRecordOut,
    PlannerSourceEventOut,
)
from .planner_service import PlannerService


planner_router = APIRouter(prefix="/planner")
_UI_DIR = Path(__file__).parent / "ui"


@planner_router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def planner_ui() -> HTMLResponse:
    return HTMLResponse((_UI_DIR / "planner.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-store, max-age=0"})


@planner_router.get("/planner.css", response_class=PlainTextResponse, include_in_schema=False)
def planner_css() -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / "planner.css").read_text(encoding="utf-8"), media_type="text/css", headers={"Cache-Control": "no-store, max-age=0"})


@planner_router.get("/planner.js", response_class=PlainTextResponse, include_in_schema=False)
def planner_js() -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / "planner.js").read_text(encoding="utf-8"), media_type="application/javascript", headers={"Cache-Control": "no-store, max-age=0"})


@planner_router.get("/events", response_model=PlannerEventListOut)
async def list_planner_events(
    session: SessionDep,
    user_id: CurrentUserId,
    start: Annotated[datetime, Query()],
    end: Annotated[datetime, Query()],
) -> PlannerEventListOut:
    return await PlannerService(session).list_events(user_id, start, end)


@planner_router.get("/tasks/unscheduled", response_model=PlannerTaskListOut)
async def list_unscheduled_tasks(
    session: SessionDep,
    user_id: CurrentUserId,
) -> PlannerTaskListOut:
    return await PlannerService(session).list_unscheduled_tasks(user_id)


@planner_router.get("/related-records", response_model=list[PlannerRelatedRecordOut])
async def search_planner_related_records(
    session: SessionDep,
    user_id: CurrentUserId,
    q: Annotated[str, Query(min_length=2, max_length=255)],
) -> list[PlannerRelatedRecordOut]:
    return await PlannerService(session).search_related_records(user_id, q)


@planner_router.get("/sources/crm-follow-ups", response_model=list[PlannerSourceEventOut])
async def planner_crm_follow_ups(
    session: SessionDep,
    user_id: CurrentUserId,
    start: Annotated[datetime, Query()],
    end: Annotated[datetime, Query()],
) -> list[PlannerSourceEventOut]:
    return await PlannerService(session).crm_follow_ups(user_id, start, end)


@planner_router.get("/sources/site-visits", response_model=list[PlannerSourceEventOut])
async def planner_scheduled_site_visits(
    session: SessionDep,
    user_id: CurrentUserId,
    start: Annotated[datetime, Query()],
    end: Annotated[datetime, Query()],
) -> list[PlannerSourceEventOut]:
    return await PlannerService(session).scheduled_site_visits(user_id, start, end)


@planner_router.post("/task-blocks", response_model=PlannerEventOut, status_code=status.HTTP_201_CREATED)
async def schedule_task_block(
    data: PlannerTaskBlockCreateIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> PlannerEventOut:
    return await PlannerService(session).schedule_task_block(user_id, data)


@planner_router.post("/events", response_model=PlannerEventOut, status_code=status.HTTP_201_CREATED)
async def create_planner_event(data: PlannerEventCreateIn, session: SessionDep, user_id: CurrentUserId) -> PlannerEventOut:
    return await PlannerService(session).create_event(user_id, data)


@planner_router.post("/conflicts", response_model=list[PlannerConflictOut])
async def planner_conflicts(
    data: PlannerConflictQueryIn,
    session: SessionDep,
    user_id: CurrentUserId,
) -> list[PlannerConflictOut]:
    return await PlannerService(session).conflicts(
        user_id, data.user_ids, data.start_at, data.end_at, data.exclude_event_id
    )


@planner_router.patch("/events/{event_id}", response_model=PlannerEventOut)
async def update_planner_event(event_id: str, data: PlannerEventUpdateIn, session: SessionDep, user_id: CurrentUserId) -> PlannerEventOut:
    return await PlannerService(session).update_event(user_id, event_id, data)


@planner_router.post("/events/{event_id}/rsvp", response_model=PlannerEventOut)
async def rsvp_to_planner_event(event_id: str, data: PlannerRsvpIn, session: SessionDep, user_id: CurrentUserId) -> PlannerEventOut:
    return await PlannerService(session).rsvp(user_id, event_id, data)


@planner_router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_planner_event(event_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    await PlannerService(session).delete_event(user_id, event_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@planner_router.get("/users", response_model=list[PlannerUserOut])
async def list_planner_users(session: SessionDep, user_id: CurrentUserId) -> list[PlannerUserOut]:
    return await PlannerService(session).list_users(user_id)


@planner_router.get("/users/me", response_model=PlannerUserOut)
async def planner_me(session: SessionDep, user_id: CurrentUserId) -> PlannerUserOut:
    return await PlannerService(session).me(user_id)
