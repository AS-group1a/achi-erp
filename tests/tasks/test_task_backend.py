"""Database-free contract tests for ACHI Team Tasks.

Uses only unittest and in-memory fakes. Importing OCE requires a syntactically
valid PostgreSQL URL, but these tests never open a database connection.
"""

from __future__ import annotations

import os
import re
import unittest
import uuid
from datetime import datetime, timezone
from typing import Any

os.environ["DATABASE_URL"] = (
    "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_task_unit"
)
os.environ["APP_ENV"] = "development"
os.environ["OE_TEST_NULLPOOL"] = "1"

from fastapi import HTTPException
from fastapi.routing import APIRoute
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.dependencies import RequireRole
from modules.achi import task_service as service_module
from modules.achi.task_models import (
    AchiTask,
    AchiTaskComment,
    AchiTaskEvent,
)
from modules.achi.task_router import task_router
from modules.achi.task_schemas import (
    TaskApproveIn,
    TaskCancelIn,
    TaskCommentCreateIn,
    TaskCreateIn,
    TaskListOut,
    TaskProgressIn,
    TaskReopenIn,
    TaskReturnIn,
    TaskUpdateIn,
    WorkRequestCreateIn,
)
from modules.achi.task_service import TaskActor, TaskService


ADMIN_ID = "00000000-0000-4000-8000-000000000001"
MANAGER_ID = "00000000-0000-4000-8000-000000000002"
EDITOR_ID = "00000000-0000-4000-8000-000000000003"
OTHER_EDITOR_ID = "00000000-0000-4000-8000-000000000004"
VIEWER_ID = "00000000-0000-4000-8000-000000000005"
TASK_ID = "10000000-0000-4000-8000-000000000001"


ACTORS = {
    ADMIN_ID: TaskActor(ADMIN_ID, "Admin User", "admin"),
    MANAGER_ID: TaskActor(MANAGER_ID, "Manager User", "manager"),
    EDITOR_ID: TaskActor(EDITOR_ID, "Editor User", "editor"),
    OTHER_EDITOR_ID: TaskActor(
        OTHER_EDITOR_ID,
        "Other Editor",
        "editor",
    ),
    VIEWER_ID: TaskActor(VIEWER_ID, "Viewer User", "viewer"),
}


def make_task(
    *,
    task_id: str = TASK_ID,
    status: str = "to_do",
    assigned_to: str | None = EDITOR_ID,
    deleted: bool = False,
) -> AchiTask:
    now = datetime.now(timezone.utc)
    submitted = (
        now if status in {"ready_for_review", "completed"} else None
    )
    completed = now if status == "completed" else None
    blocked = now if status == "blocked" else None
    started = (
        now
        if status
        in {
            "in_progress",
            "blocked",
            "ready_for_review",
            "completed",
        }
        else None
    )

    return AchiTask(
        id=task_id,
        task_number="TASK-AAAAAAAAAAAAAAAAAAAAAAAAAA",
        title="Test task",
        description="Task description",
        status=status,
        priority="normal",
        assigned_to_user_id=assigned_to,
        assigned_to_name="Assigned User" if assigned_to else "",
        assigned_at=now if assigned_to else None,
        created_by_user_id=MANAGER_ID,
        created_by_name="Manager User",
        due_at=now,
        started_at=started,
        blocked_at=blocked,
        blocked_reason="Waiting for material" if blocked else "",
        submitted_at=submitted,
        completed_at=completed,
        completed_by_user_id=MANAGER_ID if completed else None,
        completed_by_name="Manager User" if completed else "",
        review_note="Existing review" if submitted else "",
        related_type="crm",
        related_id="lead-123",
        related_label="Example lead",
        is_deleted=deleted,
        deleted_at=now if deleted else None,
        deleted_by_user_id=MANAGER_ID if deleted else None,
        created_at=now,
        updated_at=now,
    )


