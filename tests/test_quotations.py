"""Database-free checks for the quotation editor: table lines, totals, conditions.

Schema tests need only pydantic. The totals tests import quotation_service,
which needs OCE's app package; like test_log_filters they run in the app's
virtual environment and are skipped elsewhere.
"""

from __future__ import annotations

import os
import unittest
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from modules.achi.schemas import QuotationCreate, QuotationLineIn, QuotationUpdate

REPO_ROOT = Path(__file__).resolve().parents[1]
ACHI = REPO_ROOT / "modules" / "achi"

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_quotation_unit")
os.environ.setdefault("APP_ENV", "development")

try:
    from modules.achi.models import QuotationLine
    from modules.achi.quotation_service import DEFAULT_CONDITIONS, compute_totals, line_total, to_minor
except ModuleNotFoundError:
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True


class QuotationLineSchemaTest(unittest.TestCase):
    def test_defaults_to_price_per_square_metre(self) -> None:
        line = QuotationLineIn(item="Scaffolding hire", quantity="250", unit_price="12.5")
        self.assertEqual(line.unit, "m²")
        self.assertEqual((line.quantity, line.unit_price), ("250", "12.5"))

    def test_thousands_separators_are_dropped_and_blanks_are_none(self) -> None:
        line = QuotationLineIn(quantity="1,250.5", unit_price=" ")
        self.assertEqual(line.quantity, "1250.5")
        self.assertIsNone(line.unit_price)

    def test_words_and_negative_amounts_are_refused(self) -> None:
        for bad in ({"quantity": "ten"}, {"unit_price": "-3"}, {"unit_price": "NaN"}, {"quantity": "1e999999"}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                QuotationLineIn(**bad)

    def test_end_date_before_start_is_refused(self) -> None:
        with self.assertRaises(ValidationError):
            QuotationLineIn(start_date="2026-10-10", end_date="2026-10-01")
        line = QuotationLineIn(start_date="2026-10-01", end_date="2026-10-01")
        self.assertEqual(line.end_date, date(2026, 10, 1))

    def test_unknown_line_fields_are_refused(self) -> None:
        with self.assertRaises(ValidationError):
            QuotationLineIn(item="x", total="999")

    def test_update_carries_lines_and_conditions_only_when_sent(self) -> None:
        sent = QuotationUpdate(lines=[{"item": "Transport", "unit": "lot", "quantity": "1", "unit_price": "150"}],
                               conditions="Payment 50% advance")
        dumped = sent.model_dump(exclude_unset=True)
        self.assertEqual(dumped["lines"][0]["unit_price"], "150")
        self.assertEqual(dumped["conditions"], "Payment 50% advance")
        self.assertNotIn("lines", QuotationUpdate(status="sent").model_dump(exclude_unset=True))

    def test_create_can_name_the_enquiry(self) -> None:
        self.assertEqual(QuotationCreate(file_id="f-1").file_id, "f-1")
        with self.assertRaises(ValidationError):
            QuotationCreate(status="won")


@unittest.skipUnless(HAS_APP_TEST_ENV, "needs the OCE app package")
class QuotationTotalsTest(unittest.TestCase):
    def test_line_total_is_quantity_times_price(self) -> None:
        self.assertEqual(line_total("250", to_minor("12.50")), 312_500)
        self.assertEqual(line_total("0.5", 1), 1)          # half a cent rounds up, like a till
        self.assertEqual(line_total(None, 1000), 0)

    def test_lines_replace_the_single_estimate(self) -> None:
        estimate = {"area_sqm": "100", "duration_weeks": "4", "rate_minor": 250, "erection_minor": 50_000}
        self.assertEqual(compute_totals(estimate), (150_000, 0, 150_000))
        # With lines, the estimate no longer prices anything.
        self.assertEqual(compute_totals(estimate, [312_500, 15_000]), (327_500, 0, 327_500))

    def test_discount_then_vat(self) -> None:
        data = {"discount_minor": 27_500, "vat_percent": "11"}
        self.assertEqual(compute_totals(data, [312_500, 15_000]), (300_000, 33_000, 333_000))
        # A discount larger than the work is a typo, not a credit.
        self.assertEqual(compute_totals({"discount_minor": 10**6}, [500]), (0, 0, 0))

    def test_standard_conditions_exist(self) -> None:
        self.assertIn("Payment", DEFAULT_CONDITIONS)

    def test_line_table_is_namespaced_and_keeps_clear_of_erp_columns(self) -> None:
        columns = set(QuotationLine.__table__.columns.keys())
        self.assertEqual(QuotationLine.__tablename__, "achi_quotation_line")
        self.assertNotIn("project_id", columns)       # the ERP deletes rows by that column
        fk = next(iter(QuotationLine.__table__.c.quotation_id.foreign_keys))
        self.assertEqual((fk.column.table.name, fk.ondelete), ("achi_quotation", "CASCADE"))


class QuotationEditorPageTest(unittest.TestCase):
    def test_editor_prints_conditions_on_their_own_page(self) -> None:
        html = (ACHI / "ui" / "quotation_editor.html").read_text(encoding="utf-8")
        self.assertIn(".qp-page + .qp-page{break-before:page}", html)
        self.assertIn('src="/api/v1/achi/quotations/editor.js', html)

    def test_list_links_to_the_editor(self) -> None:
        html = (ACHI / "ui" / "quotations.html").read_text(encoding="utf-8")
        self.assertIn('href="/api/v1/achi/quotations/edit"', html)


if __name__ == "__main__":
    unittest.main()
