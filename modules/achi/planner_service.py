"""Authorization and persistence rules for the ACHI Planner."""

from __future__ import annotations

import uuid
from calendar import monthrange
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .planner_models import AchiPlannerEvent, AchiPlannerEventAttendee, AchiPlannerReminder
from .planner_schemas import (
    PlannerAttendeeIn,
    PlannerAttendeeOut,
    PlannerConflictOut,
    PlannerEventCreateIn,
    PlannerEventListOut,
    PlannerEventOut,
    PlannerEventUpdateIn,
    PlannerRsvpIn,
    PlannerRelatedRecordOut,
    PlannerSourceEventOut,
    PlannerTaskBlockCreateIn,
    PlannerTaskListOut,
    PlannerTaskOut,
    PlannerUserOut,
)
from .models import ContactFile, FileLog, SiteSurvey
from .task_models import AchiTask
from .task_service import TaskService


_MANAGER_ROLES = frozenset({"admin", "manager"})
_WRITER_ROLES = frozenset({"admin", "manager", "editor"})
_TERMINAL_TASK_STATUSES = frozenset({"completed", "cancelled"})


def _display_name(user: User) -> str:
    return (user.full_name or "").strip() or f"User {str(user.id)[:8]}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _recurrence_parts(rule: str | None) -> tuple[str, int] | None:
    """Parse the intentionally small RRULE subset used by the Planner UI.

    A series remains one database row.  This accepts only a frequency and an
    optional interval, so unsupported RRULE fields cannot appear to work while
    silently producing an incorrect calendar.
    """
    if not rule:
        return None
    values: dict[str, str] = {}
    for part in rule.upper().split(";"):
        key, separator, value = part.partition("=")
        if not separator or not key or not value or key in values:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "recurrence_rule is invalid")
        values[key] = value
    if set(values) - {"FREQ", "INTERVAL"} or values.get("FREQ") not in {"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "recurrence_rule must use DAILY, WEEKLY, MONTHLY, or YEARLY")
    try:
        interval = int(values.get("INTERVAL", "1"))
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "recurrence interval must be a number") from None
    if interval < 1 or interval > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "recurrence interval must be between 1 and 365")
    return values["FREQ"], interval


def _next_occurrence(value: datetime, frequency: str, interval: int) -> datetime:
    if frequency == "DAILY":
        return value + timedelta(days=interval)
    if frequency == "WEEKLY":
        return value + timedelta(weeks=interval)
    if frequency == "MONTHLY":
        month_index = value.month - 1 + interval
        year, month = value.year + month_index // 12, month_index % 12 + 1
        return value.replace(year=year, month=month, day=min(value.day, monthrange(year, month)[1]))
    year = value.year + interval
    return value.replace(year=year, day=min(value.day, monthrange(year, value.month)[1]))