class FakeSession:
    """Minimal async-session surface used by lifecycle methods."""

    def __init__(self, *, fail_commit: bool = False) -> None:
        self.fail_commit = fail_commit
        self.added: list[Any] = []
        self.commit_calls = 0
        self.rollback_calls = 0
        self.refresh_calls: list[Any] = []
        self.added_at_commit: list[tuple[Any, ...]] = []

    def add(self, row: Any) -> None:
        self.added.append(row)

    async def commit(self) -> None:
        self.commit_calls += 1
        self.added_at_commit.append(tuple(self.added))
        if self.fail_commit:
            raise RuntimeError("simulated commit failure")

    async def rollback(self) -> None:
        self.rollback_calls += 1

    async def refresh(self, row: Any) -> None:
        self.refresh_calls.append(row)


class MemoryTaskService(TaskService):
    """Runs real TaskService lifecycle logic with in-memory lookups."""

    def __init__(
        self,
        session: FakeSession,
        tasks: list[AchiTask],
        actors: dict[str, TaskActor] | None = None,
    ) -> None:
        super().__init__(session)  # type: ignore[arg-type]
        self.tasks = {task.id: task for task in tasks}
        self.actors = dict(actors or ACTORS)

    async def _actor(
        self,
        actor_id: str,
        *,
        for_update: bool = False,
    ) -> TaskActor:
        del for_update
        actor = self.actors.get(actor_id)
        if actor is None:
            raise HTTPException(
                status_code=401,
                detail="User not found or inactive",
            )
        return actor

    async def _assignee(self, user_id: str) -> TaskActor:
        try:
            canonical = str(uuid.UUID(str(user_id)))
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(
                status_code=422,
                detail="assigned_to_user_id must be a valid UUID",
            ) from None

        actor = self.actors.get(canonical)
        if actor is None:
            raise HTTPException(
                status_code=422,
                detail="Assignee was not found or is inactive",
            )
        return actor

    async def _visible_task(
        self,
        actor: TaskActor,
        task_id: str,
        *,
        for_update: bool = False,
        include_deleted: bool = False,
    ) -> AchiTask:
        del for_update
        task = self.tasks.get(task_id)

        if task is None:
            raise HTTPException(
                status_code=404,
                detail="Task not found",
            )

        if task.is_deleted and not include_deleted:
            raise HTTPException(
                status_code=404,
                detail="Task not found",
            )

        if not actor.is_manager:
            if task.is_deleted or task.assigned_to_user_id != actor.id:
                raise HTTPException(
                    status_code=404,
                    detail="Task not found",
                )

        return task

    async def _owned_task_for_update(
        self,
        actor: TaskActor,
        task_id: str,
    ) -> AchiTask:
        task = self.tasks.get(task_id)
        if (
            task is None
            or task.is_deleted
            or task.assigned_to_user_id != actor.id
        ):
            raise HTTPException(
                status_code=404,
                detail="Task not found",
            )
        return task

    async def _manager_task_for_update(
        self,
        actor: TaskActor,
        task_id: str,
        *,
        include_deleted: bool = False,
    ) -> AchiTask:
        self._require_manager(actor)
        task = self.tasks.get(task_id)

        if task is None or (task.is_deleted and not include_deleted):
            raise HTTPException(
                status_code=404,
                detail="Task not found",
            )

        return task


class CaptureListService(TaskService):
    """Captures generated SQL filters without executing them."""

    def __init__(self, actor: TaskActor) -> None:
        super().__init__(FakeSession())  # type: ignore[arg-type]
        self.actor = actor
        self.captured_conditions: list[Any] = []

    async def _actor(
        self,
        actor_id: str,
        *,
        for_update: bool = False,
    ) -> TaskActor:
        del actor_id, for_update
        return self.actor

    async def _task_page(
        self,
        conditions: list[Any],
        *,
        offset: int,
        limit: int,
    ) -> TaskListOut:
        self.captured_conditions = list(conditions)
        return TaskListOut(
            items=[],
            total=0,
            offset=offset,
            limit=limit,
        )


def added_events(session: FakeSession) -> list[AchiTaskEvent]:
    return [
        row
        for row in session.added
        if isinstance(row, AchiTaskEvent)
    ]


def added_comments(session: FakeSession) -> list[AchiTaskComment]:
    return [
        row
        for row in session.added
        if isinstance(row, AchiTaskComment)
    ]


