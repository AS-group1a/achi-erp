"""Accounting: a double-entry ledger per company (Achi Scaffolding / ARARA),
with the documents that feed it — sales invoices, customer receipts, expenses
and manual journal entries.

Why our own and not the ERP's oe_finance ledger: every oe_finance ledger row
must belong to one of the ERP's construction projects (project_id NOT NULL,
finance/models.py LedgerEntry), and the ERP deletes rows by project_id when
one of its projects is deleted. Company books cannot live there.

Rules the code relies on:

* Every posting is one AchiAccEntry whose lines balance (debits == credits)
  in the company's BASE currency. Documents may be in another currency; they
  carry the exchange rate used, and the ledger holds the converted amounts.
* Posted entries are never edited or deleted. A mistake is undone by a
  reversing entry (void), so the books always show what happened and when.
* Money is integer minor units (cents), BigInteger: LBP amounts overflow
  32 bits quickly.
* No column is named project_id (the ERP deletes rows by that name).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

ACCOUNT_TYPES = ("asset", "liability", "equity", "income", "expense")
# Accounts the automatic postings need. Exactly one account per role per company.
ACCOUNT_ROLES = (
    "receivable", "payable", "vat_output", "vat_input", "customer_deposits",
    "sales_discount", "fx_difference", "retained_earnings", "default_income", "default_expense",
)
PAYMENT_METHODS = ("cash", "bank_transfer", "cheque", "card", "other")


def _uuid() -> str:
    return str(uuid.uuid4())


class AchiAccSettings(Base):
    """Per-company accounting settings and the details printed on documents."""

    __tablename__ = "achi_acc_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    base_currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD", server_default="USD")
    default_vat_percent: Mapped[str] = mapped_column(String(8), nullable=False, default="11", server_default="11")
    invoice_due_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30, server_default="30")
    # Nothing dated on or before this day can be posted or voided.
    lock_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Letterhead for invoices and quotations.
    legal_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    address: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    phone: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    tax_number: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    bank_details: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    invoice_terms: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")


class AchiAccAccount(Base):
    """One account of a company's chart of accounts."""

    __tablename__ = "achi_acc_account"
    __table_args__ = (
        UniqueConstraint("company", "code", name="uq_achi_acc_account_company_code"),
        Index("ix_achi_acc_account_company_type", "company", "type"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    code: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)            # ACCOUNT_TYPES
    role: Mapped[str | None] = mapped_column(String(32), nullable=True)      # ACCOUNT_ROLES
    # Cash and bank accounts: money is received into and paid out of these.
    is_bank: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")


class AchiAccEntry(Base):
    """A journal entry: one balanced posting, from a document or typed by hand."""

    __tablename__ = "achi_acc_entry"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_acc_entry_company_number"),
        Index("ix_achi_acc_entry_company_date", "company", "entry_date"),
        Index("ix_achi_acc_entry_source", "source_type", "source_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)             # JE-<number>
    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    memo: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # manual | invoice | receipt | allocation | expense, and what it came from.
    source_type: Mapped[str] = mapped_column(String(24), nullable=False)
    source_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # A void is a second entry with every line flipped; the two point at each other.
    reversal_of_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reversed_by_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    total_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)   # sum of debits
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)


class AchiAccLine(Base):
    """One debit or credit of a journal entry, in base currency."""

    __tablename__ = "achi_acc_line"
    __table_args__ = (
        Index("ix_achi_acc_line_account_date", "company", "account_id", "entry_date"),
        Index("ix_achi_acc_line_entry", "entry_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    entry_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_acc_entry.id", ondelete="CASCADE"), nullable=False)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_acc_account.id"), nullable=False)
    entry_date: Mapped[date] = mapped_column(Date, nullable=False)          # copied from the entry for reports
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    debit_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    credit_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")


