"""Request and response shapes for Accounting.

Money crosses the API as decimal STRINGS ("1250.00") and is converted to
integer minor units in acc_service; exchange rates are decimal strings too.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Company = Literal["achi", "arara"]
AccountType = Literal["asset", "liability", "equity", "income", "expense"]
PaymentMethod = Literal["cash", "bank_transfer", "cheque", "card", "other"]
Currency = Literal["USD", "EUR", "LBP"]

_AMOUNT = re.compile(r"\d{1,13}(\.\d{0,2})?|\.\d{1,2}")
_QTY = re.compile(r"\d{1,12}(\.\d{0,4})?|\.\d{1,4}")
_RATE = re.compile(r"\d{1,9}(\.\d{0,8})?|\.\d{1,8}")
_PERCENT = re.compile(r"\d{1,3}(\.\d{0,2})?")


def _clean(value) -> str:
    return str(value or "").replace(",", "").replace(" ", "")


def amount_text(value, label: str, *, required: bool = False) -> str | None:
    """A typed amount -> plain text with at most 2 decimals, or None if blank.

    Plain digits only: words, signs and exponents are refused, so a typo never
    becomes zero silently and nothing can overflow the arithmetic.
    """
    text = _clean(value)
    if not text:
        if required:
            raise ValueError(f"{label} is required")
        return None
    if not _AMOUNT.fullmatch(text):
        raise ValueError(f"{label} must be an amount like 1250 or 1250.50")
    return text


def _pattern_text(value, pattern: re.Pattern, message: str) -> str | None:
    text = _clean(value)
    if not text:
        return None
    if not pattern.fullmatch(text):
        raise ValueError(message)
    return text


def rate_text(value) -> str:
    """Exchange rate: units of the document's currency for 1 unit of base currency."""
    text = _pattern_text(value, _RATE, "Exchange rate must be a number like 1 or 89500")
    if not text or float(text) <= 0:
        raise ValueError("Exchange rate must be more than zero")
    return text


def vat_text(value) -> str | None:
    return _pattern_text(value, _PERCENT, "VAT % must be a number like 11 or 11.5")


def positive_amount(value, label: str) -> str:
    text = amount_text(value, label, required=True)
    if float(text) <= 0:
        raise ValueError(f"{label} must be more than zero")
    return text


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ── settings and accounts ───────────────────────────────────────────────────

class SettingsUpdate(_In):
    base_currency: Currency | None = None
    default_vat_percent: str | None = Field(None, max_length=8)
    invoice_due_days: int | None = Field(None, ge=0, le=365)
    lock_date: date | None = None
    legal_name: str | None = Field(None, max_length=255)
    address: str | None = Field(None, max_length=2000)
    phone: str | None = Field(None, max_length=64)
    email: str | None = Field(None, max_length=255)
    tax_number: str | None = Field(None, max_length=64)
    bank_details: str | None = Field(None, max_length=2000)
    invoice_terms: str | None = Field(None, max_length=20000)

    @field_validator("default_vat_percent")
    @classmethod
    def _vat(cls, v):
        if v is None:
            return None
        return vat_text(v) or "0"


class SettingsOut(BaseModel):
    company: Company
    company_name: str
    base_currency: str
    default_vat_percent: str
    invoice_due_days: int
    lock_date: date | None
    legal_name: str
    address: str
    phone: str
    email: str
    tax_number: str
    bank_details: str
    invoice_terms: str
    has_entries: bool


class AccountIn(_In):
    company: Company
    code: str = Field(min_length=1, max_length=16, pattern=r"^[0-9A-Za-z.\-]+$")
    name: str = Field(min_length=1, max_length=255)
    type: AccountType
    is_bank: bool = False
    description: str = Field("", max_length=2000)

    @model_validator(mode="after")
    def _bank_is_asset(self):
        if self.is_bank and self.type != "asset":
            raise ValueError("A cash or bank account must be an asset account")
        return self


class AccountUpdate(_In):
    code: str | None = Field(None, min_length=1, max_length=16, pattern=r"^[0-9A-Za-z.\-]+$")
    name: str | None = Field(None, min_length=1, max_length=255)
    type: AccountType | None = None
    is_bank: bool | None = None
    active: bool | None = None
    description: str | None = Field(None, max_length=2000)


