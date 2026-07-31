"""Page comments — the shared, server-backed version of the panel's Comments tab.

Was per-browser localStorage; now every teammate sees the same threads, exactly
like the Team Chat. A comment carries the page it was left on (``where``); a
reply is a comment with ``parent_id`` set (one level only). A comment can also
carry image/video attachments (bytes in app.core.storage, mirrored on the Log
page's LogAttachment). Mounted under /api/v1/achi/, so it rides the bearer token
the pages already hold.
"""

from __future__ import annotations

import logging
import re
import uuid
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select

from app.core.storage import get_storage_backend
from app.dependencies import CurrentUserId, SessionDep, SettingsDep
from app.modules.users.models import User

from .models import AchiCommentAttachment, AchiPageComment
from .schemas import CommentAttachmentOut, CommentIn, CommentOut, CommentPatch, CommentReplyOut

comment_router = APIRouter()
logger = logging.getLogger(__name__)

# Images and short clips only. 50 MB covers phone photos and brief videos while
# a mis-drop can't fill the disk. Enforced on real bytes read, streamed in 1 MB
# chunks so an oversized upload is rejected without being buffered whole.
_MAX_COMMENT_ATTACHMENT_BYTES = 50 * 1024 * 1024
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(name: str) -> str:
    """A storage-key-safe tail. The key already carries a UUID dir, so this only
    has to be inert; the display name the user sees comes from the row."""
    cleaned = _UNSAFE_NAME.sub("_", (name or "").strip()).strip("._") or "file"
    return cleaned[:120]


def _require_valid_token(request: Request, settings) -> None:
    """Accept the JWT from the bearer header OR a ``?token=`` query param (so the
    same URL works as an <img>/<video> src or in a new tab), else 401. Same
    approach as the Log page's attachment download."""
    from app.dependencies import decode_access_token

    token = request.query_params.get("token") or ""
    if not token:
        auth = request.headers.get("authorization", "")
        if auth[:7].lower() == "bearer ":
            token = auth[7:]
    try:
        decode_access_token(token, settings)
    except Exception as e:  # noqa: BLE001 - any decode failure = unauthenticated
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated") from e


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


@comment_router.post("/comments/{comment_id}/attachments", response_model=CommentAttachmentOut,
                     status_code=status.HTTP_201_CREATED, summary="Attach an image or video to a comment")
async def add_comment_attachment(comment_id: str, session: SessionDep, user_id: CurrentUserId,
                                 file: UploadFile = File(...)) -> CommentAttachmentOut:
    comment = (await session.execute(
        select(AchiPageComment).where(AchiPageComment.id == comment_id)
    )).scalar_one_or_none()
    if not comment:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    # Only the comment's author may attach to it (a comment is created, then its
    # media uploaded, by the same person). Legacy authorless rows fall through.
    if comment.author_user_id and comment.author_user_id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only attach to your own comments")

    ctype = (file.content_type or "").lower()
    if not (ctype.startswith("image/") or ctype.startswith("video/")):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Only images and videos are allowed")

    # Read in 1 MB chunks, aborting the moment the cap is exceeded, so an oversized
    # upload never gets buffered whole in memory.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_COMMENT_ATTACHMENT_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE,
                                f"File is larger than {_MAX_COMMENT_ATTACHMENT_BYTES // (1024 * 1024)} MB")
        chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")

    att = AchiCommentAttachment(
        id=str(uuid.uuid4()),
        comment_id=comment.id,
        filename=file.filename or "file",
        content_type=ctype or "application/octet-stream",
        size_bytes=len(content),
        storage_key="",
        uploaded_by=user_id,
    )
    # Storage first: an orphaned blob is invisible, whereas a row pointing at a key
    # that was never written is a broken link the user sees.
    att.storage_key = f"achi/comments/{comment.id}/{att.id}/{_safe_name(att.filename)}"
    await get_storage_backend().put(att.storage_key, content)
    session.add(att)
    await session.commit()
    await session.refresh(att)
    return CommentAttachmentOut.model_validate(att)


@comment_router.get("/comments/attachments/{attachment_id}/download", include_in_schema=False,
                    summary="Serve a comment's attached image/video")
async def download_comment_attachment(attachment_id: str, request: Request,
                                      session: SessionDep, settings: SettingsDep) -> Response:
    # Token via header OR ?token= so the same URL works as an <img>/<video> src.
    _require_valid_token(request, settings)
    att = await session.get(AchiCommentAttachment, attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    try:
        content = await get_storage_backend().get(att.storage_key)
    except FileNotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment bytes are missing") from e
    return Response(
        content,
        media_type=att.content_type,
        # inline so the browser shows the image/plays the video; RFC 5987 encoding
        # keeps user-supplied names out of the header syntax.
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(att.filename, safe='')}"},
    )


@comment_router.delete("/comments/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT,
                       summary="Remove an attachment you uploaded")
async def delete_comment_attachment(attachment_id: str, session: SessionDep, user_id: CurrentUserId) -> None:
    att = await session.get(AchiCommentAttachment, attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    if att.uploaded_by and att.uploaded_by != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only remove your own attachments")
    key = att.storage_key
    await session.delete(att)
    await session.commit()
    try:
        await get_storage_backend().delete(key)
    except Exception:  # noqa: BLE001 - a missing blob must not fail the row delete
        logger.warning("achi: comment attachment blob delete failed for %s", key, exc_info=True)


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
