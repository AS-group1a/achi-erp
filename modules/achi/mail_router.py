"""Outbound email for the ACHI pages — the Log page's compose popup.

Every user can just write and Send: the message goes out through ONE shared
company mailbox (configured once via the app's email settings — the same
app.core.email service password-resets use), so no one has to connect an account
or fiddle with app passwords. The From shows the sender's name on the company
address and Reply-To is set to the sender, so replies reach the real person.

Delivery honours the deployment's ``email_backend`` setting: with SMTP configured
the mail goes out for real; on the default ``console`` backend the server only
logs it (and the recorded ``backend`` says so). Either way every send is stored
in ``achi_email`` so it can be viewed and managed inside the site.

Mounted under /api/v1/achi/ by router.py, so a limited (ACHI-only) user reaches
it on the same bearer token the pages already hold — no second login.
"""

from __future__ import annotations

import html
import logging
import re
from email.utils import formataddr

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import or_, select

from app.core.email import EmailAttachment, EmailMessage, get_email_service
from app.dependencies import CurrentUserId, SessionDep, SettingsDep
from app.modules.users.models import User

from .models import AchiEmail
from .schemas import EmailOut

mail_router = APIRouter()
logger = logging.getLogger(__name__)

# Total attachment cap. 25 MB is not our number — it is the hard ceiling Gmail
# (and most providers) enforce on a whole message, so raising it just makes the
# provider bounce the email. This is the maximum that can actually be delivered.
_MAX_ATTACH_TOTAL = 25 * 1024 * 1024
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


async def _sender(session, user_id: str | None) -> tuple[str, str | None]:
    """(display name, email) for the signed-in sender, read once at send time.
    The name is stamped onto the record; the email becomes Reply-To so replies
    reach the actual person even though the mail goes out as the company."""
    if not user_id:
        return "Someone", None
    u = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not u:
        return "Someone", None
    name = (u.full_name or "").strip() or (u.email.split("@")[0] if u.email else "Someone")
    return name, (u.email or None)


def _html_to_text(fragment: str) -> str:
    """Plain-text alternative for the multipart email: drop tags, keep the words."""
    text = re.sub(r"(?is)<(br|/p|/div|/li)\s*/?>", "\n", fragment or "")
    text = re.sub(r"(?is)<[^>]+>", "", text)
    return html.unescape(text).strip()


def _wrap_html(fragment: str, sender_name: str) -> str:
    """Wrap the Quill body fragment in a readable shell with a small sign-off."""
    who = html.escape(sender_name or "")
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
        'line-height:1.5;color:#1f2937">'
        f"{fragment or ''}"
        f'<div style="margin-top:18px;color:#6b7280;font-size:12px">Sent by {who} '
        "via Achi Scaffolding</div></div>"
    )


@mail_router.post("/mail/send", response_model=EmailOut, status_code=status.HTTP_201_CREATED,
                  summary="Send an email through the shared company mailbox and record it")
async def send_mail(
    session: SessionDep,
    settings: SettingsDep,
    user_id: CurrentUserId,
    to: str = Form(...),
    subject: str = Form(""),
    body: str = Form(""),
    log_id: str | None = Form(None),
    file_id: str | None = Form(None),
    contact_id: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
) -> EmailOut:
    to_addr = (to or "").strip()
    if not _EMAIL_RE.match(to_addr):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Enter a valid recipient email address.")
    subject = (subject or "").strip() or "(no subject)"

    # Read attachments, enforcing a total-size cap.
    attachments: list[EmailAttachment] = []
    names: list[str] = []
    total = 0
    for f in files or []:
        content = await f.read()
        total += len(content)
        if total > _MAX_ATTACH_TOTAL:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                "Attachments are too large — email allows about 25 MB per message (the mail "
                "provider's limit). For bigger files, share a download link in the message instead.",
            )
        attachments.append(EmailAttachment(
            filename=f.filename or "attachment", content=content,
            content_type=f.content_type or "application/octet-stream"))
        names.append(f.filename or "attachment")

    sender_name, sender_email = await _sender(session, user_id)
    # From = company address with the sender's name; replies go back to them.
    from_addr = formataddr((sender_name, settings.smtp_from)) if settings.smtp_from else None

    message = EmailMessage(
        to=to_addr,
        subject=subject,
        html_body=_wrap_html(body, sender_name),
        from_addr=from_addr,
        reply_to=sender_email,
        tags=["achi", "log-compose"],
        attachments=attachments,
    )
    # EmailService.send never raises — it returns a DeliveryResult we record.
    result = await get_email_service().send(message)

    row = AchiEmail(
        sender_user_id=user_id, sender_name=sender_name, to_email=to_addr,
        subject=subject, body=body or "", log_id=log_id or None, file_id=file_id or None,
        contact_id=contact_id or None, status="sent" if result.ok else "failed",
        backend=result.backend or "", error="" if result.ok else (result.reason or "delivery failed"),
        attachment_count=len(names), attachment_names=", ".join(names),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    logger.info("achi: email to %s by %s — ok=%s backend=%s attach=%d",
                to_addr, user_id, result.ok, result.backend, len(names))

    if not result.ok:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            f"Saved, but the mail server didn't accept it: {result.reason or 'delivery failed'}")
    return EmailOut.model_validate(row)


# ── Reading the recorded mail ──────────────────────────────────────────────


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
    if row.sender_user_id and row.sender_user_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own emails")
    await session.delete(row)
    await session.commit()