class AccountOut(BaseModel):
    id: str
    company: Company
    code: str
    name: str
    type: AccountType
    role: str | None
    is_bank: bool
    active: bool
    description: str
    balance: str            # base currency, sign-adjusted: positive = normal balance
    has_entries: bool


# ── invoices ────────────────────────────────────────────────────────────────

class InvoiceLineIn(_In):
    item: str = Field("", max_length=255)
    description: str = Field("", max_length=5000)
    start_date: date | None = None
    end_date: date | None = None
    unit: str = Field("m²", max_length=16)
    quantity: str | None = Field(None, max_length=32)
    unit_price: str | None = Field(None, max_length=32)
    account_id: str | None = Field(None, max_length=36)

    @model_validator(mode="after")
    def _check(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("A line's end date cannot be before its start date")
        self.quantity = _pattern_text(self.quantity, _QTY, "Quantity must be a number (up to 4 decimals)")
        self.unit_price = amount_text(self.unit_price, "Price")
        self.unit = self.unit or "m²"
        self.account_id = self.account_id or None
        return self


class InvoiceIn(_In):
    company: Company
    customer_name: str = Field("", max_length=255)
    customer_company: str = Field("", max_length=255)
    customer_mobile: str = Field("", max_length=32)
    customer_email: str = Field("", max_length=255)
    customer_address: str = Field("", max_length=2000)
    customer_tax_number: str = Field("", max_length=64)
    contact_id: str | None = Field(None, max_length=36)
    subject: str = Field("", max_length=1000)
    issue_date: date
    due_date: date | None = None
    currency: Currency = "USD"
    fx_rate: str = Field("1", max_length=24)
    discount: str | None = Field(None, max_length=32)
    vat_percent: str | None = Field(None, max_length=8)
    notes: str = Field("", max_length=20000)
    terms: str = Field("", max_length=20000)
    lines: list[InvoiceLineIn] = Field(default_factory=list, max_length=200)

    @field_validator("fx_rate")
    @classmethod
    def _rate(cls, v):
        return rate_text(v)

    @field_validator("discount")
    @classmethod
    def _discount(cls, v):
        return amount_text(v, "Discount")

    @field_validator("vat_percent")
    @classmethod
    def _vat(cls, v):
        return vat_text(v)

    @model_validator(mode="after")
    def _dates(self):
        if self.due_date and self.due_date < self.issue_date:
            raise ValueError("The due date cannot be before the invoice date")
        return self


class AllocationOut(BaseModel):
    id: str
    receipt_id: str
    receipt_code: str
    invoice_id: str
    invoice_code: str
    date: date
    amount: str
    method: str
    reference: str


class InvoiceLineOut(BaseModel):
    id: str
    position: int
    item: str
    description: str
    start_date: date | None
    end_date: date | None
    unit: str
    quantity: str | None
    unit_price: str | None
    total: str
    account_id: str | None


class InvoiceOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    status: Literal["draft", "issued", "void"]
    payment_status: Literal["draft", "unpaid", "partly_paid", "paid", "overdue", "void"]
    quotation_id: str | None
    quotation_code: str | None = None
    file_id: str | None
    contact_id: str | None
    customer_name: str
    customer_company: str
    customer_mobile: str
    customer_email: str
    customer_address: str
    customer_tax_number: str
    subject: str
    issue_date: date
    due_date: date | None
    currency: str
    fx_rate: str
    discount: str
    vat_percent: str
    items_total: str
    subtotal: str
    vat: str
    total: str
    paid: str
    balance: str
    notes: str
    terms: str
    entry_id: str | None
    issued_at: datetime | None
    created_at: datetime | None
    lines: list[InvoiceLineOut] | None = None
    payments: list[AllocationOut] | None = None


# ── receipts ────────────────────────────────────────────────────────────────

class AllocationIn(_In):
    invoice_id: str = Field(min_length=1, max_length=36)
    amount: str = Field(max_length=32)

    @field_validator("amount")
    @classmethod
    def _amount(cls, v):
        return positive_amount(v, "An allocated amount")


class ReceiptIn(_In):
    company: Company
    receipt_date: date
    customer_name: str = Field("", max_length=255)
    customer_company: str = Field("", max_length=255)
    contact_id: str | None = Field(None, max_length=36)
    method: PaymentMethod = "bank_transfer"
    reference: str = Field("", max_length=128)
    deposit_account_id: str = Field(min_length=1, max_length=36)
    currency: Currency = "USD"
    fx_rate: str = Field("1", max_length=24)
    amount: str = Field(max_length=32)
    notes: str = Field("", max_length=5000)
    allocations: list[AllocationIn] = Field(default_factory=list, max_length=100)

    @field_validator("fx_rate")
    @classmethod
    def _rate(cls, v):
        return rate_text(v)

    @field_validator("amount")
    @classmethod
    def _amount(cls, v):
        return positive_amount(v, "The amount received")


class AllocateIn(_In):
    allocation_date: date
    allocations: list[AllocationIn] = Field(min_length=1, max_length=100)


class ReceiptOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    status: Literal["posted", "void"]
    receipt_date: date
    contact_id: str | None
    customer_name: str
    customer_company: str
    method: str
    reference: str
    deposit_account_id: str
    deposit_account_name: str
    currency: str
    fx_rate: str
    amount: str
    allocated: str
    unallocated: str
    notes: str
    entry_id: str | None
    created_at: datetime | None
    allocations: list[AllocationOut] = []


# ── expenses ────────────────────────────────────────────────────────────────

class ExpenseIn(_In):
    company: Company
    expense_date: date
    supplier: str = Field("", max_length=255)
    description: str = Field("", max_length=5000)
    reference: str = Field("", max_length=128)
    account_id: str = Field(min_length=1, max_length=36)
    paid_from_account_id: str = Field(min_length=1, max_length=36)
    method: PaymentMethod = "cash"
    currency: Currency = "USD"
    fx_rate: str = Field("1", max_length=24)
    amount: str = Field(max_length=32)
    vat_percent: str | None = Field(None, max_length=8)

    @field_validator("fx_rate")
    @classmethod
    def _rate(cls, v):
        return rate_text(v)

    @field_validator("vat_percent")
    @classmethod
    def _vat(cls, v):
        return vat_text(v)

    @field_validator("amount")
    @classmethod
    def _amount(cls, v):
        return positive_amount(v, "The amount")


class ExpenseOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    status: Literal["posted", "void"]
    expense_date: date
    supplier: str
    description: str
    reference: str
    account_id: str
    account_name: str
    paid_from_account_id: str
    paid_from_name: str
    method: str
    currency: str
    fx_rate: str
    amount: str
    vat_percent: str
    vat: str
    total: str
    entry_id: str | None
    created_at: datetime | None


# ── journal ─────────────────────────────────────────────────────────────────

class JournalLineIn(_In):
    account_id: str = Field(min_length=1, max_length=36)
    debit: str | None = Field(None, max_length=32)
    credit: str | None = Field(None, max_length=32)
    description: str = Field("", max_length=1000)

    @model_validator(mode="after")
    def _one_side(self):
        self.debit = amount_text(self.debit, "Debit")
        self.credit = amount_text(self.credit, "Credit")
        d = float(self.debit or 0)
        c = float(self.credit or 0)
        if d and c:
            raise ValueError("A line is either a debit or a credit, not both")
        if not d and not c:
            raise ValueError("Each line needs a debit or a credit")
        return self


class JournalIn(_In):
    company: Company
    entry_date: date
    memo: str = Field("", max_length=2000)
    lines: list[JournalLineIn] = Field(min_length=2, max_length=100)


class EntryLineOut(BaseModel):
    account_id: str
    account_code: str
    account_name: str
    debit: str
    credit: str
    description: str


class EntryOut(BaseModel):
    id: str
    company: Company
    number: int
    code: str
    entry_date: date
    memo: str
    source_type: str
    source_id: str | None
    source_code: str | None
    reversal_of_id: str | None
    reversed_by_id: str | None
    total: str
    created_at: datetime | None
    lines: list[EntryLineOut]


class VoidIn(_In):
    void_date: date | None = None
    reason: str = Field("", max_length=1000)
