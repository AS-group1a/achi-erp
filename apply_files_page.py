#!/usr/bin/env python3
"""Add the ACHI "Files" page to both sidebars.

Edits IN PLACE (a .bak backup is written next to each file first):

  modules/achi/ui/chrome.js      standalone sidebar: LINKS entry + non-admin allowlist
  deploy/overrides/achi-nav.js   SPA sidebar: ENTRIES, FILES_ID, specs row,
                                 originalItemFor skip, role-filter keep list,
                                 completeness check in the 1s interval

Run from the project root:

    python3 apply_files_page.py

or point it at the files explicitly:

    python3 apply_files_page.py path/to/chrome.js path/to/achi-nav.js

Safe to re-run: edits that are already present are detected and skipped.
If an anchor can't be found (because the file changed), the script says
exactly which edit failed and touches nothing else in that file.
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path.cwd()
CHROME = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "modules/achi/ui/chrome.js"
NAV = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "deploy/overrides/achi-nav.js"

FOLDER_PATH = (
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9"
    "L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
)
FOLDER_SVG = (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round"><path d="' + FOLDER_PATH + '"/></svg>'
)

problems = []


def unique_replace(text, old, new, label):
    """Replace old with new exactly once, or record a problem and change nothing."""
    n = text.count(old)
    if n == 0:
        problems.append(label + ": anchor not found")
        return text, False
    if n > 1:
        problems.append(label + ": anchor found %d times, expected 1" % n)
        return text, False
    return text.replace(old, new), True


def append_to_array(text, array_marker, entry, label):
    """Insert `entry` as the last element of the JS array that starts at
    `array_marker`, keeping commas valid whatever the current last element
    looks like. Whitespace-tolerant."""
    i = text.find(array_marker)
    if i < 0:
        problems.append(label + ": '" + array_marker + "' not found")
        return text, False
    j = text.find("];", i)
    if j < 0:
        problems.append(label + ": closing '];' not found after array start")
        return text, False
    head = text[:j].rstrip()
    needs_comma = not head.endswith(",") and not head.endswith("[")
    return head + ("," if needs_comma else "") + "\n  " + entry + "\n  " + text[j:], True


def edit_file(path, edits):
    """edits: list of (label, done_marker, fn) where fn(text) -> (text, ok)."""
    if not path.is_file():
        problems.append(str(path) + ": file not found (run from the project root, or pass the path)")
        return
    original = path.read_text(encoding="utf-8")
    text = original
    applied, skipped = [], []
    for label, done_marker, fn in edits:
        if done_marker in text:
            skipped.append(label)
            continue
        text, ok = fn(text)
        if ok:
            applied.append(label)
    if text != original:
        bak = path.with_suffix(path.suffix + ".bak")
        if not bak.exists():
            shutil.copy2(path, bak)
            print("  backup:  " + str(bak))
        path.write_text(text, encoding="utf-8")
    print(str(path))
    for label in applied:
        print("  applied: " + label)
    for label in skipped:
        print("  already: " + label)
    if not applied and not skipped:
        print("  nothing applied")


# ---------------------------------------------------------------- chrome.js
chrome_link_entry = (
    "{ label: 'Files', href: '/api/v1/achi/files/ui', "
    "icon: '<path d=\"" + FOLDER_PATH + "\"/>' }"
)

chrome_edits = [
    (
        "LINKS: add Files after Team Tasks",
        "label: 'Files'",
        lambda t: append_to_array(t, "var LINKS = [", chrome_link_entry, "chrome.js LINKS"),
    ),
    (
        "showPrimaryLinksOnly: allow /api/v1/achi/files/ui for non-admins",
        "href === '/api/v1/achi/files/ui';",
        lambda t: unique_replace(
            t,
            "href === '/api/v1/achi/tasks/ui';",
            "href === '/api/v1/achi/tasks/ui' ||\n"
            "        href === '/api/v1/achi/files/ui';",
            "chrome.js allowlist",
        ),
    ),
]

# -------------------------------------------------------------- achi-nav.js
nav_entries_entry = (
    "{ id: 'achi-nav-files', label: 'Files', route: '/achi-files',\n"
    "      href: '/api/v1/achi/files/ui?v=1',\n"
    "      icon: '" + FOLDER_SVG + "' }"
)
# NOTE: the route is /achi-files, NOT /files — upstream's SPA owns /files
# ("Project Files") and achi-nav.js anchors on that very link.

nav_specs_entry = (
    "{ id: FILES_ID, route: '/achi-files', label: 'Files',\n"
    "  icon: '" + FOLDER_SVG + "' }"
)

nav_edits = [
    (
        "ENTRIES: add Files (route /achi-files -> /api/v1/achi/files/ui)",
        "id: 'achi-nav-files'",
        lambda t: append_to_array(t, "var ENTRIES = [", nav_entries_entry, "achi-nav.js ENTRIES"),
    ),
    (
        "constants: add FILES_ID",
        "var FILES_ID",
        lambda t: unique_replace(
            t,
            "var TASKS_ID = 'achi-nav-team-tasks';",
            "var TASKS_ID = 'achi-nav-team-tasks';\n  var FILES_ID = 'achi-nav-files';",
            "achi-nav.js FILES_ID",
        ),
    ),
    (
        "ensureOverviewModules: add Files spec row (last, after Team Tasks)",
        "{ id: FILES_ID",
        lambda t: append_to_array(t, "var specs = [", nav_specs_entry, "achi-nav.js specs"),
    ),
    (
        "originalItemFor: skip our own Files clone",
        "el.id === FILES_ID",
        lambda t: unique_replace(
            t,
            "el.id === PLANNER_ID ||",
            "el.id === PLANNER_ID ||\n        el.id === FILES_ID ||",
            "achi-nav.js originalItemFor",
        ),
    ),
    (
        "applyRoleSidebarFilter: keep Files visible for non-admins",
        "link.id === FILES_ID",
        lambda t: unique_replace(
            t,
            "|| (link.id === TASKS_ID)",
            "|| (link.id === TASKS_ID)\n        || link.id === FILES_ID",
            "achi-nav.js role filter",
        ),
    ),
    (
        "interval: look up the Files row",
        "var files = document.getElementById(FILES_ID)",
        lambda t: unique_replace(
            t,
            "var tasks = document.getElementById(TASKS_ID);",
            "var tasks = document.getElementById(TASKS_ID);\n"
            "  var files = document.getElementById(FILES_ID);",
            "achi-nav.js interval lookup",
        ),
    ),
    (
        "interval: re-inject when the Files row is missing",
        "tasks && files",
        lambda t: unique_replace(
            t,
            "&& quotation && tasks))",
            "&& quotation && tasks && files))",
            "achi-nav.js interval check",
        ),
    ),
]

print("Adding the Files page to the ACHI sidebars…\n")
edit_file(CHROME, chrome_edits)
print()
edit_file(NAV, nav_edits)
print()

if problems:
    print("PROBLEMS — these edits were NOT applied:")
    for p in problems:
        print("  ✗ " + p)
    print("\nYour file probably drifted from the version this script was written")
    print("against. Nothing else was touched; fix the anchors or apply that one")
    print("edit by hand.")
    sys.exit(1)

print("All sidebar edits are in. Still to do by hand:")
print("  1. Put files.html in modules/achi/ui/")
print("  2. Add the /files/ui route to modules/achi/router.py")
print("  3. Sync the .venv copies + bump achi-nav.js ?v= in index.html")
print("  4. Restart the server")