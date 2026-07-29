"""Team Chat — a shared message/issue stream for the ACHI pages.

Unlike the comment panel's per-browser Comments tab, these messages live
server-side, so every teammate sees the same thread. A message can be flagged as
an issue and later resolved; the client (ui/comment.js, the "Team Chat" tab)
filters on that to drive the "filter issues and solve them" workflow.

Mounted under /api/v1/achi/ by router.py, so a limited (ACHI-only) user reaches
it and it rides the same bearer token the pages already hold — no second login.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.dependencies import CurrentUserId, SessionDep
from app.modules.users.models import User

from .models import AchiChatMessage
from .schemas import ChatMessageIn, ChatMessageOut, ChatMessagePatch

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


@chat_router.get("/chat", response_model=list[ChatMessageOut], summary="Team chat + issues, oldest first")
async def list_chat(session: SessionDep, _user_id: CurrentUserId) -> list[ChatMessageOut]:
    rows = (await session.execute(
        select(AchiChatMessage).order_by(AchiChatMessage.created_at)
    )).scalars().all()
    return [ChatMessageOut.model_validate(r) for r in rows]


@chat_router.post("/chat", response_model=ChatMessageOut,
                  status_code=status.HTTP_201_CREATED, summary="Post a message (optionally an issue)")
async def post_chat(data: ChatMessageIn, session: SessionDep, user_id: CurrentUserId) -> ChatMessageOut:
    row = AchiChatMessage(
        author_user_id=user_id,
        author_name=await _author_name(session, user_id),
        text=data.text,
        is_issue=1 if data.is_issue else 0,
        resolved=0,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    logger.info("achi: chat message posted (issue=%s) by %s", bool(data.is_issue), user_id)
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
