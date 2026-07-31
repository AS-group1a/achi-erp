"""Team Chat — a shared message stream for the ACHI pages, with DMs + @mentions.

These messages live server-side, so every teammate sees the same team thread. A
message with no ``recipient_user_id`` is team-wide (public); one with a recipient
is a private DM, and list_chat only ever returns the DMs the caller is a party to
— privacy is enforced on the server, never on the client. ``mentions`` carries
the user ids tagged in the text so the client can highlight "you were mentioned".
The older issue/resolve workflow has been removed from the UI (the columns
remain for old rows). ``GET /members`` backs the @mention and DM pickers.

Mounted under /api/v1/achi/ by router.py, so a limited (ACHI-only) user reaches
it and it rides the same bearer token the pages already hold — no second login.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import or_, select

from app.dependencies import CurrentUserId, SessionDep
from app.modules.users.models import User

from .models import AchiChatMessage
from .schemas import ChatMemberOut, ChatMessageIn, ChatMessageOut, ChatMessagePatch

chat_router = APIRouter()
logger = logging.getLogger(__name__)


async def _author_name(session, user_id: str | None) -> str:
    """The display name stamped onto a message. Read once at post time and stored
    on the row, so the thread does not change if the user is later renamed."""
    if not user_id:
        return "Someone"
    u = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not u:
        return "Someone"
    return (u.full_name or "").strip() or (u.email.split("@")[0] if u.email else "Someone")


@chat_router.get("/members", response_model=list[ChatMemberOut],
                 summary="Teammates you can @mention or DM (id + name only)")
async def list_members(session: SessionDep, _user_id: CurrentUserId) -> list[ChatMemberOut]:
    # Any authenticated ACHI user may read this — it exposes only id + display
    # name, never email/role/PII — so it does NOT need the admin-only
    # users.list permission that gates GET /api/v1/users/.
    users = (await session.execute(
        select(User).where(User.is_active.is_(True)).order_by(User.full_name)
    )).scalars().all()
    out: list[ChatMemberOut] = []
    for u in users:
        name = (u.full_name or "").strip() or (u.email.split("@")[0] if u.email else "Someone")
        out.append(ChatMemberOut(id=str(u.id), name=name))
    return out


@chat_router.get("/chat", response_model=list[ChatMessageOut], summary="Team messages + your DMs, oldest first")
async def list_chat(session: SessionDep, user_id: CurrentUserId) -> list[ChatMessageOut]:
    # Privacy is enforced HERE, not on the client: return team-wide messages
    # (no recipient) plus only the DMs this user is a party to. A DM between two
    # other people is never sent to anyone else.
    rows = (await session.execute(
        select(AchiChatMessage).where(
            or_(
                AchiChatMessage.recipient_user_id.is_(None),
                AchiChatMessage.author_user_id == user_id,
                AchiChatMessage.recipient_user_id == user_id,
            )
        ).order_by(AchiChatMessage.created_at)
    )).scalars().all()
    return [ChatMessageOut.model_validate(r) for r in rows]


@chat_router.post("/chat", response_model=ChatMessageOut,
                  status_code=status.HTTP_201_CREATED, summary="Post a team message or a private DM")
async def post_chat(data: ChatMessageIn, session: SessionDep, user_id: CurrentUserId) -> ChatMessageOut:
    recipient_name = ""
    if data.recipient_user_id:
        recipient_name = await _author_name(session, data.recipient_user_id)
    row = AchiChatMessage(
        author_user_id=user_id,
        author_name=await _author_name(session, user_id),
        text=data.text,
        recipient_user_id=data.recipient_user_id or None,
        recipient_name=recipient_name,
        mentions=json.dumps([str(m) for m in (data.mentions or [])]),
        is_issue=0,
        resolved=0,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    logger.info("achi: chat message posted (dm=%s) by %s", bool(data.recipient_user_id), user_id)
    return ChatMessageOut.model_validate(row)


@chat_router.patch("/chat/{message_id}", response_model=ChatMessageOut, summary="Resolve or reopen an issue")
async def patch_chat(message_id: str, data: ChatMessagePatch,
                     session: SessionDep, _user_id: CurrentUserId) -> ChatMessageOut:
    row = (await session.execute(
        select(AchiChatMessage).where(AchiChatMessage.id == message_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    # Anyone on the team may resolve/reopen — solving issues is a shared job.
    row.resolved = 1 if data.resolved else 0
    await session.commit()
    await session.refresh(row)
    return ChatMessageOut.model_validate(row)


@chat_router.delete("/chat/{message_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete your own message")
async def delete_chat(message_id: str, session: SessionDep, user_id: CurrentUserId) -> None:
    row = (await session.execute(
        select(AchiChatMessage).where(AchiChatMessage.id == message_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")
    # Only the author can delete their own message, so nobody can wipe another
    # person's report. (Legacy rows with no author fall through and are deletable.)
    if row.author_user_id and row.author_user_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own messages")
    await session.delete(row)
    await session.commit()
