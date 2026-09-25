"""Database-free contract tests for General Log query filters."""

from __future__ import annotations

import os
import unittest
from datetime import date
from pathlib import Path

from pydantic import ValidationError
from modules.achi.schemas import (
    ContactFileUpdate,
    LogFilterParams,
    LogListParams,
    PersonIn,
    QuickLogCreate,
)


REPO_ROOT = Path(__file__).resolve().parents[1]

# Query-contract tests compile SQL only; they must not connect to a database.
# The installed app validates DATABASE_URL while importing its SQLAlchemy base.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_log_filter_unit",
)
os.environ.setdefault("APP_ENV", "development")

try:
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from modules.achi.models import ContactFile
    from modules.achi.service import _log_filter_predicates
except ModuleNotFoundError:
    # The Windows host test environment intentionally does not install OCE's
    # application package. These query-contract tests run in the repository's
    # Linux app virtual environment; schema tests remain runnable everywhere.
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True


class LogFilterParamsTests(unittest.TestCase):
    def test_stage_scope_and_interactive_stage_are_independent(self) -> None:
        filters = LogFilterParams(
            stages="prospect, quotation, prospect",
            stage=["quotation", "drawing"],
        )

        self.assertEqual(
            filters.stages,
            ["prospect", "quotation"],
        )
        self.assertEqual(
            filters.stage,
            ["quotation", "drawing"],
        )

    def test_multi_values_are_trimmed_and_deduplicated(self) -> None:
        filters = LogFilterParams(
            owner=[" user-1 ", "USER-1", "user-2"],
            tag=[" urgent ", "urgent", "Sales"],
        )

        self.assertEqual(filters.owner, ["user-1", "user-2"])
        self.assertEqual(filters.tag, ["urgent", "Sales"])

    def test_follow_up_filter_accepts_browser_today_value(self) -> None:
        filters = LogFilterParams(
            follow_up_state="overdue",
            today=date(2026, 8, 19),
        )

        self.assertEqual(filters.follow_up_state, "overdue")
        self.assertEqual(filters.today, date(2026, 8, 19))

    def test_list_pagination_and_deleted_flag_are_validated(self) -> None:
        params = LogListParams(
            q="north site",
            limit=500,
            offset=20,
            deleted=True,
        )

        self.assertEqual(params.q, "north site")
        self.assertEqual(params.limit, 500)
        self.assertEqual(params.offset, 20)
        self.assertTrue(params.deleted)

    def test_sort_and_stable_sequence_scope_are_validated(self) -> None:
        params = LogListParams(
            sort_by="company",
            sort_dir="desc",
            module_sequence=True,
            sequence_stages="takeoff",
            sequence_origins="crm,prospect",
        )

        self.assertEqual(params.sort_by, "company")
        self.assertEqual(params.sort_dir, "desc")
        self.assertTrue(params.module_sequence)
        self.assertEqual(params.sequence_stages, ["takeoff"])
        self.assertEqual(params.sequence_origins, ["crm", "prospect"])

    def test_invalid_sort_and_sequence_stage_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LogListParams(sort_by="description")
        with self.assertRaises(ValidationError):
            LogListParams(sequence_stages="not-a-stage")

    def test_invalid_stage_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LogFilterParams(stage=["not-a-stage"])

    def test_plan_stage_is_accepted_for_workspace_scoping(self) -> None:
        filters = LogFilterParams(stages="plan", stage=["plan"])

        self.assertEqual(filters.stages, ["plan"])
        self.assertEqual(filters.stage, ["plan"])

    def test_inverted_date_range_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LogFilterParams(
                follow_up_from=date(2026, 8, 20),
                follow_up_to=date(2026, 8, 19),
            )

    def test_origin_values_are_validated_on_quick_log_creation(self) -> None:
        for origin in ("prospect", "crm", "quotation"):
            created = QuickLogCreate(
                person=PersonIn(first_name="Origin", last_name="Test"),
                origin_module=origin,
            )

            self.assertEqual(created.origin_module, origin)

        with self.assertRaises(ValidationError):
            QuickLogCreate(
                person=PersonIn(first_name="Origin", last_name="Test"),
                origin_module="unknown",
            )

    def test_normal_file_update_cannot_mutate_origin(self) -> None:
        self.assertNotIn("origin_module", ContactFileUpdate.model_fields)

    def test_origin_filters_are_normalized(self) -> None:
        filters = LogFilterParams(
            origins=" prospect,crm,prospect ",
            legacy_log_type=" Prospect,Prospect ",
        )

        self.assertEqual(filters.origins, ["prospect", "crm"])
        self.assertEqual(filters.legacy_log_type, ["Prospect"])

    def test_workspace_create_defaults_are_explicit(self) -> None:
        expected = {
            "prospect.html": "create: {origin: 'prospect', stage: 'prospect'}",
            "crm_general_log.html": "create: {origin: 'crm', stage: 'enquiry'}",
            "quotation_workspace.html": "create: {origin: 'quotation', stage: 'quotation'}",
            "draw_workspace.html": "stage: 'drawing'",
            "resource_workspace.html": "stage:'resources'",
            "plan_workspace.html": "stage:'plan'",
        }

        for relative_path, expected_setting in expected.items():
            source = (REPO_ROOT / "modules" / "achi" / "ui" / relative_path).read_text(
                encoding="utf-8"
            )
            self.assertIn(expected_setting, source)


@unittest.skipUnless(HAS_APP_TEST_ENV, "requires the ACHI application test environment")
class OriginQueryContractTests(unittest.TestCase):
    def _compiled_predicates(self, filters: LogFilterParams) -> str:
        statement = select(ContactFile.id).where(*_log_filter_predicates(filters))
        return str(statement.compile(dialect=postgresql.dialect()))

    def test_crm_includes_prospect_and_crm_origins_but_not_quotation(self) -> None:
        sql = self._compiled_predicates(
            LogFilterParams(
                stages="enquiry,quotation",
                origins="prospect,crm",
                include_legacy_origins=True,
            )
        )

        self.assertIn("achi_contact_file.origin_module IN", sql)
        self.assertIn("achi_contact_file.origin_module IS NULL", sql)

    def test_prospect_legacy_log_type_is_limited_to_null_origin_rows(self) -> None:
        sql = self._compiled_predicates(
            LogFilterParams(
                stages="prospect,enquiry",
                origins="prospect",
                include_legacy_origins=True,
                legacy_log_type="Prospect",
            )
        )

        self.assertIn("achi_contact_file.origin_module IN", sql)
        self.assertIn("achi_contact_file.origin_module IS NULL", sql)
        self.assertIn("achi_file_log.log_type", sql)

    def test_quotation_remains_stage_driven_for_all_origins(self) -> None:
        sql = self._compiled_predicates(
            LogFilterParams(stages="quotation,negotiation,accepted,cancelled")
        )

        self.assertNotIn("origin_module", sql)

    def test_this_month_filters_on_created_at_like_the_kpi(self) -> None:
        self.assertNotIn(
            "achi_file_log.created_at >=",
            self._compiled_predicates(LogFilterParams()),
        )
        sql = self._compiled_predicates(LogFilterParams(this_month=True))

        self.assertIn("achi_file_log.created_at >=", sql)
        self.assertIn("achi_file_log.created_at <", sql)


if __name__ == "__main__":
    unittest.main()
