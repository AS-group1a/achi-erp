"""Page comments — the shared, server-backed version of the panel's Comments tab.

Was per-browser localStorage; now every teammate sees the same threads, exactly
like the Team Chat. A comment carries the page it was left on (``where``); a
reply is a comment with ``parent_id`` set (one level only). Mounted under
/api/v1/achi/, so it rides the bearer token the pages already hold.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.dependencies import CurrentUserId, SessionDep
from app.modules.users.models import User

from .models import AchiPageComment
from .schemas import CommentIn, CommentOut, CommentPatch, CommentReplyOut

comment_router = APIRouter()
logger = logging.getLogger(__name__)


async def _author_name(session, user_id: str | None) -> str:
    if not user_id:
        return "Someone"
    u = (await session.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not u:
        return "Someone"
    return (u.full_name or "").strip() or (u.email.split("@")[0] if u.email else "Someone")


@comment_router.get("/comments", response_model=list[CommentOut], summary="Page comments with their replies")
async def list_comments(session: SessionDep, _user_id: CurrentUserId) -> list[CommentOut]:
    # One query, then group replies under their parent in Python — cheaper and
    # clearer than a self-referential eager load for a one-level thread.
    rows = (await session.execute(
        select(AchiPageComment).order_by(AchiPageComment.created_at)
    )).scalars().all()
    replies: dict[str, list[AchiPageComment]] = {}
    tops: list[AchiPageComment] = []
    for r in rows:
        if r.parent_id:
            replies.setdefault(r.parent_id, []).append(r)
        else:
            tops.append(r)
    out: list[CommentOut] = []
    for t in tops:
        co = CommentOut.model_validate(t)
        co.replies = [CommentReplyOut.model_validate(x) for x in replies.get(t.id, [])]
        out.append(co)
    return out


@comment_router.post("/comments", response_model=CommentOut,
                     status_code=status.HTTP_201_CREATED, summary="Post a comment or a reply")
async def post_comment(data: CommentIn, session: SessionDep, user_id: CurrentUserId) -> CommentOut:
    if data.parent_id:
        parent = (await session.execute(
            select(AchiPageComment).where(AchiPageComment.id == data.parent_id)
        )).scalar_one_or_none()
        if not parent or parent.parent_id:      # missing, or a reply — no reply-to-reply
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Parent comment not found")
    row = AchiPageComment(
        parent_id=data.parent_id,
        author_user_id=user_id,
        author_name=await _author_name(session, user_id),
        where=(data.where or "")[:128],
        text=data.text,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return CommentOut.model_validate(row)


@comment_router.patch("/comments/{comment_id}", response_model=CommentOut,
                      summary="Set a comment's status, or claim/release it")
async def patch_comment(comment_id: str, data: CommentPatch,
                        session: SessionDep, user_id: CurrentUserId) -> CommentOut:
    row = (await session.execute(
        select(AchiPageComment).where(AchiPageComment.id == comment_id)
    )).scalar_one_or_none()
    if not row or row.parent_id:            # missing, or a reply — the workflow is on top-level comments only
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if data.status is not None:
        row.status = data.status
    if data.assigned is not None:
        if data.assigned:
            row.assigned_to_user_id = user_id
            row.assigned_to_name = await _author_name(session, user_id)
        else:
            row.assigned_to_user_id = None
            row.assigned_to_name = ""
    await session.commit()
    await session.refresh(row)
    # Re-attach this comment's replies so the response matches list_comments; the
    # relationship is assembled in Python (there is no ORM relationship on the row).
    replies = (await session.execute(
        select(AchiPageComment)
        .where(AchiPageComment.parent_id == row.id)
        .order_by(AchiPageComment.created_at)
    )).scalars().all()
    out = CommentOut.model_validate(row)
    out.replies = [CommentReplyOut.model_validate(x) for x in replies]
    return out


@comment_router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT,
                       summary="Delete your own comment (replies cascade)")
async def delete_comment(comment_id: str, session: SessionDep, user_id: CurrentUserId) -> None:
    row = (await session.execute(
        select(AchiPageComment).where(AchiPageComment.id == comment_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if row.author_user_id and row.author_user_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own comments")
    await session.delete(row)          # FK ON DELETE CASCADE removes its replies
    await session.commit()
