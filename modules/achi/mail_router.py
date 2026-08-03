"""Outbound email for the ACHI pages — the compose popup's "Send" button.

The Log page lets you compose a message to a contact and hit Send. That Send
posts here; we deliver the mail through the app's own pluggable email layer
(``app.core.email`` — the very service the password-reset flow uses) and record
the message in ``achi_email`` so it can be viewed and managed inside the site
instead of vanishing into a ``mailto:`` handoff to whatever desktop client the
user happens to have.

Delivery honours the deployment's ``email_backend`` setting: with SMTP
configured the mail goes out for real; on the default ``console`` backend the
server only logs it. Either way the send never raises (EmailService returns a
DeliveryResult), so a mis-configured mail server degrades to a recorded
"couldn't deliver" rather than a 500 in the user's face — and the recorded
``backend``/``status`` tells the honest story of what happened.

Mounted under /api/v1/achi/ by router.py, so a limited (ACHI-only) user reaches
it on the same bearer token the pages already hold — no second login.
"""

from __future__ import annotations

import html
import logging

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import or_, select

from app.core.email import EmailMessage, get_email_service
from app.dependencies import CurrentUserId, SessionDep
from app.modules.users.models import User

from .models import AchiEmail
from .schemas import EmailOut, EmailSendIn

mail_router = APIRouter()
logger = logging.getLogger(__name__)


async def _sender(session, user_id: str | None) -> tuple[str, str | None]:
    """(display name, email) for the signed-in sender, read once at send time.
    The name is stamped onto the row so the record still reads right after a
    rename; the email becomes the Reply-To so replies reach the actual person
    even though the mail goes out as the company From address."""
    if not user_id:
        return "Someone", None
    u = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not u:
        return "Someone", None
    name = (u.full_name or "").strip() or (u.email.split("@")[0] if u.email else "Someone")
    return name, (u.email or None)


def _html_body(subject: str, text: str, sender_name: str) -> str:
    """Turn the plain-text the user typed into a minimal, safe HTML body.

    Everything is HTML-escaped first (the message is user input and must never be
    able to inject markup), then newlines become <br> so the layout the sender
    typed survives. Kept deliberately plain — no branding chrome — because this is
    a person-to-person message, not a system notification."""
    safe = html.escape(text or "").replace("\r\n", "\n").replace("\n", "<br>")
    who = html.escape(sender_name or "")
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
        'line-height:1.5;color:#1f2937">'
        f"{safe or '<em>(no message)</em>'}"
        f'<div style="margin-top:18px;color:#6b7280;font-size:12px">Sent by {who} '
        "via Achi Scaffolding</div>"
        "</div>"
    )


@mail_router.post("/mail/send", response_model=EmailOut,
                  status_code=status.HTTP_201_CREATED, summary="Send an email and record it in the site")
async def send_mail(data: EmailSendIn, session: SessionDep, user_id: CurrentUserId) -> EmailOut:
    sender_name, sender_email = await _sender(session, user_id)
    to_addr = str(data.to)
    subject = (data.subject or "").strip() or "(no subject)"

    message = EmailMessage(
        to=to_addr,
        subject=subject,
        html_body=_html_body(subject, data.body, sender_name),
        # From stays the company address (smtp_from); replies go to the person
        # who actually wrote the message.
        reply_to=sender_email,
        tags=["achi", "log-compose"],
    )

    # EmailService.send never raises — it returns a DeliveryResult we record. A
    # failed delivery is still stored (status="failed") so the send is not lost
    # and the failure is visible rather than swallowed.
    result = await get_email_service().send(message)

    row = AchiEmail(
        sender_user_id=user_id,
        sender_name=sender_name,
        to_email=to_addr,
        subject=subject,
        body=data.body or "",
        log_id=data.log_id or None,
        file_id=data.file_id or None,
        contact_id=data.contact_id or None,
        status="sent" if result.ok else "failed",
        backend=result.backend or "",
        error="" if result.ok else (result.reason or "delivery failed"),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    logger.info("achi: email to %s by %s — ok=%s backend=%s", to_addr, user_id, result.ok, result.backend)

    # A delivery failure is reported to the caller as an error (the record is
    # already saved), so the compose popup can tell the user it didn't go out.
    if not result.ok:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Saved, but the mail server didn't accept it: {result.reason or 'delivery failed'}",
        )
    return EmailOut.model_validate(row)


@mail_router.get("/mail", response_model=list[EmailOut], summary="Sent emails, newest first")
async def list_mail(session: SessionDep, _user_id: CurrentUserId,
                    q: str | None = Query(default=None, max_length=200),
                    limit: int = Query(default=100, ge=1, le=500)) -> list[EmailOut]:
    stmt = select(AchiEmail).order_by(AchiEmail.created_at.desc()).limit(limit)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(
            AchiEmail.to_email.ilike(like),
            AchiEmail.subject.ilike(like),
            AchiEmail.body.ilike(like),
        ))
    rows = (await session.execute(stmt)).scalars().all()
    return [EmailOut.model_validate(r) for r in rows]


@mail_router.get("/mail/{email_id}", response_model=EmailOut, summary="Read one sent email")
async def get_mail(email_id: str, session: SessionDep, _user_id: CurrentUserId) -> EmailOut:
    row = (await session.execute(
        select(AchiEmail).where(AchiEmail.id == email_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Email not found")
    return EmailOut.model_validate(row)


@mail_router.delete("/mail/{email_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete your own sent email")
async def delete_mail(email_id: str, session: SessionDep, user_id: CurrentUserId) -> None:
    row = (await session.execute(
        select(AchiEmail).where(AchiEmail.id == email_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Email not found")
    # Only the sender can delete their own record (legacy rows with no sender
    # fall through and are deletable), mirroring the chat delete rule.
    if row.sender_user_id and row.sender_user_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own emails")
    await session.delete(row)
    await session.commit()
