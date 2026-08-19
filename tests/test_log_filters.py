"""Database-free contract tests for General Log query filters."""

from __future__ import annotations

import unittest
from datetime import date

from pydantic import ValidationError

from modules.achi.schemas import LogFilterParams, LogListParams


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

    def test_invalid_stage_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LogFilterParams(stage=["not-a-stage"])

    def test_inverted_date_range_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LogFilterParams(
                follow_up_from=date(2026, 8, 20),
                follow_up_to=date(2026, 8, 19),
            )


if __name__ == "__main__":
    unittest.main()