"""Durable SMTP reminder delivery for ACHI Planner.

Run this module as the dedicated ``planner-reminders`` compose service.  It is
disabled by default and deliberately sends nothing unless both
``PLANNER_REMINDER_DELIVERY_ENABLED=true`` and ``EMAIL_BACKEND=smtp`` are set.
The delivery table makes the loop safe to restart.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from email.utils import formataddr

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.email import EmailMessage, get_email_service
from app.modules.users.models import User

from .planner_models import AchiPlannerEvent, AchiPlannerEventAttendee, AchiPlannerReminder, AchiPlannerReminderDelivery
from .planner_service import PlannerService


logger = logging.getLogger(__name__)
_POLL_SECONDS = max(30, int(os.getenv("PLANNER_REMINDER_POLL_SECONDS", "60")))
_ENABLED = os.getenv("PLANNER_REMINDER_DELIVERY_ENABLED", "false").lower() == "true"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _recipients(session: AsyncSession, event: AchiPlannerEvent) -> set[str]:
    user_ids = {event.organizer_user_id}
    external: set[str] = set()
    for attendee in event.attendees:
        if attendee.attendee_user_id:
            user_ids.add(attendee.attendee_user_id)
        elif attendee.external_email:
            external.add(attendee.external_email.strip().lower())
    users = (await session.execute(select(User.email).where(User.id.in_(user_ids)))).scalars().all()
    return {email.strip().lower() for email in users if email and "@" in email} | external


async def _already_recorded(
    session: AsyncSession, event_id: str, occurrence_start: datetime, minutes_before: int, recipient: str
) -> bool:
    return (await session.execute(
        select(AchiPlannerReminderDelivery.id).where(
            AchiPlannerReminderDelivery.event_id == event_id,
            AchiPlannerReminderDelivery.occurrence_start == occurrence_start,
            AchiPlannerReminderDelivery.minutes_before == minutes_before,
            AchiPlannerReminderDelivery.recipient == recipient,
            AchiPlannerReminderDelivery.channel == "email",
        )
    )).scalar_one_or_none() is not None


async def _deliver_due(session: AsyncSession) -> int:
    if not _ENABLED or os.getenv("EMAIL_BACKEND", "console").lower() != "smtp":
        return 0
    now = _now()
    # A restarted worker may send a missed reminder up to 24 hours late, once,
    # rather than silently dropping it.  The unique delivery key prevents spam.
    earliest = now - timedelta(days=1)
    events = (await session.execute(
        select(AchiPlannerEvent)
        .where(
            AchiPlannerEvent.deleted_at.is_(None),
            AchiPlannerEvent.status == "scheduled",
            AchiPlannerEvent.start_at <= now + timedelta(days=366),
        )
    )).scalars().all()
    delivered = 0
    from_addr = os.getenv("SMTP_FROM", "").strip()
    for event in events:
        if not event.reminders:
            continue
        occurrences = PlannerService._occurrences(event, earliest, now + timedelta(days=1))
        recipients = await _recipients(session, event)
        for occurrence_start, _occurrence_end in occurrences:
            for reminder in event.reminders:
                due_at = occurrence_start - timedelta(minutes=reminder.minutes_before)
                if due_at > now or due_at < now - timedelta(days=1):
                    continue
                for recipient in recipients:
                    if await _already_recorded(session, event.id, occurrence_start, reminder.minutes_before, recipient):
                        continue
                    row = AchiPlannerReminderDelivery(
                        event_id=event.id,
                        occurrence_start=occurrence_start,
                        minutes_before=reminder.minutes_before,
                        recipient=recipient,
                        channel="email",
                        status="queued",
                        attempted_at=now,
                    )
                    session.add(row)
                    try:
                        await session.flush()
                    except IntegrityError:
                        await session.rollback()
                        continue
                    when = occurrence_start.astimezone().strftime("%a, %d %b %Y at %H:%M")
                    message = EmailMessage(
                        to=recipient,
                        subject=f"Reminder: {event.title}",
                        html_body=(
                            "<p>This is an ACHI Planner reminder.</p>"
                            f"<p><strong>{event.title}</strong><br>{when}</p>"
                            + (f"<p>{event.description}</p>" if event.description else "")
                        ),
                        from_addr=formataddr(("Achi Scaffolding Team", from_addr)) if from_addr else None,
                        reply_to=None,
                        tags=["achi", "planner-reminder"],
                    )
                    result = await get_email_service().send(message)
                    row.status = "sent" if result.ok else "failed"
                    row.error = "" if result.ok else (result.reason or "delivery failed")
                    row.attempted_at = _now()
                    await session.commit()
                    if result.ok:
                        delivered += 1
    return delivered


async def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required for Planner reminder delivery")
    engine = create_async_engine(database_url, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    if not _ENABLED:
        logger.warning("Planner reminder delivery is disabled; set PLANNER_REMINDER_DELIVERY_ENABLED=true to enable SMTP reminders")
    try:
        while True:
            try:
                async with sessions() as session:
                    count = await _deliver_due(session)
                    if count:
                        logger.info("Delivered %d Planner reminder email(s)", count)
            except Exception:
                logger.exception("Planner reminder delivery cycle failed")
            await asyncio.sleep(_POLL_SECONDS)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
