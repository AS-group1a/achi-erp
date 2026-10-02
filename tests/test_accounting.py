"""Database-free checks for Accounting: money arithmetic, input rules, the chart
of accounts and the tables. Like test_log_filters, the service and model
checks need OCE's app package and are skipped where it is not installed."""

from __future__ import annotations

import os
import unittest
from pathlib import Path

from pydantic import ValidationError

from modules.achi.acc_schemas import (
    AccountIn,
    AllocateIn,
    ExpenseIn,
    InvoiceIn,
    JournalIn,
    JournalLineIn,
    ReceiptIn,
    SettingsUpdate,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
ACHI = REPO_ROOT / "modules" / "achi"

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_accounting_unit")
os.environ.setdefault("APP_ENV", "development")

try:
    from fastapi import HTTPException

    from modules.achi import acc_models
    from modules.achi.acc_service import _CHART, convert, invoice_totals, line_total, percent_of, to_major, to_minor
except ModuleNotFoundError:
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True

DAY = "2026-10-02"


class AccountingSchemaTest(unittest.TestCase):
    def test_amounts_are_plain_numbers(self) -> None:
        self.assertEqual(ReceiptIn(company="achi", receipt_date=DAY, deposit_account_id="a", amount="1,250.5").amount, "1250.5")
        for bad in ("-5", "1e9", "ten", "1.234", "0"):
            with self.subTest(amount=bad), self.assertRaises(ValidationError):
                ReceiptIn(company="achi", receipt_date=DAY, deposit_account_id="a", amount=bad)

    def test_exchange_rate_must_be_positive(self) -> None:
        self.assertEqual(InvoiceIn(company="achi", issue_date=DAY, currency="LBP", fx_rate="89,500").fx_rate, "89500")
        for bad in ("0", "-1", "abc", ""):
            with self.subTest(rate=bad), self.assertRaises(ValidationError):
                InvoiceIn(company="achi", issue_date=DAY, fx_rate=bad)

    def test_invoice_dates_and_lines(self) -> None:
        with self.assertRaises(ValidationError):
            InvoiceIn(company="achi", issue_date=DAY, due_date="2026-09-01")
        inv = InvoiceIn(company="achi", issue_date=DAY, lines=[{"item": "Hire", "quantity": "250.5", "unit_price": "12.50"}])
        self.assertEqual((inv.lines[0].unit, inv.lines[0].quantity), ("m²", "250.5"))
        with self.assertRaises(ValidationError):
            InvoiceIn(company="achi", issue_date=DAY, lines=[{"quantity": "1.23456"}])
        with self.assertRaises(ValidationError):
            InvoiceIn(company="other", issue_date=DAY)

    def test_journal_lines_are_one_sided(self) -> None:
        self.assertEqual(JournalLineIn(account_id="a", debit="10").credit, None)
        for bad in ({"debit": "1", "credit": "1"}, {}, {"debit": "0"}):
            with self.subTest(line=bad), self.assertRaises(ValidationError):
                JournalLineIn(account_id="a", **bad)
        with self.assertRaises(ValidationError):
            JournalIn(company="achi", entry_date=DAY, lines=[{"account_id": "a", "debit": "1"}])

    def test_other_inputs(self) -> None:
        with self.assertRaises(ValidationError):
            AccountIn(company="achi", code="1020", name="Bank", type="expense", is_bank=True)
        with self.assertRaises(ValidationError):
            AllocateIn(allocation_date=DAY, allocations=[])
        with self.assertRaises(ValidationError):
            ExpenseIn(company="achi", expense_date=DAY, account_id="a", paid_from_account_id="b", amount="5", vat_percent="eleven")
        self.assertEqual(SettingsUpdate(default_vat_percent="").default_vat_percent, "0")


@unittest.skipUnless(HAS_APP_TEST_ENV, "needs the OCE app package")
class AccountingMoneyTest(unittest.TestCase):
    def test_conversion_uses_the_quoted_rate(self) -> None:
        self.assertEqual(convert(8_950_000_000, "89500"), 100_000)   # LBP 89.5M = USD 1,000.00
        self.assertEqual(convert(10_000, "0.92"), 10_870)              # EUR 100 = USD 108.70
        self.assertEqual(convert(12_345, "1"), 12_345)

    def test_rounding_is_half_up(self) -> None:
        self.assertEqual(line_total("0.5", 1), 1)
        self.assertEqual(percent_of(50, "11"), 6)                     # 5.5 cents -> 6
        self.assertEqual((to_minor("12.345"), to_major(-150)), (1235, "-1.50"))

    def test_totals_and_discount_guard(self) -> None:
        self.assertEqual(invoice_totals([312_500, 15_000], 7_500, "11"), (327_500, 320_000, 35_200, 355_200))
        with self.assertRaises(HTTPException):
            invoice_totals([100], 101, "0")

    def test_chart_has_every_role_once_and_unique_codes(self) -> None:
        roles = [row[3] for row in _CHART if row[3]]
        self.assertEqual(sorted(roles), sorted(acc_models.ACCOUNT_ROLES))
        codes = [row[0] for row in _CHART]
        self.assertEqual(len(codes), len(set(codes)))
        for code, _name, acc_type, _role, is_bank in _CHART:
            self.assertIn(acc_type, acc_models.ACCOUNT_TYPES)
            if is_bank:
                self.assertEqual(acc_type, "asset", code)

    def test_tables_are_namespaced_and_keep_clear_of_erp_columns(self) -> None:
        tables = [m.__table__ for m in vars(acc_models).values() if hasattr(m, "__table__")]
        self.assertGreaterEqual(len(tables), 9)
        for table in tables:
            with self.subTest(table=table.name):
                self.assertTrue(table.name.startswith("achi_"))
                self.assertNotIn("project_id", table.columns.keys())
        source = (ACHI / "acc_models.py").read_text(encoding="utf-8")
        self.assertNotIn("updated_at:", source)          # Base adds it


class AccountingPagesTest(unittest.TestCase):
    def test_pages_load_their_assets(self) -> None:
        page = (ACHI / "ui" / "accounting.html").read_text(encoding="utf-8")
        self.assertIn("/api/v1/achi/accounting/accounting.js", page)
        self.assertIn("/api/v1/achi/accounting/accounting.css", page)
        editor = (ACHI / "ui" / "invoice_editor.html").read_text(encoding="utf-8")
        self.assertIn("/api/v1/achi/accounting/invoice.js", editor)
        self.assertIn("/api/v1/achi/ui/doc.css", editor)

    def test_menu_and_page_access_know_accounting(self) -> None:
        chrome = (ACHI / "ui" / "chrome.js").read_text(encoding="utf-8")
        self.assertIn("label: 'Accounting', co: 'both', href: '/api/v1/achi/accounting/ui'", chrome)
        self.assertIn("var APP_VERSION = 'V 1.1';", chrome)
        users = (ACHI / "users_router.py").read_text(encoding="utf-8")
        self.assertIn('"/api/v1/achi/accounting/ui"', users)


if __name__ == "__main__":
    unittest.main()