def compiled_conditions(conditions: list[Any]) -> str:
    return " AND ".join(
        str(
            condition.compile(
                dialect=postgresql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        for condition in conditions
    ).lower()


class SchemaContractTests(unittest.TestCase):
    def assert_invalid(
        self,
        schema: type,
        payload: dict[str, Any],
    ) -> None:
        with self.assertRaises(ValidationError):
            schema.model_validate(payload)

    def test_employee_schemas_reject_supervisor_field_smuggling(
        self,
    ) -> None:
        forbidden_fields = (
            ("assigned_to_user_id", MANAGER_ID),
            ("priority", "urgent"),
            ("status", "completed"),
            ("created_by_user_id", ADMIN_ID),
            ("completed_by_user_id", ADMIN_ID),
            ("is_deleted", True),
            (
                "deleted_at",
                datetime.now(timezone.utc).isoformat(),
            ),
        )

        for field, value in forbidden_fields:
            with self.subTest(schema="progress", field=field):
                self.assert_invalid(
                    TaskProgressIn,
                    {"action": "start", field: value},
                )

            with self.subTest(schema="comment", field=field):
                self.assert_invalid(
                    TaskCommentCreateIn,
                    {"body": "Hello", field: value},
                )

            with self.subTest(
                schema="work-request",
                field=field,
            ):
                self.assert_invalid(
                    WorkRequestCreateIn,
                    {"message": "More work", field: value},
                )

    def test_supervisor_patch_rejects_lifecycle_smuggling(
        self,
    ) -> None:
        for field, value in (
            ("status", "completed"),
            (
                "started_at",
                datetime.now(timezone.utc).isoformat(),
            ),
            (
                "completed_at",
                datetime.now(timezone.utc).isoformat(),
            ),
            ("created_by_user_id", ADMIN_ID),
            ("deleted_by_user_id", ADMIN_ID),
            ("is_deleted", True),
        ):
            with self.subTest(field=field):
                self.assert_invalid(
                    TaskUpdateIn,
                    {"title": "Changed", field: value},
                )

    def test_progress_action_specific_validation(self) -> None:
        self.assert_invalid(
            TaskProgressIn,
            {"action": "block"},
        )
        self.assert_invalid(
            TaskProgressIn,
            {"action": "block", "reason": "   "},
        )
        self.assert_invalid(
            TaskProgressIn,
            {
                "action": "start",
                "reason": "Not allowed",
            },
        )
        self.assert_invalid(
            TaskProgressIn,
            {
                "action": "resume",
                "note": "Not allowed",
            },
        )

        valid = TaskProgressIn(
            action="submit",
            note="Ready for checking",
        )
        self.assertEqual(
            valid.note,
            "Ready for checking",
        )

    def test_patch_distinguishes_omitted_fields_from_null(
        self,
    ) -> None:
        title_only = TaskUpdateIn(title="Changed")
        self.assertEqual(
            title_only.model_dump(exclude_unset=True),
            {"title": "Changed"},
        )

        clear_fields = TaskUpdateIn(
            assigned_to_user_id=None,
            due_at=None,
        )
        self.assertEqual(
            clear_fields.model_dump(exclude_unset=True),
            {
                "assigned_to_user_id": None,
                "due_at": None,
            },
        )

        self.assert_invalid(TaskUpdateIn, {})
        self.assert_invalid(TaskUpdateIn, {"title": None})
        self.assert_invalid(TaskUpdateIn, {"priority": None})

    def test_create_related_reference_validation(self) -> None:
        self.assert_invalid(
            TaskCreateIn,
            {
                "title": "Task",
                "related_type": "crm",
            },
        )
        self.assert_invalid(
            TaskCreateIn,
            {
                "title": "Task",
                "related_id": "lead-1",
            },
        )
        self.assert_invalid(
            TaskCreateIn,
            {
                "title": "Task",
                "related_label": "Lead",
            },
        )

        valid = TaskCreateIn(
            title="Task",
            related_type="crm",
            related_id="lead-1",
            related_label="Lead",
        )
        self.assertEqual(valid.related_type, "crm")


class IdentityAndRoleTests(unittest.TestCase):
    def test_uuid_canonicalization(self) -> None:
        raw = "A0B1C2D3-E4F5-4678-8123-1234567890AB"
        expected = "a0b1c2d3-e4f5-4678-8123-1234567890ab"

        self.assertEqual(
            service_module._canonical_uuid(
                raw,
                detail="invalid",
            ),
            expected,
        )

        with self.assertRaises(HTTPException) as caught:
            service_module._canonical_uuid(
                "x" * 36,
                detail="invalid UUID",
            )

        self.assertEqual(
            caught.exception.status_code,
            422,
        )

    def test_task_identity_is_unique_and_fits_column(
        self,
    ) -> None:
        seen_ids: set[str] = set()
        seen_numbers: set[str] = set()

        for _ in range(100):
            task_id, task_number = (
                service_module._new_task_identity()
            )

            self.assertEqual(
                str(uuid.UUID(task_id)),
                task_id,
            )
            self.assertRegex(
                task_number,
                re.compile(r"^TASK-[A-Z2-7]{26}$"),
            )
            self.assertLessEqual(
                len(task_number),
                32,
            )

            seen_ids.add(task_id)
            seen_numbers.add(task_number)

        self.assertEqual(len(seen_ids), 100)
        self.assertEqual(len(seen_numbers), 100)

    def test_role_capabilities(self) -> None:
        expected = {
            "admin": (True, True),
            "manager": (True, True),
            "editor": (False, True),
            "viewer": (False, False),
        }

        for role, capabilities in expected.items():
            with self.subTest(role=role):
                actor = TaskActor("id", "Name", role)
                self.assertEqual(
                    actor.is_manager,
                    capabilities[0],
                )
                self.assertEqual(
                    actor.can_write,
                    capabilities[1],
                )

    def test_service_role_guards(self) -> None:
        for actor_id in (ADMIN_ID, MANAGER_ID):
            TaskService._require_manager(
                ACTORS[actor_id]
            )
            TaskService._require_writer(
                ACTORS[actor_id]
            )

        TaskService._require_writer(
            ACTORS[EDITOR_ID]
        )

        with self.assertRaises(
            HTTPException
        ) as editor_denial:
            TaskService._require_manager(
                ACTORS[EDITOR_ID]
            )
        self.assertEqual(
            editor_denial.exception.status_code,
            403,
        )

        with self.assertRaises(
            HTTPException
        ) as viewer_denial:
            TaskService._require_writer(
                ACTORS[VIEWER_ID]
            )
        self.assertEqual(
            viewer_denial.exception.status_code,
            403,
        )


class OwnershipAndLifecycleTests(
    unittest.IsolatedAsyncioTestCase
):
    async def test_editor_can_only_progress_owned_task(
        self,
    ) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        self.assertIs(
            await service.get_task(
                EDITOR_ID,
                task.id,
            ),
            task,
        )

        with self.assertRaises(
            HTTPException
        ) as other_read:
            await service.get_task(
                OTHER_EDITOR_ID,
                task.id,
            )
        self.assertEqual(
            other_read.exception.status_code,
            404,
        )

        with self.assertRaises(
            HTTPException
        ) as other_write:
            await service.progress_task(
                OTHER_EDITOR_ID,
                task.id,
                TaskProgressIn(action="start"),
            )
        self.assertEqual(
            other_write.exception.status_code,
            404,
        )
        self.assertEqual(task.status, "to_do")
        self.assertEqual(session.commit_calls, 0)
        self.assertEqual(session.added, [])

    async def test_viewer_reads_but_cannot_progress(
        self,
    ) -> None:
        task = make_task(assigned_to=VIEWER_ID)
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        self.assertIs(
            await service.get_task(
                VIEWER_ID,
                task.id,
            ),
            task,
        )

        with self.assertRaises(
            HTTPException
        ) as denial:
            await service.progress_task(
                VIEWER_ID,
                task.id,
                TaskProgressIn(action="start"),
            )

        self.assertEqual(
            denial.exception.status_code,
            403,
        )
        self.assertEqual(task.status, "to_do")
        self.assertEqual(session.commit_calls, 0)
        self.assertEqual(session.added, [])

    async def test_editor_complete_progression(self) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.progress_task(
            EDITOR_ID,
            task.id,
            TaskProgressIn(action="start"),
        )
        self.assertEqual(
            task.status,
            "in_progress",
        )
        self.assertIsNotNone(task.started_at)
        self.assertEqual(
            added_events(session)[-1].event_type,
            "started",
        )

        await service.progress_task(
            EDITOR_ID,
            task.id,
            TaskProgressIn(
                action="block",
                reason="Waiting for dimensions",
            ),
        )
        self.assertEqual(task.status, "blocked")
        self.assertEqual(
            task.blocked_reason,
            "Waiting for dimensions",
        )
        self.assertIsNotNone(task.blocked_at)
        self.assertEqual(
            added_events(session)[-1].event_type,
            "blocked",
        )
        self.assertEqual(
            added_comments(session)[-1].kind,
            "blocked_reason",
        )

        await service.progress_task(
            EDITOR_ID,
            task.id,
            TaskProgressIn(action="resume"),
        )
        self.assertEqual(
            task.status,
            "in_progress",
        )
        self.assertIsNone(task.blocked_at)
        self.assertEqual(task.blocked_reason, "")
        self.assertEqual(
            added_events(session)[-1].event_type,
            "resumed",
        )

        await service.progress_task(
            EDITOR_ID,
            task.id,
            TaskProgressIn(
                action="submit",
                note="Evidence attached",
            ),
        )
        self.assertEqual(
            task.status,
            "ready_for_review",
        )
        self.assertIsNotNone(task.submitted_at)
        self.assertEqual(
            added_events(session)[-1].event_type,
            "submitted",
        )
        self.assertEqual(
            added_comments(session)[-1].kind,
            "review_submission",
        )
        self.assertEqual(session.commit_calls, 4)

    async def test_task_can_block_from_to_do(self) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.progress_task(
            EDITOR_ID,
            task.id,
            TaskProgressIn(
                action="block",
                reason="Access unavailable",
            ),
        )

        self.assertEqual(task.status, "blocked")
        self.assertIsNotNone(task.started_at)
        self.assertEqual(
            added_events(session)[-1].event_type,
            "blocked",
        )

    async def test_invalid_transition_adds_nothing(
        self,
    ) -> None:
        task = make_task(status="in_progress")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        with self.assertRaises(
            HTTPException
        ) as conflict:
            await service.progress_task(
                EDITOR_ID,
                task.id,
                TaskProgressIn(action="start"),
            )

        self.assertEqual(
            conflict.exception.status_code,
            409,
        )
        self.assertEqual(
            task.status,
            "in_progress",
        )
        self.assertEqual(session.added, [])
        self.assertEqual(session.commit_calls, 0)


class ManagerLifecycleTests(
    unittest.IsolatedAsyncioTestCase
):
    async def test_manager_approves_ready_task(self) -> None:
        task = make_task(status="ready_for_review")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.approve_task(
            MANAGER_ID,
            task.id,
            TaskApproveIn(note="Approved"),
        )

        self.assertEqual(task.status, "completed")
        self.assertIsNotNone(task.completed_at)
        self.assertEqual(
            task.completed_by_user_id,
            MANAGER_ID,
        )
        self.assertEqual(
            task.completed_by_name,
            "Manager User",
        )
        self.assertEqual(
            task.review_note,
            "Approved",
        )
        self.assertEqual(
            added_events(session)[-1].event_type,
            "approved",
        )
        self.assertEqual(
            added_comments(session)[-1].kind,
            "supervisor_review",
        )

    async def test_manager_returns_for_changes(
        self,
    ) -> None:
        task = make_task(status="ready_for_review")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.return_task(
            MANAGER_ID,
            task.id,
            TaskReturnIn(
                note="Please correct the quantities"
            ),
        )

        self.assertEqual(
            task.status,
            "in_progress",
        )
        self.assertIsNone(task.submitted_at)
        self.assertEqual(
            task.review_note,
            "Please correct the quantities",
        )
        self.assertEqual(
            added_events(session)[-1].event_type,
            "returned",
        )

    async def test_cancel_then_reopen_assigned_task(
        self,
    ) -> None:
        task = make_task(status="in_progress")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.cancel_task(
            MANAGER_ID,
            task.id,
            TaskCancelIn(
                reason="No longer required"
            ),
        )
        self.assertEqual(task.status, "cancelled")

        await service.reopen_task(
            MANAGER_ID,
            task.id,
            TaskReopenIn(note="Required again"),
        )

        self.assertEqual(task.status, "to_do")
        self.assertIsNone(task.started_at)
        self.assertIsNone(task.blocked_at)
        self.assertEqual(task.blocked_reason, "")
        self.assertIsNone(task.submitted_at)
        self.assertIsNone(task.completed_at)
        self.assertEqual(
            task.completed_by_name,
            "",
        )
        self.assertEqual(task.review_note, "")
        self.assertEqual(
            added_events(session)[-1].event_type,
            "reopened",
        )

    async def test_unassigned_task_reopens_unassigned(
        self,
    ) -> None:
        task = make_task(
            status="cancelled",
            assigned_to=None,
        )
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.reopen_task(
            ADMIN_ID,
            task.id,
            TaskReopenIn(
                note="Reopen without assignment"
            ),
        )

        self.assertEqual(
            task.status,
            "unassigned",
        )

    async def test_editor_cannot_approve(self) -> None:
        task = make_task(status="ready_for_review")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        with self.assertRaises(
            HTTPException
        ) as denial:
            await service.approve_task(
                EDITOR_ID,
                task.id,
                TaskApproveIn(note="Self approve"),
            )

        self.assertEqual(
            denial.exception.status_code,
            403,
        )
        self.assertEqual(
            task.status,
            "ready_for_review",
        )
        self.assertEqual(session.commit_calls, 0)


class PatchInvariantTests(
    unittest.IsolatedAsyncioTestCase
):
    async def test_title_patch_preserves_other_fields(
        self,
    ) -> None:
        task = make_task()
        original_assignee = task.assigned_to_user_id
        original_due = task.due_at
        original_relation = (
            task.related_type,
            task.related_id,
            task.related_label,
        )
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.update_task(
            MANAGER_ID,
            task.id,
            TaskUpdateIn(title="Updated title"),
        )

        self.assertEqual(
            task.title,
            "Updated title",
        )
        self.assertEqual(
            task.assigned_to_user_id,
            original_assignee,
        )
        self.assertEqual(task.due_at, original_due)
        self.assertEqual(
            (
                task.related_type,
                task.related_id,
                task.related_label,
            ),
            original_relation,
        )

    async def test_clearing_reference_clears_all(
        self,
    ) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.update_task(
            MANAGER_ID,
            task.id,
            TaskUpdateIn(related_type=None),
        )

        self.assertIsNone(task.related_type)
        self.assertIsNone(task.related_id)
        self.assertEqual(task.related_label, "")

    async def test_partial_related_reference_rejected(
        self,
    ) -> None:
        task = make_task()
        task.related_type = None
        task.related_id = None
        task.related_label = ""

        patches = (
            TaskUpdateIn(related_type="crm"),
            TaskUpdateIn(related_id="lead-123"),
            TaskUpdateIn(
                related_label="Orphan label"
            ),
            TaskUpdateIn(
                related_type="crm",
                related_id=None,
            ),
        )

        for patch in patches:
            with self.subTest(
                patch=patch.model_dump(
                    exclude_unset=True
                )
            ):
                session = FakeSession()
                service = MemoryTaskService(
                    session,
                    [task],
                )

                with self.assertRaises(
                    HTTPException
                ) as invalid:
                    await service.update_task(
                        MANAGER_ID,
                        task.id,
                        patch,
                    )

                self.assertEqual(
                    invalid.exception.status_code,
                    422,
                )
                self.assertEqual(
                    session.commit_calls,
                    0,
                )
                self.assertEqual(session.added, [])

    async def test_reassignment_resets_lifecycle(
        self,
    ) -> None:
        task = make_task(status="blocked")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        await service.update_task(
            MANAGER_ID,
            task.id,
            TaskUpdateIn(
                assigned_to_user_id=OTHER_EDITOR_ID,
            ),
        )

        self.assertEqual(
            task.assigned_to_user_id,
            OTHER_EDITOR_ID,
        )
        self.assertEqual(task.status, "to_do")
        self.assertIsNone(task.started_at)
        self.assertIsNone(task.blocked_at)
        self.assertEqual(task.blocked_reason, "")
        self.assertEqual(
            added_events(session)[-1].event_type,
            "reassigned",
        )

    async def test_terminal_requires_reopen_before_reassign(
        self,
    ) -> None:
        task = make_task(status="completed")
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        with self.assertRaises(
            HTTPException
        ) as conflict:
            await service.update_task(
                MANAGER_ID,
                task.id,
                TaskUpdateIn(
                    assigned_to_user_id=OTHER_EDITOR_ID,
                ),
            )

        self.assertEqual(
            conflict.exception.status_code,
            409,
        )
        self.assertEqual(
            task.assigned_to_user_id,
            EDITOR_ID,
        )
        self.assertEqual(task.status, "completed")
        self.assertEqual(session.commit_calls, 0)


class AtomicEventTests(
    unittest.IsolatedAsyncioTestCase
):
    def test_add_event_stages_without_commit(self) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        event = service._add_event(
            task,
            ACTORS[EDITOR_ID],
            "started",
            from_status="to_do",
            to_status="in_progress",
        )

        self.assertIn(event, session.added)
        self.assertEqual(session.commit_calls, 0)
        self.assertEqual(event.task_id, task.id)
        self.assertEqual(
            event.actor_user_id,
            EDITOR_ID,
        )

    async def test_commit_failure_rolls_back(self) -> None:
        task = make_task()
        session = FakeSession(fail_commit=True)
        service = MemoryTaskService(
            session,
            [task],
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "simulated commit failure",
        ):
            await service.progress_task(
                EDITOR_ID,
                task.id,
                TaskProgressIn(action="start"),
            )

        self.assertEqual(session.commit_calls, 1)
        self.assertEqual(session.rollback_calls, 1)
        self.assertEqual(session.refresh_calls, [])
        self.assertEqual(
            len(session.added_at_commit),
            1,
        )

        staged = session.added_at_commit[0]
        events = [
            row
            for row in staged
            if isinstance(row, AchiTaskEvent)
        ]
        self.assertEqual(len(events), 1)
        self.assertEqual(
            events[0].event_type,
            "started",
        )

    def test_unknown_event_is_not_staged(self) -> None:
        task = make_task()
        session = FakeSession()
        service = MemoryTaskService(
            session,
            [task],
        )

        with self.assertRaises(RuntimeError):
            service._add_event(
                task,
                ACTORS[MANAGER_ID],
                "invented_event",
                from_status="to_do",
                to_status="to_do",
            )

        self.assertEqual(session.added, [])
        self.assertEqual(session.commit_calls, 0)


class DeletedFilterTests(
    unittest.IsolatedAsyncioTestCase
):
    async def test_mine_filters_owner_and_deleted(
        self,
    ) -> None:
        service = CaptureListService(
            ACTORS[EDITOR_ID]
        )

        await service.list_mine(EDITOR_ID)
        sql = compiled_conditions(
            service.captured_conditions
        )

        self.assertIn(
            "assigned_to_user_id",
            sql,
        )
        self.assertIn(EDITOR_ID, sql)
        self.assertIn(
            "is_deleted is false",
            sql,
        )

    async def test_team_excludes_deleted_by_default(
        self,
    ) -> None:
        service = CaptureListService(
            ACTORS[MANAGER_ID]
        )

        await service.list_team(
            MANAGER_ID,
            include_deleted=False,
        )
        sql = compiled_conditions(
            service.captured_conditions
        )

        self.assertIn(
            "is_deleted is false",
            sql,
        )

    async def test_team_can_include_deleted(
        self,
    ) -> None:
        service = CaptureListService(
            ACTORS[MANAGER_ID]
        )

        await service.list_team(
            MANAGER_ID,
            include_deleted=True,
        )
        sql = compiled_conditions(
            service.captured_conditions
        )

        self.assertNotIn("is_deleted", sql)


class RouterMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.routes = [
            route
            for route in task_router.routes
            if isinstance(route, APIRoute)
        ]

    @staticmethod
    def manager_requirement(
        route: APIRoute,
    ) -> str | None:
        calls: list[Any] = []

        dependant = getattr(
            route,
            "dependant",
            None,
        )
        for dependency in getattr(
            dependant,
            "dependencies",
            (),
        ):
            calls.append(
                getattr(dependency, "call", None)
            )

        for dependency in getattr(
            route,
            "dependencies",
            (),
        ):
            calls.append(
                getattr(
                    dependency,
                    "dependency",
                    None,
                )
            )

        for call in calls:
            if isinstance(call, RequireRole):
                return call.required

        return None

    def test_exact_method_and_path_contract(self) -> None:
        actual = {
            (method, route.path)
            for route in self.routes
            for method in route.methods
        }

        expected = {
            ("GET", "/tasks/ui"),
            ("GET", "/tasks/team_tasks.css"),
            ("GET", "/tasks/team_tasks.js"),
            ("GET", "/tasks/access/me"),
            ("GET", "/tasks/mine"),
            ("GET", "/tasks/team"),
            ("GET", "/tasks/assignees"),
            ("POST", "/tasks/work-requests"),
            ("GET", "/tasks/work-requests/mine"),
            ("GET", "/tasks/work-requests/team"),
            (
                "POST",
                "/tasks/work-requests/"
                "{request_id}/acknowledge",
            ),
            (
                "POST",
                "/tasks/work-requests/"
                "{request_id}/cancel",
            ),
            ("POST", "/tasks"),
            ("GET", "/tasks/{task_id}"),
            ("PATCH", "/tasks/{task_id}"),
            (
                "PATCH",
                "/tasks/{task_id}/progress",
            ),
            (
                "POST",
                "/tasks/{task_id}/approve",
            ),
            (
                "POST",
                "/tasks/{task_id}/return",
            ),
            (
                "POST",
                "/tasks/{task_id}/cancel",
            ),
            (
                "POST",
                "/tasks/{task_id}/reopen",
            ),
            ("DELETE", "/tasks/{task_id}"),
            (
                "GET",
                "/tasks/{task_id}/comments",
            ),
            (
                "POST",
                "/tasks/{task_id}/comments",
            ),
            (
                "GET",
                "/tasks/{task_id}/history",
            ),
        }

        self.assertEqual(actual, expected)

    def test_static_ui_routes_precede_dynamic_task_id_route(self) -> None:
        paths = [route.path for route in self.routes]
        dynamic_index = paths.index("/tasks/{task_id}")

        for static_path in (
            "/tasks/ui",
            "/tasks/team_tasks.css",
            "/tasks/team_tasks.js",
        ):
            self.assertLess(
                paths.index(static_path),
                dynamic_index,
                f"{static_path} must be declared before /tasks/{{task_id}}",
            )

    def test_manager_routes_are_guarded(self) -> None:
        guarded = {
            (method, route.path)
            for route in self.routes
            if self.manager_requirement(route) == "manager"
            for method in route.methods
        }

        expected_guarded = {
            ("GET", "/tasks/team"),
            ("GET", "/tasks/assignees"),
            (
                "GET",
                "/tasks/work-requests/team",
            ),
            (
                "POST",
                "/tasks/work-requests/"
                "{request_id}/acknowledge",
            ),
            ("POST", "/tasks"),
            ("PATCH", "/tasks/{task_id}"),
            (
                "POST",
                "/tasks/{task_id}/approve",
            ),
            (
                "POST",
                "/tasks/{task_id}/return",
            ),
            (
                "POST",
                "/tasks/{task_id}/cancel",
            ),
            (
                "POST",
                "/tasks/{task_id}/reopen",
            ),
            ("DELETE", "/tasks/{task_id}"),
            (
                "GET",
                "/tasks/{task_id}/history",
            ),
        }

        self.assertEqual(
            guarded,
            expected_guarded,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)