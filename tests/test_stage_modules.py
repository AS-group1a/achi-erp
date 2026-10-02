"""The DRAW, M/T, BOQ and Quotation pages are built from general_log.html.

router.py rewrites that page per module (title, heading, code, stage scope).
If the Log page changes and an anchor disappears, the builder must fail loudly
rather than silently serve the unscoped Log, as the old Site Visit page did.
router.py imports the ERP app, so only the builder is loaded here.
"""

from __future__ import annotations

import ast
import json
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UI_DIR = REPO_ROOT / "modules" / "achi" / "ui"


def _load_builder() -> dict:
    tree = ast.parse((REPO_ROOT / "modules" / "achi" / "router.py").read_text(encoding="utf-8"))
    wanted = [
        node for node in tree.body
        if (isinstance(node, ast.FunctionDef) and node.name == "_stage_module_page")
        or (isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "STAGE_MODULES")
        or (isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") in {"_QUOTATION_ACTIONS", "_STAGE_ACTIONS"})
    ]
    namespace = {"json": json, "_UI_DIR": UI_DIR}
    exec(compile(ast.Module(body=wanted, type_ignores=[]), "router_builder", "exec"), namespace)
    return namespace


class StageModulePagesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.ns = _load_builder()

    def test_each_module_is_scoped_and_coded(self) -> None:
        expected = {
            "draw": ("DRAW", "DRAW", ["drawing"]),
            "mt": ("M/T", "M/T", ["takeoff"]),
            "boq": ("BOQ", "BOQ", ["boq"]),
            "quotation": ("Quotation", "QUO", ["costing", "pricing", "quotation", "negotiation", "accepted", "cancelled"]),
        }
        self.assertEqual(set(self.ns["STAGE_MODULES"]), set(expected))
        for key, (title, code, stages) in expected.items():
            with self.subTest(module=key):
                args = self.ns["STAGE_MODULES"][key]
                self.assertEqual(args[:2], (title, code))
                self.assertEqual(args[2]["stages"], stages)
                page = self.ns["_stage_module_page"](*args)
                self.assertIn(f"<title>{title} ·", page)
                self.assertIn(f'data-achi-title="{title}"', page)
                self.assertIn(f'<h1 id="log-overview-title">{title}</h1>', page)
                self.assertIn(f"window.ACHI_BUSINESS_CODE = {json.dumps(code)};", page)
                self.assertIn(json.dumps(stages), page)
                # The scope must be declared before log-core.js reads it at load.
                self.assertLess(page.index("window.ACHI_LOG_FILTER"), page.index("/api/v1/achi/ui/log-core.js"))

    def test_only_the_quotation_module_writes_quotations(self) -> None:
        actions = self.ns["_STAGE_ACTIONS"]
        self.assertEqual(set(actions), {"quotation"})
        page = self.ns["_stage_module_page"](*self.ns["STAGE_MODULES"]["quotation"], actions=actions["quotation"])
        self.assertIn('id="quo-new"', page)
        self.assertIn("/api/v1/achi/quotations/edit", page)
        # Placed beside "+ Add Log", not somewhere the anchor no longer exists.
        self.assertLess(page.index('id="quo-new"'), page.index('id="expand-row"'))
        self.assertNotIn('id="quo-new"', self.ns["_stage_module_page"](*self.ns["STAGE_MODULES"]["boq"]))

    def test_missing_anchor_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "general_log.html").write_text(
                "<title>Log · ARARA ERP</title><body>redesigned</body>", encoding="utf-8",
            )
            self.ns["_UI_DIR"] = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "general_log.html changed"):
                self.ns["_stage_module_page"](*self.ns["STAGE_MODULES"]["draw"])


if __name__ == "__main__":
    unittest.main()