class AchiSalesInvoice(Base):
    """A sales invoice. Draft until issued; issuing posts it to the ledger."""

    __tablename__ = "achi_sales_invoice"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_sales_invoice_company_number"),
        Index("ix_achi_sales_invoice_company_status", "company", "status"),
        Index("ix_achi_sales_invoice_quotation", "quotation_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)             # INV-<number>
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")   # draft | issued | void
    quotation_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("achi_quotation.id", ondelete="SET NULL"), nullable=True
    )
    file_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    customer_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    customer_company: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    customer_mobile: Mapped[str] = mapped_column(String(32), nullable=False, default="", server_default="")
    customer_email: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    customer_address: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    customer_tax_number: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    subject: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    issue_date: Mapped[date] = mapped_column(Date, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    # Units of this currency per 1 unit of base currency ("1 USD = 89,500 LBP" -> 89500).
    fx_rate: Mapped[str] = mapped_column(String(24), nullable=False, default="1")
    discount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    vat_percent: Mapped[str] = mapped_column(String(8), nullable=False, default="0")
    items_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)   # sum of lines
    subtotal_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)  # after discount
    vat_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    total_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    paid_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)    # in invoice currency
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    terms: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    entry_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)


class AchiSalesInvoiceLine(Base):
    __tablename__ = "achi_sales_invoice_line"
    __table_args__ = (Index("ix_achi_sales_invoice_line_invoice", "invoice_id", "position"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_sales_invoice.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    item: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    unit: Mapped[str] = mapped_column(String(16), nullable=False, default="m²", server_default="m²")
    quantity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    unit_price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    line_total_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # Income account credited; empty -> the company's default income account.
    account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class AchiAccReceipt(Base):
    """Money received from a customer into a cash or bank account."""

    __tablename__ = "achi_acc_receipt"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_acc_receipt_company_number"),
        Index("ix_achi_acc_receipt_company_date", "company", "receipt_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)             # RCT-<number>
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="posted")  # posted | void
    receipt_date: Mapped[date] = mapped_column(Date, nullable=False)
    contact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    customer_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    customer_company: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    method: Mapped[str] = mapped_column(String(16), nullable=False, default="bank_transfer")
    reference: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    deposit_account_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_acc_account.id"), nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    fx_rate: Mapped[str] = mapped_column(String(24), nullable=False, default="1")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    allocated_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    entry_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)


class AchiAccAllocation(Base):
    """Part of a receipt applied to an invoice (both in the same currency)."""

    __tablename__ = "achi_acc_allocation"
    __table_args__ = (
        Index("ix_achi_acc_allocation_receipt", "receipt_id"),
        Index("ix_achi_acc_allocation_invoice", "invoice_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    receipt_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("achi_acc_receipt.id", ondelete="CASCADE"), nullable=False
    )
    invoice_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_sales_invoice.id"), nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The receivable credited for it, in base currency. Kept so the receivable of
    # a foreign-currency invoice clears to exactly zero once it is fully paid.
    base_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    allocation_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Set when allocated after the receipt was posted (its own small entry).
    entry_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")


class AchiAccExpense(Base):
    """Money paid out for a cost (or an asset bought), with its input VAT."""

    __tablename__ = "achi_acc_expense"
    __table_args__ = (
        UniqueConstraint("company", "number", name="uq_achi_acc_expense_company_number"),
        Index("ix_achi_acc_expense_company_date", "company", "expense_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    company: Mapped[str] = mapped_column(String(16), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)             # EXP-<number>
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="posted")  # posted | void
    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    supplier: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    reference: Mapped[str] = mapped_column(String(128), nullable=False, default="", server_default="")
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_acc_account.id"), nullable=False)
    paid_from_account_id: Mapped[str] = mapped_column(String(36), ForeignKey("achi_acc_account.id"), nullable=False)
    method: Mapped[str] = mapped_column(String(16), nullable=False, default="cash")
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="USD")
    fx_rate: Mapped[str] = mapped_column(String(24), nullable=False, default="1")
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)    # before VAT
    vat_percent: Mapped[str] = mapped_column(String(8), nullable=False, default="0")
    vat_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    total_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    entry_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
