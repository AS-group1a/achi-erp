"""Database-free checks for the Projects + HR module.

project_schemas.py only needs pydantic, so it is loaded directly. The model
files import the ERP's Base, so they are inspected as source instead.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
import unittest
from pathlib import Path

from pydantic import ValidationError

REPO_ROOT = Path(__file__).resolve().parents[1]
ACHI = REPO_ROOT / "modules" / "achi"


def _load_schemas():
    spec = importlib.util.spec_from_file_location("achi_project_schemas", ACHI / "project_schemas.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _column_names(path: Path) -> dict[str, set[str]]:
    """{table class: database column names} from mapped_column() calls."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
        names = set()
        for stmt in cls.body:
            if not (isinstance(stmt, ast.AnnAssign) and isinstance(stmt.value, ast.Call)):
                continue
            if getattr(stmt.value.func, "id", "") != "mapped_column":
                continue
            first = stmt.value.args[0] if stmt.value.args else None
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                names.add(first.value)
            else:
                names.add(stmt.target.id)
        out[cls.name] = names
    return out


class ProjectSchemasTest(unittest.TestCase):
    def setUp(self) -> None:
        self.s = _load_schemas()

    def test_codes(self) -> None:
        self.assertEqual(self.s.project_code(3), "PRJ-3")
        self.assertEqual(self.s.task_code(12), "TSK-12")

    def test_task_due_before_start_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            self.s.TaskIn(company="arara", project_id="p", title="x", start_date="2026-10-10", due_date="2026-10-01")
        task = self.s.TaskIn(company="arara", project_id="p", title="x", start_date="2026-10-01", due_date="2026-10-01")
        self.assertEqual(task.status, "todo")

    def test_project_end_before_start_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            self.s.ProjectIn(company="achi", name="x", start_date="2026-10-10", end_date="2026-10-01")

    def test_only_the_two_companies(self) -> None:
        for company in ("achi", "arara"):
            self.s.ProjectIn(company=company, name="x")
        with self.assertRaises(ValidationError):
            self.s.ProjectIn(company="acme", name="x")

    def test_unknown_fields_and_values_are_refused(self) -> None:
        with self.assertRaises(ValidationError):
            self.s.TaskIn(company="arara", project_id="p", title="x", status="archived")
        with self.assertRaises(ValidationError):
            self.s.TaskUpdate(owner="someone")


class ProjectTablesTest(unittest.TestCase):
    def test_no_new_table_uses_the_erp_project_id_column(self) -> None:
        # The ERP deletes rows from every table with a "project_id" column when
        # one of ITS projects is deleted, and scopes backups by it.
        for path in (ACHI / "project_models.py", ACHI / "hr_models.py"):
            for table, columns in _column_names(path).items():
                with self.subTest(table=table):
                    self.assertNotIn("project_id", columns)
        self.assertIn("achi_project_id", _column_names(ACHI / "project_models.py")["AchiProjectTask"])

    def test_tables_are_namespaced_and_have_no_updated_at(self) -> None:
        for path in (ACHI / "project_models.py", ACHI / "hr_models.py"):
            text = path.read_text(encoding="utf-8")
            for table in [line.split('"')[1] for line in text.splitlines() if "__tablename__" in line]:
                self.assertTrue(table.startswith("achi_"), table)
            for table, columns in _column_names(path).items():
                self.assertNotIn("updated_at", columns, table)


if __name__ == "__main__":
    unittest.main()
