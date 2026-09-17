#!/usr/bin/env python3
"""Add GET /files/manager to modules/achi/router.py — the one-call endpoint the
Files page reads: every log attachment joined to its log and ContactFile
(business code, module, client, site), plus resolved uploader names.

Inserted directly ABOVE the /files/ui route, so it can never be swallowed by
GET /files/{file_id} (routes match top-down).

Run from the project root:

    .venv/bin/python add_files_api.py

Safe to re-run. Writes router.py.bak2 first, verifies the result compiles,
and syncs the venv copy of router.py if one exists.
"""
import pathlib
import py_compile
import shutil
import sys

ROOT = pathlib.Path.cwd()
P = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "modules/achi/router.py"
VENV_P = ROOT / ".venv/lib/python3.12/site-packages/app/modules/achi/router.py"

ANCHOR = '@router.get("/files/ui", response_class=HTMLResponse, include_in_schema=False)'

ENDPOINT = '''@router.get(
    "/files/manager",
    include_in_schema=False,
    summary="Everything the Files page needs in one call",
)
async def files_manager(
    session: SessionDep,
    _user_id: CurrentUserId,
    limit: int = Query(default=1000, ge=1, le=5000),
) -> dict:
    """Every attachment in the system, joined to its log and ContactFile so the
    Files page can render name/size/date/uploader plus the business code,
    module, client and site — one query, newest first. Soft-deleted logs are
    excluded so trashed entries take their files out of the manager too."""
    from .models import ContactFile, FileLog, LogAttachment

    rows = (
        await session.execute(
            select(LogAttachment, FileLog, ContactFile)
            .join(FileLog, LogAttachment.log_id == FileLog.id)
            .join(ContactFile, FileLog.file_id == ContactFile.id)
            .where(FileLog.deleted_at.is_(None))
            .order_by(LogAttachment.created_at.desc())
            .limit(limit)
        )
    ).all()

    # Uploader ids -> display names, one query. The User model's name fields
    # vary between builds, so probe the common ones instead of assuming.
    user_ids = {a.uploaded_by for a, _l, _f in rows if a.uploaded_by}
    user_names: dict[str, str] = {}
    if user_ids:
        for u in (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars():
            user_names[u.id] = (
                getattr(u, "full_name", None)
                or " ".join(
                    x for x in (getattr(u, "first_name", None), getattr(u, "last_name", None)) if x
                ).strip()
                or getattr(u, "username", None)
                or getattr(u, "email", None)
                or u.id
            )

    # Client names: bridged Contact when the file has one, else the typed-in
    # lead fields — same fallback order the log grid uses.
    contact_ids = {f.contact_id for _a, _l, f in rows if f.contact_id}
    contact_names: dict[str, str] = {}
    if contact_ids:
        for c in (await session.execute(select(Contact).where(Contact.id.in_(contact_ids)))).scalars():
            contact_names[c.id] = (
                " ".join(x for x in (c.first_name, c.last_name) if x).strip()
                or (c.company_name or "")
            )

    items = []
    for a, log, f in rows:
        client = (
            (contact_names.get(f.contact_id) if f.contact_id else None)
            or " ".join(x for x in (f.lead_first_name, f.lead_last_name) if x).strip()
            or f.lead_company
            or ""
        )
        items.append(
            {
                "id": a.id,
                "filename": a.filename,
                "content_type": a.content_type,
                "size_bytes": a.size_bytes or 0,
                "deliverables": [d.strip() for d in (a.deliverables or "").split(",") if d.strip()],
                "created_at": a.created_at.isoformat() if a.created_at else None,
                "uploaded_by": user_names.get(a.uploaded_by) or "",
                "log_id": a.log_id,
                "log_code": f.log_code,
                "file_number": f.file_number,
                "origin_module": f.origin_module,
                "subject": f.subject or "",
                "client": client,
                "site": f.city or f.site_location or "",
            }
        )
    return {"items": items, "total": len(items)}


'''


def main() -> int:
    if not P.is_file():
        print("router.py not found at " + str(P) + " — run from the project root, or pass the path")
        return 1
    text = P.read_text(encoding="utf-8")
    if '"/files/manager"' in text:
        print("GET /files/manager already in router.py — nothing to do")
    else:
        n = text.count(ANCHOR)
        if n != 1:
            print("anchor found %d times, expected 1 — router.py drifted; stopping, nothing changed" % n)
            return 1
        bak = pathlib.Path(str(P) + ".bak2")
        if not bak.exists():
            shutil.copy2(P, bak)
            print("backup:  " + str(bak))
        P.write_text(text.replace(ANCHOR, ENDPOINT + ANCHOR), encoding="utf-8")
        print("added GET /files/manager above the files/ui route")
    try:
        py_compile.compile(str(P), doraise=True)
        print("router.py compiles OK")
    except py_compile.PyCompileError as e:
        print("COMPILE FAILED — restoring is easy: the original is in router.py.bak2")
        print(str(e))
        return 1
    if VENV_P.is_file():
        shutil.copy2(P, VENV_P)
        print("synced to venv: " + str(VENV_P))
    else:
        print("no venv copy found at " + str(VENV_P) + " — skipped sync")
    print("DONE — copy the new files.html into place, then restart the server")
    return 0


if __name__ == "__main__":
    sys.exit(main())
