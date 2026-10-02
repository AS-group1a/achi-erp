"""Projects routes, mounted under /api/v1/achi/projects by router.py."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Response, status
from fastapi.responses import HTMLResponse, PlainTextResponse

from app.dependencies import CurrentUserId, SessionDep

from .project_schemas import Company, ProjectIn, ProjectOut, ProjectUpdate, TaskIn, TaskOut, TaskUpdate
from .project_service import ProjectService

project_router = APIRouter(prefix="/projects")
_UI_DIR = Path(__file__).parent / "ui"
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}


@project_router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def projects_ui() -> HTMLResponse:
    return HTMLResponse((_UI_DIR / "projects.html").read_text(encoding="utf-8"), headers=_NO_STORE)


@project_router.get("/projects.css", response_class=PlainTextResponse, include_in_schema=False)
def projects_css() -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / "projects.css").read_text(encoding="utf-8"), media_type="text/css", headers=_NO_STORE)


@project_router.get("/projects.js", response_class=PlainTextResponse, include_in_schema=False)
def projects_js() -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / "projects.js").read_text(encoding="utf-8"), media_type="application/javascript", headers=_NO_STORE)


@project_router.get("/me")
async def projects_me(session: SessionDep, user_id: CurrentUserId) -> dict:
    return await ProjectService(session).access(user_id)


# Task routes come before the /{project_id} routes so "tasks" is never read as an id.
@project_router.get("/tasks", response_model=list[TaskOut])
async def list_tasks(
    session: SessionDep,
    user_id: CurrentUserId,
    company: Annotated[Company, Query()],
    project_id: Annotated[str | None, Query(max_length=36)] = None,
) -> list[TaskOut]:
    return await ProjectService(session).list_tasks(user_id, company, project_id)


@project_router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(data: TaskIn, session: SessionDep, user_id: CurrentUserId) -> TaskOut:
    return await ProjectService(session).create_task(user_id, data)


@project_router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: str, data: TaskUpdate, session: SessionDep, user_id: CurrentUserId) -> TaskOut:
    return await ProjectService(session).update_task(user_id, task_id, data)


@project_router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(task_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    await ProjectService(session).delete_task(user_id, task_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@project_router.get("/", response_model=list[ProjectOut])
async def list_projects(
    session: SessionDep, user_id: CurrentUserId, company: Annotated[Company, Query()],
) -> list[ProjectOut]:
    return await ProjectService(session).list_projects(user_id, company)


@project_router.post("/", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(data: ProjectIn, session: SessionDep, user_id: CurrentUserId) -> ProjectOut:
    return await ProjectService(session).create_project(user_id, data)


@project_router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: str, data: ProjectUpdate, session: SessionDep, user_id: CurrentUserId,
) -> ProjectOut:
    return await ProjectService(session).update_project(user_id, project_id, data)


@project_router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    await ProjectService(session).delete_project(user_id, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
