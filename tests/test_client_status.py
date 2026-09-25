"""Database-free tests for the CRM CLIENT / LEAD rule.

A contact is a CLIENT when any enquiry in their history is a job (Won → JOB,
i.e. stage "accepted", or converted onto a project) that is not cancelled;
otherwise a LEAD. The route asks the database which contacts have such a job
(_JOB_FILE); single files are judged by is_job_file(). Both must agree.
"""

from __future__ import annotations

import os
import unittest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_client_status_unit",
)
os.environ.setdefault("APP_ENV", "development")

try:
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from modules.achi.models import ContactFile
    from modules.achi.service import _JOB_FILE, is_job_file
except ModuleNotFoundError:
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True


def _file(stage: str, status: str = "open", project_id: str | None = None) -> "ContactFile":
    return ContactFile(stage=stage, status=status, project_id=project_id)


def _status(history: list["ContactFile"]) -> str:
    """What the CRM shows for a contact with these enquiries."""
    return "client" if any(is_job_file(f) for f in history) else "lead"


@unittest.skipUnless(HAS_APP_TEST_ENV, "requires the ACHI application test environment")
class ClientStatusRuleTests(unittest.TestCase):
    def test_new_contact_through_quotation_is_lead(self) -> None:
        for stage in ("enquiry", "site_survey", "drawing", "takeoff", "boq", "quotation"):
            self.assertEqual(_status([_file(stage)]), "lead", stage)

    def test_won_to_job_makes_client(self) -> None:
        self.assertEqual(_status([_file("accepted")]), "client")
        self.assertEqual(_status([_file("accepted", status="transferred")]), "client")

    def test_converted_project_makes_client_even_off_accepted(self) -> None:
        self.assertEqual(_status([_file("quotation", status="done", project_id="p-1")]), "client")

    def test_existing_client_with_new_early_enquiry_stays_client(self) -> None:
        history = [_file("accepted", status="done"), _file("enquiry")]
        self.assertEqual(_status(history), "client")
        history = [_file("accepted"), _file("quotation")]
        self.assertEqual(_status(history), "client")

    def test_reverting_the_only_job_returns_to_lead(self) -> None:
        self.assertEqual(_status([_file("quotation")]), "lead")
        self.assertEqual(_status([_file("accepted", status="cancelled")]), "lead")

    def test_reverting_one_job_keeps_client_when_another_exists(self) -> None:
        history = [_file("quotation"), _file("accepted", status="done")]
        self.assertEqual(_status(history), "client")

    def test_sql_predicate_matches_the_python_rule(self) -> None:
        sql = str(
            select(ContactFile.contact_id)
            .where(_JOB_FILE)
            .compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
        )
        self.assertIn("achi_contact_file.stage = 'accepted'", sql)
        self.assertIn("achi_contact_file.project_id IS NOT NULL", sql)
        self.assertIn("achi_contact_file.status != 'cancelled'", sql)


if __name__ == "__main__":
    unittest.main()