class PlannerService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _actor(self, actor_id: str) -> User:
        try:
            user_id = uuid.UUID(str(actor_id))
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authenticated user") from None
        user = (await self.session.execute(
            select(User).where(User.id == user_id, User.is_active.is_(True))
        )).scalar_one_or_none()
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
        return user

    @staticmethod
    def _can_write(user: User) -> bool:
        return (user.role or "").strip().lower() in _WRITER_ROLES

    @staticmethod
    def _can_manage(user: User) -> bool:
        return (user.role or "").strip().lower() in _MANAGER_ROLES

    async def list_users(self, actor_id: str) -> list[PlannerUserOut]:
        await self._actor(actor_id)
        users = (await self.session.execute(
            select(User).where(User.is_active.is_(True)).order_by(User.full_name, User.id)
        )).scalars().all()
        return [PlannerUserOut(user_id=str(user.id), display_name=_display_name(user), role=(user.role or "").strip().lower()) for user in users]

    async def me(self, actor_id: str) -> PlannerUserOut:
        user = await self._actor(actor_id)
        return PlannerUserOut(user_id=str(user.id), display_name=_display_name(user), role=(user.role or "").strip().lower())

    async def search_related_records(self, actor_id: str, query: str) -> list[PlannerRelatedRecordOut]:
        """Find existing Log/CRM/Site Visit files to link; never copies them."""
        await self._actor(actor_id)
        text = query.strip()
        if len(text) < 2:
            return []
        needle = f"%{text}%"
        files = (await self.session.execute(
            select(ContactFile)
            .where(or_(
                ContactFile.file_number.ilike(needle),
                ContactFile.log_code.ilike(needle),
                ContactFile.subject.ilike(needle),
                ContactFile.lead_first_name.ilike(needle),
                ContactFile.lead_last_name.ilike(needle),
                ContactFile.lead_company.ilike(needle),
            ))
            .order_by(ContactFile.created_at.desc())
            .limit(20)
        )).scalars().all()
        return [PlannerRelatedRecordOut(
            record_type="contact_file", record_id=file.id,
            label=" · ".join(part for part in (
                file.log_code or file.file_number,
                file.subject or file.lead_company or "Untitled record",
            ) if part),
            stage=file.stage,
            location=", ".join(part for part in (file.city, file.district) if part),
        ) for file in files]

    async def _validate_related_record(self, record_type: str | None, record_id: str | None) -> None:
        if record_type is None and record_id is None:
            return
        if record_type != "contact_file" or record_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Planner currently supports ContactFile record links")
        record = (await self.session.execute(
            select(ContactFile.id).where(ContactFile.id == record_id)
        )).scalar_one_or_none()
        if record is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Related ACHI record was not found")

    async def crm_follow_ups(self, actor_id: str, start: datetime, end: datetime) -> list[PlannerSourceEventOut]:
        """Project reliable CRM follow-up dates without creating Planner rows.

        FileLog remains the single editable source.
        """
        await self._actor(actor_id)
        if end <= start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end must be after start")
        local_zone = ZoneInfo("Asia/Beirut")
        start_day = start.astimezone(local_zone).date()
        end_day = end.astimezone(local_zone).date()
        rows = (await self.session.execute(
            select(FileLog, ContactFile)
            .join(ContactFile, ContactFile.id == FileLog.file_id)
            .where(
                FileLog.deleted_at.is_(None),
                FileLog.follow_up_date.is_not(None),
                FileLog.follow_up_date >= start_day,
                FileLog.follow_up_date < end_day,
            )
            .order_by(FileLog.follow_up_date, ContactFile.file_number)
        )).all()
        output: list[PlannerSourceEventOut] = []
        for log, file in rows:
            start_at = datetime.combine(log.follow_up_date, datetime.min.time(), tzinfo=local_zone)
            label = file.log_code or file.file_number
            subject = file.subject or file.lead_company or label
            output.append(PlannerSourceEventOut(
                id=f"crm-follow-up:{log.id}", title=f"Follow up — {subject}",
                start_at=start_at, end_at=start_at + timedelta(days=1),
                related_record_type="contact_file", related_record_id=file.id,
                related_record_label=label,
            ))
        return output

    async def scheduled_site_visits(self, actor_id: str, start: datetime, end: datetime) -> list[PlannerSourceEventOut]:
        """Project scheduled SiteSurvey records without creating Planner rows.

        The Site Visit shared-log workspace does not own a date field.  The
        established ``achi_site_survey.scheduled_for`` field is therefore the
        only authoritative Site Visit schedule used here.
        """
        await self._actor(actor_id)
        if end <= start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end must be after start")
        rows = (await self.session.execute(
            select(SiteSurvey)
            .where(
                SiteSurvey.scheduled_for.is_not(None),
                SiteSurvey.scheduled_for >= start,
                SiteSurvey.scheduled_for < end,
            )
            .order_by(SiteSurvey.scheduled_for, SiteSurvey.survey_number)
        )).scalars().all()
        output: list[PlannerSourceEventOut] = []
        for survey in rows:
            scheduled_for = survey.scheduled_for
            if scheduled_for is None:  # narrows the nullable model attribute
                continue
            if scheduled_for.tzinfo is None:
                scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
            customer = survey.customer or survey.lead_company or survey.lead_name or "Site visit"
            location = ", ".join(part for part in (survey.city, survey.district) if part)
            output.append(PlannerSourceEventOut(
                id=f"site-visit:{survey.id}",
                title=f"Site visit — {customer}",
                start_at=scheduled_for,
                end_at=scheduled_for + timedelta(hours=1),
                all_day=False,
                event_type="site_visit",
                source="site_visit",
                related_record_type="site_survey",
                related_record_id=survey.id,
                related_record_label=survey.survey_number + (f" · {location}" if location else ""),
            ))
        return output

    async def list_events(self, actor_id: str, start: datetime, end: datetime) -> PlannerEventListOut:
        actor = await self._actor(actor_id)
        if end <= start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end must be after start")
        events = (await self.session.execute(
            select(AchiPlannerEvent)
            .where(
                AchiPlannerEvent.deleted_at.is_(None),
                AchiPlannerEvent.status == "scheduled",
                or_(
                    and_(
                        AchiPlannerEvent.recurrence_rule.is_(None),
                        AchiPlannerEvent.start_at < end,
                        AchiPlannerEvent.end_at > start,
                    ),
                    and_(
                        AchiPlannerEvent.recurrence_rule.is_not(None),
                        AchiPlannerEvent.start_at < end,
                        or_(
                            AchiPlannerEvent.recurrence_end_at.is_(None),
                            AchiPlannerEvent.recurrence_end_at >= start,
                        ),
                    ),
                ),
            )
            .order_by(AchiPlannerEvent.start_at, AchiPlannerEvent.end_at, AchiPlannerEvent.title)
        )).scalars().all()
        actor_id_text = str(actor.id)
        items: list[PlannerEventOut] = []
        for event in events:
            occurrences = self._occurrences(event, start, end)
            for occurrence_start, occurrence_end in occurrences:
                items.append(await self._out(
                    event, actor_id_text, start_at=occurrence_start, end_at=occurrence_end,
                ))
        items.sort(key=lambda item: (item.start_at, item.end_at, item.title))
        return PlannerEventListOut(items=items)

    @staticmethod
    def _occurrences(event: AchiPlannerEvent, window_start: datetime, window_end: datetime) -> list[tuple[datetime, datetime]]:
        parts = _recurrence_parts(event.recurrence_rule)
        if parts is None:
            return [(event.start_at, event.end_at)]
        frequency, interval = parts
        local_zone = ZoneInfo(event.timezone)
        local_start = event.start_at.astimezone(local_zone)
        duration = event.end_at - event.start_at
        recurrence_end = event.recurrence_end_at
        occurrence = local_start
        output: list[tuple[datetime, datetime]] = []
        # The requested range is bounded by the UI.  The cap also prevents an
        # accidental malformed series from creating an unbounded API response.
        for _ in range(10_000):
            occurrence_start = occurrence.astimezone(timezone.utc)
            if recurrence_end is not None and occurrence_start > recurrence_end:
                break
            occurrence_end = occurrence_start + duration
            if occurrence_start >= window_end:
                break
            if occurrence_end > window_start:
                output.append((occurrence_start, occurrence_end))
            occurrence = _next_occurrence(occurrence, frequency, interval)
        return output

    async def list_unscheduled_tasks(self, actor_id: str) -> PlannerTaskListOut:
        """Return visible active tasks that can receive another Planner block.

        This is intentionally a read-only Planner projection. It neither changes
        a task's workflow nor invents a second task record.
        """
        actor = await self._actor(actor_id)
        scheduled_block_counts = Counter((await self.session.execute(
            select(AchiPlannerEvent.related_task_id).where(
                AchiPlannerEvent.deleted_at.is_(None),
                AchiPlannerEvent.status == "scheduled",
                AchiPlannerEvent.event_type == "task_block",
                AchiPlannerEvent.related_task_id.is_not(None),
            )
        )).scalars())
        statement = select(AchiTask).where(
            AchiTask.is_deleted.is_(False),
            AchiTask.status.not_in(_TERMINAL_TASK_STATUSES),
        )
        if not self._can_manage(actor):
            statement = statement.where(AchiTask.assigned_to_user_id == str(actor.id))
        tasks = (await self.session.execute(
            statement.order_by(AchiTask.due_at.is_(None), AchiTask.due_at, AchiTask.created_at.desc()).limit(100)
        )).scalars().all()
        return PlannerTaskListOut(items=[
            PlannerTaskOut(
                id=task.id, task_number=task.task_number, title=task.title,
                priority=task.priority, task_type=task.task_type, status=task.status,
                assigned_to_name=task.assigned_to_name, due_at=task.due_at,
                scheduled_block_count=scheduled_block_counts[task.id],
            )
            for task in tasks
        ])

    async def schedule_task_block(self, actor_id: str, data: PlannerTaskBlockCreateIn) -> PlannerEventOut:
        actor = await self._actor(actor_id)
        if not self._can_write(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has read-only Planner access")
        # Reuse the existing Team Task visibility rules before creating only a
        # linked time block. No task field, number, or workflow state is edited.
        task = await TaskService(self.session).get_task(actor_id, data.task_id)
        if task.status in _TERMINAL_TASK_STATUSES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Completed or cancelled tasks cannot be scheduled")
        event = AchiPlannerEvent(
            title=f"{task.task_number} — {task.title}", description=task.description,
            event_type="task_block", start_at=data.start_at, end_at=data.end_at,
            timezone=data.timezone, organizer_user_id=str(actor.id),
            organizer_name=_display_name(actor), created_by_user_id=str(actor.id),
            related_task_id=task.id, related_record_label=task.task_number,
        )
        self.session.add(event)
        await self.session.commit()
        await self.session.refresh(event)
        return await self._out(event, str(actor.id))

    async def _attendees(self, event_id: str) -> list[PlannerAttendeeOut]:
        rows = (await self.session.execute(
            select(AchiPlannerEventAttendee)
            .where(AchiPlannerEventAttendee.event_id == event_id)
            .order_by(AchiPlannerEventAttendee.role, AchiPlannerEventAttendee.display_name)
        )).scalars().all()
        return [PlannerAttendeeOut(
            id=row.id, user_id=row.attendee_user_id, display_name=row.display_name,
            external_email=row.external_email, role=row.role, response_status=row.response_status,
        ) for row in rows]

    async def _attendee_rows(self, event_id: str, attendees: list[PlannerAttendeeIn]) -> list[AchiPlannerEventAttendee]:
        internal_ids = {row.user_id for row in attendees if row.user_id}
        if len(internal_ids) != len([row for row in attendees if row.user_id]):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each internal attendee may appear once")
        emails = [row.external_email.lower() for row in attendees if row.external_email]
        if len(set(emails)) != len(emails):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each external email may appear once")
        users: dict[str, User] = {}
        if internal_ids:
            parsed_ids = []
            for user_id in internal_ids:
                try:
                    parsed_ids.append(uuid.UUID(user_id))
                except ValueError:
                    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "attendee user_id must be valid") from None
            found = (await self.session.execute(
                select(User).where(User.id.in_(parsed_ids), User.is_active.is_(True))
            )).scalars().all()
            users = {str(user.id): user for user in found}
            if users.keys() != internal_ids:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "An attendee is not an active ACHI user")
        return [AchiPlannerEventAttendee(
            event_id=event_id, attendee_user_id=row.user_id,
            display_name=(_display_name(users[row.user_id]) if row.user_id else row.external_name or row.external_email or ""),
            external_email=(row.external_email.lower() if row.external_email else None), role=row.role,
        ) for row in attendees]

    async def _out(
        self, event: AchiPlannerEvent, actor_id: str, *, start_at: datetime | None = None,
        end_at: datetime | None = None,
    ) -> PlannerEventOut:
        shown_start = start_at or event.start_at
        shown_end = end_at or event.end_at
        instance_key = f"{event.id}:{shown_start.isoformat()}" if event.recurrence_rule else event.id
        reminder_minutes = list((await self.session.execute(
            select(AchiPlannerReminder.minutes_before)
            .where(AchiPlannerReminder.event_id == event.id)
            .order_by(AchiPlannerReminder.minutes_before.desc())
        )).scalars())
        # Availability remains visible, but a private item's details stay private.
        if event.visibility == "private" and event.organizer_user_id != actor_id:
            return PlannerEventOut(
                id=event.id, title="Busy", description="", event_type="appointment",
                status=event.status, visibility="private", start_at=shown_start,
                end_at=shown_end, all_day=event.all_day, timezone=event.timezone,
                location="", meeting_url="", organizer_user_id=event.organizer_user_id,
                organizer_name="", created_by_user_id=event.created_by_user_id,
                related_task_id=None, related_record_type=None, related_record_id=None,
                related_record_label="", recurrence_rule=None, recurrence_end_at=None,
                reminder_minutes=[], attendees=[], instance_key=instance_key,
                created_at=event.created_at, updated_at=event.updated_at,
            )
        return PlannerEventOut(
            id=event.id, title=event.title, description=event.description,
            event_type=event.event_type, status=event.status, visibility=event.visibility,
            start_at=shown_start, end_at=shown_end, all_day=event.all_day,
            timezone=event.timezone, location=event.location, meeting_url=event.meeting_url,
            reminder_minutes=reminder_minutes, attendees=await self._attendees(event.id),
            organizer_user_id=event.organizer_user_id, organizer_name=event.organizer_name,
            created_by_user_id=event.created_by_user_id, related_task_id=event.related_task_id,
            related_record_type=event.related_record_type, related_record_id=event.related_record_id,
            related_record_label=event.related_record_label, recurrence_rule=event.recurrence_rule,
            recurrence_end_at=event.recurrence_end_at, instance_key=instance_key, created_at=event.created_at,
            updated_at=event.updated_at,
        )

    async def create_event(self, actor_id: str, data: PlannerEventCreateIn) -> PlannerEventOut:
        actor = await self._actor(actor_id)
        if not self._can_write(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has read-only Planner access")
        event = AchiPlannerEvent(
            title=data.title, description=data.description, event_type=data.event_type,
            start_at=data.start_at, end_at=data.end_at, all_day=data.all_day,
            timezone=data.timezone, location=data.location, meeting_url=data.meeting_url,
            visibility=data.visibility, organizer_user_id=str(actor.id),
            organizer_name=_display_name(actor), created_by_user_id=str(actor.id),
            related_task_id=data.related_task_id, related_record_type=data.related_record_type,
            related_record_id=data.related_record_id, related_record_label=data.related_record_label,
            recurrence_rule=data.recurrence_rule, recurrence_end_at=data.recurrence_end_at,
        )
        _recurrence_parts(event.recurrence_rule)
        await self._validate_related_record(event.related_record_type, event.related_record_id)
        self.session.add(event)
        await self.session.flush()
        self.session.add_all([
            AchiPlannerReminder(event_id=event.id, minutes_before=minutes)
            for minutes in data.reminder_minutes
        ])
        self.session.add_all(await self._attendee_rows(event.id, data.attendees))
        await self.session.commit()
        await self.session.refresh(event)
        return await self._out(event, str(actor.id))

    async def update_event(self, actor_id: str, event_id: str, data: PlannerEventUpdateIn) -> PlannerEventOut:
        actor = await self._actor(actor_id)
        if not self._can_write(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has read-only Planner access")
        event = await self._event(event_id, lock=True)
        if event.organizer_user_id != str(actor.id) and not self._can_manage(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the organizer or a supervisor can edit this event")
        changes = data.model_dump(exclude_unset=True)
        reminder_minutes = changes.pop("reminder_minutes", None)
        attendees = changes.pop("attendees", None)
        for key, value in changes.items():
            setattr(event, key, value)
        if event.end_at <= event.start_at:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end_at must be after start_at")
        if event.recurrence_end_at is not None and event.recurrence_end_at < event.start_at:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "recurrence_end_at must not be before start_at")
        _recurrence_parts(event.recurrence_rule)
        await self._validate_related_record(event.related_record_type, event.related_record_id)
        if (event.related_record_type is None) != (event.related_record_id is None):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "related record type and id must be provided together")
        if reminder_minutes is not None:
            await self.session.execute(
                delete(AchiPlannerReminder).where(AchiPlannerReminder.event_id == event.id)
            )
            self.session.add_all([
                AchiPlannerReminder(event_id=event.id, minutes_before=minutes)
                for minutes in reminder_minutes
            ])
        if attendees is not None:
            await self.session.execute(
                delete(AchiPlannerEventAttendee).where(AchiPlannerEventAttendee.event_id == event.id)
            )
            self.session.add_all(await self._attendee_rows(event.id, attendees))
        await self.session.commit()
        await self.session.refresh(event)
        return await self._out(event, str(actor.id))

    async def rsvp(self, actor_id: str, event_id: str, data: PlannerRsvpIn) -> PlannerEventOut:
        actor = await self._actor(actor_id)
        event = await self._event(event_id, lock=True)
        attendee = (await self.session.execute(
            select(AchiPlannerEventAttendee).where(
                AchiPlannerEventAttendee.event_id == event.id,
                AchiPlannerEventAttendee.attendee_user_id == str(actor.id),
            )
        )).scalar_one_or_none()
        if attendee is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an invited ACHI user can respond")
        attendee.response_status = data.response_status
        await self.session.commit()
        await self.session.refresh(event)
        return await self._out(event, str(actor.id))

    async def conflicts(self, actor_id: str, user_ids: list[str], start: datetime, end: datetime, exclude_event_id: str | None) -> list[PlannerConflictOut]:
        actor = await self._actor(actor_id)
        if end <= start:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "end must be after start")
        wanted = set(user_ids)
        events = (await self.session.execute(
            select(AchiPlannerEvent).where(
                AchiPlannerEvent.deleted_at.is_(None), AchiPlannerEvent.status == "scheduled",
                AchiPlannerEvent.start_at < end, AchiPlannerEvent.end_at > start,
            )
        )).scalars().all()
        if exclude_event_id:
            events = [event for event in events if event.id != exclude_event_id]
        event_ids = [event.id for event in events]
        attendees = (await self.session.execute(
            select(AchiPlannerEventAttendee).where(AchiPlannerEventAttendee.event_id.in_(event_ids))
        )).scalars().all() if event_ids else []
        by_event: dict[str, set[str]] = {event.id: {event.organizer_user_id} for event in events}
        for attendee in attendees:
            if attendee.attendee_user_id:
                by_event.setdefault(attendee.event_id, set()).add(attendee.attendee_user_id)
        try:
            wanted_uuids = [uuid.UUID(value) for value in wanted]
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "user_ids must contain valid UUIDs") from None
        users = (await self.session.execute(select(User).where(User.id.in_(wanted_uuids)))).scalars().all()
        names = {str(user.id): _display_name(user) for user in users}
        output: list[PlannerConflictOut] = []
        for event in events:
            for user_id in by_event.get(event.id, set()) & wanted:
                output.append(PlannerConflictOut(
                    user_id=user_id, display_name=names.get(user_id, "User"),
                    start_at=event.start_at, end_at=event.end_at,
                    title=("Busy" if event.visibility == "private" and user_id != str(actor.id) else event.title),
                ))
        return output

    async def delete_event(self, actor_id: str, event_id: str) -> None:
        actor = await self._actor(actor_id)
        if not self._can_write(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has read-only Planner access")
        event = await self._event(event_id, lock=True)
        if event.organizer_user_id != str(actor.id) and not self._can_manage(actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the organizer or a supervisor can delete this event")
        event.deleted_at = _now()
        event.deleted_by_user_id = str(actor.id)
        await self.session.commit()

    async def _event(self, event_id: str, *, lock: bool = False) -> AchiPlannerEvent:
        statement = select(AchiPlannerEvent).where(
            AchiPlannerEvent.id == event_id,
            AchiPlannerEvent.deleted_at.is_(None),
        )
        if lock:
            statement = statement.with_for_update()
        event = (await self.session.execute(statement)).scalar_one_or_none()
        if event is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Planner event not found")
        return event
