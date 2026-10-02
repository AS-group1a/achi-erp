"""Accounting rules: the posting engine, the documents that post, and reports.

Every document turns into ONE balanced journal entry in the company's base
currency (see acc_models for the ground rules). Who may do what:

* view and create invoices, receipts and expenses: admin, manager, editor;
* void documents, write manual journals, edit accounts and settings: admin
  and manager;
* always only inside the companies company_access allows.

Postings (base currency, D = debit, C = credit):

    issue invoice     D receivable  total      C income (per line)
                      D discount    discount   C VAT output
    receipt           D bank        amount     C receivable  (allocated part)
                                               C customer deposits (rest)
    later allocation  D customer deposits      C receivable
    expense           D cost/asset  net        C bank  total
                      D VAT input   vat
    void              the same entry with every line flipped, dated the void day

Foreign-currency rounding and rate differences between an invoice and its
payment land on the exchange-differences account, so every entry balances to
the cent and the receivable clears to exactly zero once an invoice is paid.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User

from .acc_models import (
    AchiAccAccount,
    AchiAccAllocation,
    AchiAccEntry,
    AchiAccExpense,
    AchiAccLine,
    AchiAccReceipt,
    AchiAccSettings,
    AchiSalesInvoice,
    AchiSalesInvoiceLine,
)
from .acc_schemas import (
    AccountIn,
    AccountOut,
    AccountUpdate,
    AllocateIn,
    AllocationOut,
    EntryLineOut,
    EntryOut,
    ExpenseIn,
    ExpenseOut,
    InvoiceIn,
    InvoiceLineOut,
    InvoiceOut,
    JournalIn,
    ReceiptIn,
    ReceiptOut,
    SettingsOut,
    SettingsUpdate,
)
from .company_access import active_user, require_company
from .hr_models import COMPANIES
from .models import Quotation, QuotationLine
from .quotation_service import display_quotation_number

logger = logging.getLogger(__name__)

_VIEW_ROLES = frozenset({"admin", "manager", "editor"})
_MANAGE_ROLES = frozenset({"admin", "manager"})
_COMPANY_INDEX = {key: index for index, key in enumerate(COMPANIES)}
# Transaction-scoped advisory locks: numbering and first-time setup per company.
_LOCK_ENTRY = 681_246_110
_LOCK_INVOICE = 681_246_111
_LOCK_RECEIPT = 681_246_112
_LOCK_EXPENSE = 681_246_113
_LOCK_SETUP = 681_246_114
_NORMAL_DEBIT = frozenset({"asset", "expense"})

# The starting chart of accounts. (code, name, type, role, is_bank); names in
# a dict differ per company, everything else is shared.
_CHART: list[tuple[str, str | dict, str, str | None, bool]] = [
    ("1000", "Cash on hand", "asset", None, True),
    ("1010", "Bank account", "asset", None, True),
    ("1100", "Accounts receivable", "asset", "receivable", False),
    ("1200", "VAT recoverable (input VAT)", "asset", "vat_input", False),
    ("1300", "Prepayments and deposits paid", "asset", None, False),
    ("1500", {"achi": "Scaffolding equipment", "arara": "Computer equipment"}, "asset", None, False),
    ("1510", "Vehicles", "asset", None, False),
    ("1590", "Accumulated depreciation", "asset", None, False),
    ("2000", "Accounts payable", "liability", "payable", False),
    ("2100", "VAT payable (output VAT)", "liability", "vat_output", False),
    ("2200", "Customer deposits and advances", "liability", "customer_deposits", False),
    ("2300", "Salaries payable", "liability", None, False),
    ("2400", "Loans", "liability", None, False),
    ("3000", "Owner's capital", "equity", None, False),
    ("3100", "Retained earnings", "equity", "retained_earnings", False),
    ("3200", "Owner's drawings", "equity", None, False),
    ("4000", {"achi": "Scaffolding hire", "arara": "Software development"}, "income", "default_income", False),
    ("4010", {"achi": "Erection and dismantling", "arara": "Subscriptions and licences"}, "income", None, False),
    ("4020", {"achi": "Transport charges", "arara": "Support and maintenance"}, "income", None, False),
    ("4090", "Other income", "income", None, False),
    ("4900", "Sales discounts", "income", "sales_discount", False),
    ("5000", {"achi": "Scaffolding materials and consumables", "arara": "Software and cloud services"}, "expense", None, False),
    ("5100", {"achi": "Site labour and subcontractors", "arara": "Contractors"}, "expense", None, False),
    ("5200", "Transport and fuel", "expense", None, False),
    ("6000", "Salaries and wages", "expense", None, False),
    ("6100", "Rent", "expense", None, False),
    ("6200", "Utilities and internet", "expense", None, False),
    ("6300", "Vehicle running costs", "expense", None, False),
    ("6400", "Repairs and maintenance", "expense", None, False),
    ("6500", "Office and administration", "expense", None, False),
    ("6600", "Insurance", "expense", None, False),
    ("6700", "Bank charges", "expense", None, False),
    ("6800", "Depreciation", "expense", None, False),
    ("6900", "Other expenses", "expense", "default_expense", False),
    ("7000", "Exchange differences", "expense", "fx_difference", False),
]

_DEFAULT_INVOICE_TERMS = (
    "Payment is due by the due date shown. Please quote the invoice number with your payment.\n"
    "Hire continues to be charged until the scaffold is released for dismantling."
)


# ── money ───────────────────────────────────────────────────────────────────

def to_minor(text: str | None) -> int:
    if text in (None, ""):
        return 0
    return int((Decimal(str(text)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def to_major(minor: int | None) -> str:
    return f"{Decimal(minor or 0) / 100:.2f}"


def convert(minor: int, rate: str) -> int:
    """Document currency -> base currency, rounded half up to the cent.

    rate is how people quote it: units of the document's currency for ONE unit
    of base currency ("1 USD = 89,500 LBP" -> 89500; "1 USD = 0.92 EUR" -> 0.92).
    """
    return int((Decimal(minor) / Decimal(rate)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def line_total(quantity: str | None, price_minor: int | None) -> int:
    qty = Decimal(quantity) if quantity else Decimal(0)
    return int((qty * Decimal(price_minor or 0)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def percent_of(minor: int, percent: str | None) -> int:
    pct = Decimal(percent) if percent else Decimal(0)
    return int((Decimal(minor) * pct / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def invoice_totals(line_totals: list[int], discount: int, vat_percent: str | None) -> tuple[int, int, int, int]:
    """(items, subtotal after discount, vat, total). The discount may not exceed the items."""
    items = sum(line_totals)
    if discount > items:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The discount is larger than the items total")
    subtotal = items - discount
    vat = percent_of(subtotal, vat_percent)
    return items, subtotal, vat, subtotal + vat


def code(prefix: str, number: int | None) -> str:
    return f"{prefix}-{int(number or 0):05d}"


def _today() -> date:
    return date.today()


def _now() -> datetime:
    return datetime.now(UTC)


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, message)


def _not_found(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")


class AccountingService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── people, permissions, first-time setup ───────────────────────────────

    async def _user(self, user_id: str, company: str, *, manage: bool = False) -> User:
        user = await active_user(self.session, user_id)
        role = (user.role or "").strip().lower()
        if role not in _VIEW_ROLES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Accounting is open to editors, managers and admins")
        if manage and role not in _MANAGE_ROLES:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only managers and admins can do this in Accounting")
        await require_company(self.session, user, company)
        await self.ensure_company(company)
        return user

    async def access(self, user_id: str, company: str) -> dict:
        user = await self._user(user_id, company)
        role = (user.role or "").strip().lower()
        return {"role": role, "can_manage": role in _MANAGE_ROLES, "company": company,
                "company_name": COMPANIES[company]}

    async def ensure_company(self, company: str) -> None:
        """Seed the chart of accounts and settings the first time a company is used."""
        exists = (await self.session.execute(
            select(AchiAccSettings.id).where(AchiAccSettings.company == company)
        )).scalar()
        if exists:
            return
        await self.session.execute(select(func.pg_advisory_xact_lock(_LOCK_SETUP, _COMPANY_INDEX[company])))
        if (await self.session.execute(
            select(AchiAccSettings.id).where(AchiAccSettings.company == company)
        )).scalar():
            return
        have = set((await self.session.execute(
            select(AchiAccAccount.code).where(AchiAccAccount.company == company)
        )).scalars())
        for acc_code, name, acc_type, role, is_bank in _CHART:
            if acc_code in have:
                continue
            self.session.add(AchiAccAccount(
                company=company, code=acc_code, name=name[company] if isinstance(name, dict) else name,
                type=acc_type, role=role, is_bank=is_bank,
            ))
        self.session.add(AchiAccSettings(
            company=company, legal_name=COMPANIES[company], invoice_terms=_DEFAULT_INVOICE_TERMS,
        ))
        await self.session.commit()
        logger.info("achi: accounting set up for %s", company)

    async def _settings(self, company: str) -> AchiAccSettings:
        row = (await self.session.execute(
            select(AchiAccSettings).where(AchiAccSettings.company == company)
        )).scalar_one()
        return row

    async def _roles(self, company: str) -> dict[str, AchiAccAccount]:
        rows = (await self.session.execute(
            select(AchiAccAccount).where(AchiAccAccount.company == company, AchiAccAccount.role.is_not(None))
        )).scalars().all()
        return {row.role: row for row in rows}

    async def _account(self, company: str, account_id: str | None, *, types: tuple[str, ...] | None = None,
                       bank: bool | None = None, label: str = "Account") -> AchiAccAccount:
        row = await self.session.get(AchiAccAccount, account_id) if account_id else None
        if row is None or row.company != company:
            raise _unprocessable(f"{label}: choose an account of this company")
        if not row.active:
            raise _unprocessable(f"{label}: {row.code} {row.name} is inactive")
        if types and row.type not in types:
            raise _unprocessable(f"{label}: {row.code} {row.name} is not a {' or '.join(types)} account")
        if bank is True and not row.is_bank:
            raise _unprocessable(f"{label}: {row.code} {row.name} is not a cash or bank account")
        if bank is False and row.is_bank:
            raise _unprocessable(f"{label}: choose a cost or asset account, not a cash or bank account")
        return row

    async def _next_number(self, model, lock_key: int, company: str) -> int:
        await self.session.execute(select(func.pg_advisory_xact_lock(lock_key, _COMPANY_INDEX[company])))
        current = (await self.session.execute(
            select(func.max(model.number)).where(model.company == company)
        )).scalar()
        return int(current or 0) + 1

    async def _check_open(self, company: str, day: date) -> None:
        lock = (await self._settings(company)).lock_date
        if lock and day <= lock:
            raise _unprocessable(
                f"The books are closed up to {lock:%d/%m/%Y}. Use a later date, or ask a manager to move the lock date."
            )

    # ── the posting engine ──────────────────────────────────────────────────

    async def _post(self, company: str, user: User, entry_date: date, memo: str, source_type: str,
                    source_id: str | None, lines: list[dict]) -> AchiAccEntry:
        """Write one balanced entry. lines: {account_id, debit, credit, description}."""
        clean = []
        for line in lines:
            net = int(line.get("debit") or 0) - int(line.get("credit") or 0)
            if net:
                clean.append({**line, "debit": max(net, 0), "credit": max(-net, 0)})
        debit = sum(line["debit"] for line in clean)
        credit = sum(line["credit"] for line in clean)
        if debit != credit:
            raise _unprocessable(f"The entry does not balance: debits {to_major(debit)}, credits {to_major(credit)}")
        if not debit:
            raise _unprocessable("There is nothing to post: every amount is zero")
        await self._check_open(company, entry_date)
        entry = AchiAccEntry(
            company=company, number=await self._next_number(AchiAccEntry, _LOCK_ENTRY, company),
            entry_date=entry_date, memo=memo, source_type=source_type, source_id=source_id,
            total_minor=debit, created_by_user_id=str(user.id),
        )
        self.session.add(entry)
        await self.session.flush()
        for position, line in enumerate(clean):
            self.session.add(AchiAccLine(
                entry_id=entry.id, company=company, account_id=line["account_id"], entry_date=entry_date,
                position=position, debit_minor=line["debit"], credit_minor=line["credit"],
                description=line.get("description") or "",
            ))
        return entry

    async def _reverse(self, entry_id: str | None, user: User, day: date, memo: str) -> AchiAccEntry | None:
        if not entry_id:
            return None
        original = await self.session.get(AchiAccEntry, entry_id)
        if original is None or original.reversed_by_id:
            return None
        if day < original.entry_date:
            raise _unprocessable(f"The void date cannot be before the original date ({original.entry_date:%d/%m/%Y})")
        lines = (await self.session.execute(
            select(AchiAccLine).where(AchiAccLine.entry_id == original.id).order_by(AchiAccLine.position)
        )).scalars().all()
        reversal = await self._post(
            original.company, user, day, memo, original.source_type, original.source_id,
            [{"account_id": l.account_id, "debit": l.credit_minor, "credit": l.debit_minor,
              "description": l.description} for l in lines],
        )
        reversal.reversal_of_id = original.id
        original.reversed_by_id = reversal.id
        return reversal

    @staticmethod
    def _balance_with(lines: list[dict], account_id: str, description: str) -> None:
        """Put any imbalance (rounding, rate difference) on one account."""
        diff = sum(l.get("debit", 0) for l in lines) - sum(l.get("credit", 0) for l in lines)
        if diff:
            lines.append({"account_id": account_id, "debit": max(-diff, 0), "credit": max(diff, 0),
                          "description": description})

    # ── settings and accounts ───────────────────────────────────────────────

    async def _has_entries(self, company: str) -> bool:
        return bool((await self.session.execute(
            select(AchiAccEntry.id).where(AchiAccEntry.company == company).limit(1)
        )).scalar())

    async def get_settings(self, user_id: str, company: str) -> SettingsOut:
        await self._user(user_id, company)
        return await self._settings_out(company)

    async def _settings_out(self, company: str) -> SettingsOut:
        s = await self._settings(company)
        return SettingsOut(
            company=company, company_name=COMPANIES[company], base_currency=s.base_currency,
            default_vat_percent=s.default_vat_percent, invoice_due_days=s.invoice_due_days, lock_date=s.lock_date,
            legal_name=s.legal_name, address=s.address, phone=s.phone, email=s.email, tax_number=s.tax_number,
            bank_details=s.bank_details, invoice_terms=s.invoice_terms, has_entries=await self._has_entries(company),
        )

    async def update_settings(self, user_id: str, company: str, data: SettingsUpdate) -> SettingsOut:
        await self._user(user_id, company, manage=True)
        s = await self._settings(company)
        changes = data.model_dump(exclude_unset=True)
        if "base_currency" in changes and changes["base_currency"] != s.base_currency:
            if await self._has_entries(company):
                raise _unprocessable("The base currency cannot change once something has been posted")
        for key, value in changes.items():
            if value is None and key not in {"lock_date"}:
                continue
            setattr(s, key, value)
        await self.session.commit()
        return await self._settings_out(company)

    async def _balances(self, company: str, *, date_from: date | None = None,
                        date_to: date | None = None) -> dict[str, tuple[int, int]]:
        query = select(
            AchiAccLine.account_id, func.coalesce(func.sum(AchiAccLine.debit_minor), 0),
            func.coalesce(func.sum(AchiAccLine.credit_minor), 0),
        ).where(AchiAccLine.company == company)
        if date_from:
            query = query.where(AchiAccLine.entry_date >= date_from)
        if date_to:
            query = query.where(AchiAccLine.entry_date <= date_to)
        rows = (await self.session.execute(query.group_by(AchiAccLine.account_id))).all()
        return {account_id: (int(d), int(c)) for account_id, d, c in rows}

    @staticmethod
    def _natural(acc_type: str, debit: int, credit: int) -> int:
        return debit - credit if acc_type in _NORMAL_DEBIT else credit - debit

    def _account_out(self, row: AchiAccAccount, sums: dict[str, tuple[int, int]]) -> AccountOut:
        d, c = sums.get(row.id, (0, 0))
        return AccountOut(
            id=row.id, company=row.company, code=row.code, name=row.name, type=row.type, role=row.role,
            is_bank=row.is_bank, active=row.active, description=row.description,
            balance=to_major(self._natural(row.type, d, c)), has_entries=row.id in sums,
        )

    async def list_accounts(self, user_id: str, company: str) -> list[AccountOut]:
        await self._user(user_id, company)
        rows = (await self.session.execute(
            select(AchiAccAccount).where(AchiAccAccount.company == company).order_by(AchiAccAccount.code)
        )).scalars().all()
        sums = await self._balances(company)
        return [self._account_out(row, sums) for row in rows]

    async def _code_free(self, company: str, acc_code: str, except_id: str | None = None) -> None:
        query = select(AchiAccAccount.id).where(AchiAccAccount.company == company, AchiAccAccount.code == acc_code)
        if except_id:
            query = query.where(AchiAccAccount.id != except_id)
        if (await self.session.execute(query)).scalar():
            raise HTTPException(status.HTTP_409_CONFLICT, f"Account code {acc_code} is already used")

    async def create_account(self, user_id: str, data: AccountIn) -> AccountOut:
        await self._user(user_id, data.company, manage=True)
        await self._code_free(data.company, data.code)
        row = AchiAccAccount(**data.model_dump())
        self.session.add(row)
        await self.session.commit()
        return self._account_out(row, {})

    async def update_account(self, user_id: str, account_id: str, data: AccountUpdate) -> AccountOut:
        row = await self.session.get(AchiAccAccount, account_id)
        if row is None:
            raise _not_found("Account")
        await self._user(user_id, row.company, manage=True)
        changes = {k: v for k, v in data.model_dump(exclude_unset=True).items() if v is not None}
        sums = await self._balances(row.company)
        used = row.id in sums
        if "code" in changes:
            await self._code_free(row.company, changes["code"], row.id)
        if "type" in changes and changes["type"] != row.type and (used or row.role):
            raise _unprocessable("The type of an account that has postings or a system role cannot change")
        if changes.get("active") is False and row.role:
            raise _unprocessable("This account is used by automatic postings and cannot be deactivated")
        is_bank = changes.get("is_bank", row.is_bank)
        if is_bank and changes.get("type", row.type) != "asset":
            raise _unprocessable("A cash or bank account must be an asset account")
        for key, value in changes.items():
            setattr(row, key, value)
        await self.session.commit()
        return self._account_out(row, sums)

    async def delete_account(self, user_id: str, account_id: str) -> None:
        row = await self.session.get(AchiAccAccount, account_id)
        if row is None:
            raise _not_found("Account")
        await self._user(user_id, row.company, manage=True)
        if row.role:
            raise _unprocessable("This account is used by automatic postings and cannot be deleted")
        used = (await self.session.execute(
            select(AchiAccLine.id).where(AchiAccLine.account_id == row.id).limit(1)
        )).scalar()
        referenced = used or (await self.session.execute(
            select(AchiAccExpense.id).where(or_(AchiAccExpense.account_id == row.id,
                                                AchiAccExpense.paid_from_account_id == row.id)).limit(1)
        )).scalar() or (await self.session.execute(
            select(AchiAccReceipt.id).where(AchiAccReceipt.deposit_account_id == row.id).limit(1)
        )).scalar() or (await self.session.execute(
            select(AchiSalesInvoiceLine.id).where(AchiSalesInvoiceLine.account_id == row.id).limit(1)
        )).scalar()
        if referenced:
            raise HTTPException(status.HTTP_409_CONFLICT, "This account has been used. Deactivate it instead of deleting it")
        await self.session.delete(row)
        await self.session.commit()

    # ── invoices ────────────────────────────────────────────────────────────

    async def _invoice(self, invoice_id: str, *, lock: bool = False) -> AchiSalesInvoice:
        query = select(AchiSalesInvoice).where(AchiSalesInvoice.id == invoice_id)
        if lock:
            query = query.with_for_update()
        row = (await self.session.execute(query)).scalar_one_or_none()
        if row is None:
            raise _not_found("Invoice")
        return row

    async def _invoice_lines(self, invoice_id: str) -> list[AchiSalesInvoiceLine]:
        return list((await self.session.execute(
            select(AchiSalesInvoiceLine).where(AchiSalesInvoiceLine.invoice_id == invoice_id)
            .order_by(AchiSalesInvoiceLine.position)
        )).scalars().all())

    @staticmethod
    def payment_status(inv: AchiSalesInvoice, today: date | None = None) -> str:
        if inv.status in ("draft", "void"):
            return inv.status
        if inv.paid_minor >= inv.total_minor:
            return "paid"
        if inv.due_date and inv.due_date < (today or _today()):
            return "overdue"
        return "partly_paid" if inv.paid_minor else "unpaid"

    async def _allocations_out(self, *, invoice_ids: list[str] | None = None,
                               receipt_ids: list[str] | None = None) -> list[AllocationOut]:
        query = (
            select(AchiAccAllocation, AchiAccReceipt, AchiSalesInvoice.number)
            .join(AchiAccReceipt, AchiAccReceipt.id == AchiAccAllocation.receipt_id)
            .join(AchiSalesInvoice, AchiSalesInvoice.id == AchiAccAllocation.invoice_id)
            .where(AchiAccAllocation.active.is_(True))
        )
        if invoice_ids is not None:
            query = query.where(AchiAccAllocation.invoice_id.in_(invoice_ids or [""]))
        if receipt_ids is not None:
            query = query.where(AchiAccAllocation.receipt_id.in_(receipt_ids or [""]))
        rows = (await self.session.execute(query.order_by(AchiAccAllocation.allocation_date))).all()
        return [
            AllocationOut(
                id=a.id, receipt_id=r.id, receipt_code=code("RCT", r.number), invoice_id=a.invoice_id,
                invoice_code=code("INV", inv_number), date=a.allocation_date, amount=to_major(a.amount_minor),
                method=r.method, reference=r.reference,
            )
            for a, r, inv_number in rows
        ]

    async def _invoice_out(self, inv: AchiSalesInvoice, *, full: bool = True,
                           quotation_codes: dict[str, str] | None = None) -> InvoiceOut:
        lines = payments = None
        if full:
            lines = [
                InvoiceLineOut(
                    id=l.id, position=l.position, item=l.item, description=l.description,
                    start_date=l.start_date, end_date=l.end_date, unit=l.unit, quantity=l.quantity,
                    unit_price=to_major(l.unit_price_minor) if l.unit_price_minor is not None else None,
                    total=to_major(l.line_total_minor), account_id=l.account_id,
                )
                for l in await self._invoice_lines(inv.id)
            ]
            payments = await self._allocations_out(invoice_ids=[inv.id])
        quotation_code = None
        if inv.quotation_id:
            if quotation_codes is not None:
                quotation_code = quotation_codes.get(inv.quotation_id)
            else:
                q = await self.session.get(Quotation, inv.quotation_id)
                quotation_code = display_quotation_number(q.quotation_number) if q else None
        return InvoiceOut(
            id=inv.id, company=inv.company, number=inv.number, code=code("INV", inv.number), status=inv.status,
            payment_status=self.payment_status(inv), quotation_id=inv.quotation_id, quotation_code=quotation_code,
            file_id=inv.file_id, contact_id=inv.contact_id, customer_name=inv.customer_name,
            customer_company=inv.customer_company, customer_mobile=inv.customer_mobile,
            customer_email=inv.customer_email, customer_address=inv.customer_address,
            customer_tax_number=inv.customer_tax_number, subject=inv.subject, issue_date=inv.issue_date,
            due_date=inv.due_date, currency=inv.currency, fx_rate=inv.fx_rate,
            discount=to_major(inv.discount_minor), vat_percent=inv.vat_percent,
            items_total=to_major(inv.items_minor), subtotal=to_major(inv.subtotal_minor),
            vat=to_major(inv.vat_minor), total=to_major(inv.total_minor), paid=to_major(inv.paid_minor),
            balance=to_major(inv.total_minor - inv.paid_minor if inv.status == "issued" else 0),
            notes=inv.notes, terms=inv.terms, entry_id=inv.entry_id, issued_at=inv.issued_at,
            created_at=inv.created_at, lines=lines, payments=payments,
        )

    async def _set_invoice_content(self, inv: AchiSalesInvoice, data: InvoiceIn) -> None:
        """Copy a draft's fields and lines from the editor, and recompute totals."""
        income_ids = {l.account_id for l in data.lines if l.account_id}
        for account_id in income_ids:
            await self._account(inv.company, account_id, types=("income",), label="Line account")
        fields = data.model_dump(exclude={"company", "lines", "discount"})
        for key, value in fields.items():
            setattr(inv, key, value)
        inv.vat_percent = data.vat_percent or "0"
        inv.discount_minor = to_minor(data.discount)
        await self.session.execute(
            AchiSalesInvoiceLine.__table__.delete().where(AchiSalesInvoiceLine.invoice_id == inv.id)
        )
        totals = []
        for position, line in enumerate(data.lines):
            price = to_minor(line.unit_price) if line.unit_price is not None else None
            total = line_total(line.quantity, price)
            totals.append(total)
            self.session.add(AchiSalesInvoiceLine(
                invoice_id=inv.id, position=position, item=line.item, description=line.description,
                start_date=line.start_date, end_date=line.end_date, unit=line.unit, quantity=line.quantity,
                unit_price_minor=price, line_total_minor=total, account_id=line.account_id,
            ))
        inv.items_minor, inv.subtotal_minor, inv.vat_minor, inv.total_minor = invoice_totals(
            totals, inv.discount_minor, inv.vat_percent,
        )

    async def list_invoices(self, user_id: str, company: str, *, state: str | None = None, q: str | None = None,
                            quotation_id: str | None = None, date_from: date | None = None,
                            date_to: date | None = None, limit: int = 500) -> list[InvoiceOut]:
        await self._user(user_id, company)
        query = select(AchiSalesInvoice).where(AchiSalesInvoice.company == company)
        today = _today()
        open_ = and_(AchiSalesInvoice.status == "issued", AchiSalesInvoice.paid_minor < AchiSalesInvoice.total_minor)
        if state in ("draft", "issued", "void"):
            query = query.where(AchiSalesInvoice.status == state)
        elif state == "unpaid":
            query = query.where(open_)
        elif state == "overdue":
            query = query.where(open_, AchiSalesInvoice.due_date < today)
        elif state == "paid":
            query = query.where(AchiSalesInvoice.status == "issued",
                                AchiSalesInvoice.paid_minor >= AchiSalesInvoice.total_minor)
        if quotation_id:
            query = query.where(AchiSalesInvoice.quotation_id == quotation_id)
        if date_from:
            query = query.where(AchiSalesInvoice.issue_date >= date_from)
        if date_to:
            query = query.where(AchiSalesInvoice.issue_date <= date_to)
        if q:
            like = f"%{q.strip().lower()}%"
            digits = "".join(ch for ch in q if ch.isdigit())
            conds = [func.lower(AchiSalesInvoice.customer_name).like(like),
                     func.lower(AchiSalesInvoice.customer_company).like(like),
                     func.lower(AchiSalesInvoice.subject).like(like)]
            if digits:
                conds.append(AchiSalesInvoice.number == int(digits))
            query = query.where(or_(*conds))
        rows = (await self.session.execute(
            query.order_by(AchiSalesInvoice.issue_date.desc(), AchiSalesInvoice.number.desc()).limit(limit)
        )).scalars().all()
        qids = {r.quotation_id for r in rows if r.quotation_id}
        qcodes = {}
        if qids:
            qcodes = {qid: display_quotation_number(num) for qid, num in (await self.session.execute(
                select(Quotation.id, Quotation.quotation_number).where(Quotation.id.in_(qids))
            )).all()}
        return [await self._invoice_out(r, full=False, quotation_codes=qcodes) for r in rows]

    async def get_invoice(self, user_id: str, invoice_id: str) -> InvoiceOut:
        inv = await self._invoice(invoice_id)
        await self._user(user_id, inv.company)
        return await self._invoice_out(inv)

    async def create_invoice(self, user_id: str, data: InvoiceIn, *, quotation_id: str | None = None,
                             file_id: str | None = None) -> InvoiceOut:
        user = await self._user(user_id, data.company)
        inv = AchiSalesInvoice(
            company=data.company, number=await self._next_number(AchiSalesInvoice, _LOCK_INVOICE, data.company),
            status="draft", quotation_id=quotation_id, file_id=file_id, issue_date=data.issue_date,
            created_by_user_id=str(user.id),
        )
        self.session.add(inv)
        await self.session.flush()
        await self._set_invoice_content(inv, data)
        await self.session.commit()
        return await self._invoice_out(inv)

    async def update_invoice(self, user_id: str, invoice_id: str, data: InvoiceIn) -> InvoiceOut:
        inv = await self._invoice(invoice_id, lock=True)
        await self._user(user_id, inv.company)
        if data.company != inv.company:
            raise _unprocessable("An invoice cannot move to another company")
        if inv.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "Only draft invoices can be edited. Void this one and issue a new invoice to change it")
        await self._set_invoice_content(inv, data)
        await self.session.commit()
        return await self._invoice_out(inv)

    async def delete_invoice(self, user_id: str, invoice_id: str) -> None:
        inv = await self._invoice(invoice_id, lock=True)
        await self._user(user_id, inv.company)
        if inv.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "Only drafts can be deleted. Void an issued invoice instead")
        await self.session.delete(inv)
        await self.session.commit()

    async def issue_invoice(self, user_id: str, invoice_id: str) -> InvoiceOut:
        inv = await self._invoice(invoice_id, lock=True)
        user = await self._user(user_id, inv.company)
        if inv.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "This invoice has already been issued")
        lines = await self._invoice_lines(inv.id)
        if not lines or inv.total_minor <= 0:
            raise _unprocessable("Add at least one line with an amount before issuing")
        if not (inv.customer_name or inv.customer_company):
            raise _unprocessable("Enter the customer's name or company before issuing")
        settings = await self._settings(inv.company)
        if inv.currency != settings.base_currency and Decimal(inv.fx_rate) == 1:
            raise _unprocessable(
                f"This invoice is in {inv.currency}: set the exchange rate to {settings.base_currency} before issuing"
            )
        if inv.currency == settings.base_currency and Decimal(inv.fx_rate) != 1:
            inv.fx_rate = "1"
        roles = await self._roles(inv.company)
        rate = inv.fx_rate
        number = code("INV", inv.number)
        who = inv.customer_company or inv.customer_name
        income: dict[str, int] = defaultdict(int)
        for line in lines:
            income[line.account_id or roles["default_income"].id] += convert(line.line_total_minor, rate)
        posting = [{"account_id": roles["receivable"].id, "debit": convert(inv.total_minor, rate),
                    "description": f"{number} {who}"}]
        if inv.discount_minor:
            posting.append({"account_id": roles["sales_discount"].id, "debit": convert(inv.discount_minor, rate),
                            "description": f"{number} discount"})
        if inv.vat_minor:
            posting.append({"account_id": roles["vat_output"].id, "credit": convert(inv.vat_minor, rate),
                            "description": f"{number} VAT {inv.vat_percent}%"})
        income_lines = [{"account_id": acc, "credit": amount, "description": f"{number} {who}"}
                        for acc, amount in income.items()]
        # Rounding from conversion goes on the largest income line, not a separate account.
        diff = sum(l.get("debit", 0) for l in posting) - sum(l.get("credit", 0) for l in posting) \
            - sum(l["credit"] for l in income_lines)
        max(income_lines, key=lambda l: l["credit"])["credit"] += diff
        entry = await self._post(inv.company, user, inv.issue_date, f"Invoice {number} — {who}", "invoice",
                                 inv.id, posting + income_lines)
        inv.status = "issued"
        inv.entry_id = entry.id
        inv.issued_at = _now()
        if inv.quotation_id:
            q = await self.session.get(Quotation, inv.quotation_id)
            if q is not None and q.status in ("draft", "sent"):
                q.status = "accepted"
        await self.session.commit()
        return await self._invoice_out(inv)

    async def void_invoice(self, user_id: str, invoice_id: str, day: date | None, reason: str) -> InvoiceOut:
        inv = await self._invoice(invoice_id, lock=True)
        user = await self._user(user_id, inv.company, manage=True)
        if inv.status != "issued":
            raise HTTPException(status.HTTP_409_CONFLICT, "Only an issued invoice can be voided")
        if inv.paid_minor:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "This invoice has payments. Void those receipts first, then void the invoice")
        await self._reverse(inv.entry_id, user, day or _today(),
                            f"Void of invoice {code('INV', inv.number)}" + (f" — {reason}" if reason else ""))
        inv.status = "void"
        inv.voided_at = _now()
        await self.session.commit()
        return await self._invoice_out(inv)

    async def invoice_from_quotation(self, user_id: str, quotation_id: str) -> InvoiceOut:
        """A draft invoice copied from a quotation (Quotations belong to Achi Scaffolding)."""
        company = "achi"
        await self._user(user_id, company)
        q = await self.session.get(Quotation, quotation_id)
        if q is None:
            raise _not_found("Quotation")
        settings = await self._settings(company)
        qcode = display_quotation_number(q.quotation_number)
        lines = (await self.session.execute(
            select(QuotationLine).where(QuotationLine.quotation_id == q.id).order_by(QuotationLine.position)
        )).scalars().all()
        line_in = [
            {"item": l.item, "description": l.description, "start_date": l.start_date, "end_date": l.end_date,
             "unit": l.unit, "quantity": l.quantity,
             "unit_price": to_major(l.unit_price_minor) if l.unit_price_minor is not None else None}
            for l in lines
        ]
        discount = q.discount_minor or 0
        if not line_in and (q.subtotal_minor or 0) > 0:
            # Drafted from the Log as one estimate: invoice it as one line.
            line_in = [{"item": "Scaffolding works", "description": f"As per quotation {qcode}",
                        "unit": "lot", "quantity": "1", "unit_price": to_major(q.subtotal_minor + discount)}]
        currency = q.currency if q.currency in ("USD", "EUR", "LBP") else settings.base_currency
        site = ", ".join(p for p in (q.site_address, q.site_city) if p)
        try:
            data = self._quotation_invoice(q, qcode, company, settings, line_in, discount, currency, site)
        except ValidationError as exc:
            first = exc.errors()[0]
            raise _unprocessable(f"Quotation {qcode} cannot be invoiced as it is: {first['msg']}") from None
        return await self.create_invoice(user_id, data, quotation_id=q.id, file_id=q.file_id)

    @staticmethod
    def _quotation_invoice(q, qcode, company, settings, line_in, discount, currency, site) -> InvoiceIn:
        today = _today()
        return InvoiceIn(
            company=company, customer_name=q.customer_name or "", customer_company=q.customer_company or "",
            customer_mobile=q.customer_mobile or "", customer_email=q.customer_email or "",
            contact_id=q.contact_id, subject=q.scope or f"As per quotation {qcode}", issue_date=today,
            due_date=today + timedelta(days=settings.invoice_due_days), currency=currency, fx_rate="1",
            discount=to_major(discount) if discount else None,
            vat_percent=q.vat_percent or settings.default_vat_percent,
            notes="\n".join(p for p in (f"Quotation {qcode}", f"Site: {site}" if site else "") if p),
            terms=settings.invoice_terms, lines=line_in,
        )

    # ── receipts ────────────────────────────────────────────────────────────

    async def _receipt(self, receipt_id: str, *, lock: bool = False) -> AchiAccReceipt:
        query = select(AchiAccReceipt).where(AchiAccReceipt.id == receipt_id)
        if lock:
            query = query.with_for_update()
        row = (await self.session.execute(query)).scalar_one_or_none()
        if row is None:
            raise _not_found("Receipt")
        return row

    async def _receipt_out(self, r: AchiAccReceipt, names: dict[str, str] | None = None) -> ReceiptOut:
        if names is None:
            acc = await self.session.get(AchiAccAccount, r.deposit_account_id)
            names = {r.deposit_account_id: f"{acc.code} {acc.name}" if acc else ""}
        return ReceiptOut(
            id=r.id, company=r.company, number=r.number, code=code("RCT", r.number), status=r.status,
            receipt_date=r.receipt_date, contact_id=r.contact_id, customer_name=r.customer_name,
            customer_company=r.customer_company, method=r.method, reference=r.reference,
            deposit_account_id=r.deposit_account_id, deposit_account_name=names.get(r.deposit_account_id, ""),
            currency=r.currency, fx_rate=r.fx_rate, amount=to_major(r.amount_minor),
            allocated=to_major(r.allocated_minor),
            unallocated=to_major(r.amount_minor - r.allocated_minor if r.status == "posted" else 0),
            notes=r.notes, entry_id=r.entry_id, created_at=r.created_at,
            allocations=await self._allocations_out(receipt_ids=[r.id]),
        )

    async def _ar_credits(self, receipt: AchiAccReceipt, allocations, day: date, roles) -> tuple[list[dict], int]:
        """Apply allocations to invoices; return the receivable credit lines and the amount allocated.

        Each credit is what moves that invoice's receivable to its new balance
        in base currency, so a fully paid invoice clears to exactly zero."""
        lines, allocated = [], 0
        for alloc in allocations:
            inv = await self._invoice(alloc.invoice_id, lock=True)
            label = code("INV", inv.number)
            if inv.company != receipt.company:
                raise _unprocessable(f"{label} belongs to another company")
            if inv.status != "issued":
                raise _unprocessable(f"{label} is not an issued invoice")
            if inv.currency != receipt.currency:
                raise _unprocessable(f"{label} is in {inv.currency}; this receipt is in {receipt.currency}")
            amount = to_minor(alloc.amount)
            if amount > inv.total_minor - inv.paid_minor:
                raise _unprocessable(
                    f"{label}: {to_major(amount)} is more than its balance of {to_major(inv.total_minor - inv.paid_minor)}"
                )
            credited = int((await self.session.execute(
                select(func.coalesce(func.sum(AchiAccAllocation.base_minor), 0)).where(
                    AchiAccAllocation.invoice_id == inv.id, AchiAccAllocation.active.is_(True))
            )).scalar())
            base = convert(inv.paid_minor + amount, inv.fx_rate) - credited
            inv.paid_minor += amount
            allocated += amount
            row = AchiAccAllocation(company=receipt.company, receipt_id=receipt.id, invoice_id=inv.id,
                                    amount_minor=amount, base_minor=base, allocation_date=day)
            self.session.add(row)
            lines.append({"account_id": roles["receivable"].id, "credit": base,
                          "description": f"{code('RCT', receipt.number)} → {label}", "_row": row})
            await self.session.flush()
        return lines, allocated

    async def create_receipt(self, user_id: str, data: ReceiptIn) -> ReceiptOut:
        user = await self._user(user_id, data.company)
        deposit = await self._account(data.company, data.deposit_account_id, types=("asset",), bank=True,
                                      label="Received into")
        settings = await self._settings(data.company)
        rate = "1" if data.currency == settings.base_currency else data.fx_rate
        if data.currency != settings.base_currency and Decimal(rate) == 1:
            raise _unprocessable(f"Set the exchange rate from {data.currency} to {settings.base_currency}")
        ids = [a.invoice_id for a in data.allocations]
        if len(ids) != len(set(ids)):
            raise _unprocessable("The same invoice is listed twice")
        amount = to_minor(data.amount)
        r = AchiAccReceipt(
            company=data.company, number=await self._next_number(AchiAccReceipt, _LOCK_RECEIPT, data.company),
            receipt_date=data.receipt_date, contact_id=data.contact_id, customer_name=data.customer_name,
            customer_company=data.customer_company, method=data.method, reference=data.reference,
            deposit_account_id=deposit.id, currency=data.currency, fx_rate=rate, amount_minor=amount,
            notes=data.notes, created_by_user_id=str(user.id),
        )
        self.session.add(r)
        await self.session.flush()
        roles = await self._roles(data.company)
        ar_lines, allocated = await self._ar_credits(r, data.allocations, data.receipt_date, roles)
        if allocated > amount:
            raise _unprocessable(f"The allocations ({to_major(allocated)}) are more than the amount received")
        r.allocated_minor = allocated
        rct = code("RCT", r.number)
        who = data.customer_company or data.customer_name
        lines = [{"account_id": deposit.id, "debit": convert(amount, rate), "description": f"{rct} {who}"}]
        lines += [{k: v for k, v in l.items() if k != "_row"} for l in ar_lines]
        if amount - allocated:
            lines.append({"account_id": roles["customer_deposits"].id, "credit": convert(amount - allocated, rate),
                          "description": f"{rct} not yet allocated"})
        self._balance_with(lines, roles["fx_difference"].id, f"{rct} exchange difference")
        entry = await self._post(data.company, user, data.receipt_date, f"Receipt {rct} — {who}", "receipt", r.id, lines)
        r.entry_id = entry.id
        await self.session.commit()
        return await self._receipt_out(r)

    async def allocate_receipt(self, user_id: str, receipt_id: str, data: AllocateIn) -> ReceiptOut:
        r = await self._receipt(receipt_id, lock=True)
        user = await self._user(user_id, r.company)
        if r.status != "posted":
            raise HTTPException(status.HTTP_409_CONFLICT, "This receipt is void")
        if data.allocation_date < r.receipt_date:
            raise _unprocessable("A payment cannot be applied before it was received")
        roles = await self._roles(r.company)
        before = r.amount_minor - r.allocated_minor
        ar_lines, allocated = await self._ar_credits(r, data.allocations, data.allocation_date, roles)
        if allocated > before:
            raise _unprocessable(f"Only {to_major(before)} of this receipt is not yet allocated")
        r.allocated_minor += allocated
        rct = code("RCT", r.number)
        lines = [{"account_id": roles["customer_deposits"].id,
                  "debit": convert(before, r.fx_rate) - convert(before - allocated, r.fx_rate),
                  "description": f"{rct} applied"}]
        lines += [{k: v for k, v in l.items() if k != "_row"} for l in ar_lines]
        self._balance_with(lines, roles["fx_difference"].id, f"{rct} exchange difference")
        entry = await self._post(r.company, user, data.allocation_date, f"Receipt {rct} applied to invoices",
                                 "allocation", r.id, lines)
        for l in ar_lines:
            l["_row"].entry_id = entry.id
        await self.session.commit()
        return await self._receipt_out(r)

    async def void_receipt(self, user_id: str, receipt_id: str, day: date | None, reason: str) -> ReceiptOut:
        r = await self._receipt(receipt_id, lock=True)
        user = await self._user(user_id, r.company, manage=True)
        if r.status != "posted":
            raise HTTPException(status.HTTP_409_CONFLICT, "This receipt is already void")
        day = day or _today()
        memo = f"Void of receipt {code('RCT', r.number)}" + (f" — {reason}" if reason else "")
        allocations = (await self.session.execute(
            select(AchiAccAllocation).where(AchiAccAllocation.receipt_id == r.id, AchiAccAllocation.active.is_(True))
        )).scalars().all()
        for entry_id in {a.entry_id for a in allocations if a.entry_id}:
            await self._reverse(entry_id, user, day, memo)
        await self._reverse(r.entry_id, user, day, memo)
        for a in allocations:
            inv = await self._invoice(a.invoice_id, lock=True)
            inv.paid_minor -= a.amount_minor
            a.active = False
        r.status = "void"
        r.voided_at = _now()
        await self.session.commit()
        return await self._receipt_out(r)

    async def list_receipts(self, user_id: str, company: str, *, q: str | None = None,
                            date_from: date | None = None, date_to: date | None = None,
                            limit: int = 500) -> list[ReceiptOut]:
        await self._user(user_id, company)
        query = select(AchiAccReceipt).where(AchiAccReceipt.company == company)
        if date_from:
            query = query.where(AchiAccReceipt.receipt_date >= date_from)
        if date_to:
            query = query.where(AchiAccReceipt.receipt_date <= date_to)
        if q:
            like = f"%{q.strip().lower()}%"
            query = query.where(or_(func.lower(AchiAccReceipt.customer_name).like(like),
                                    func.lower(AchiAccReceipt.customer_company).like(like),
                                    func.lower(AchiAccReceipt.reference).like(like)))
        rows = (await self.session.execute(
            query.order_by(AchiAccReceipt.receipt_date.desc(), AchiAccReceipt.number.desc()).limit(limit)
        )).scalars().all()
        names = await self._account_names(company)
        return [await self._receipt_out(r, names) for r in rows]

    async def get_receipt(self, user_id: str, receipt_id: str) -> ReceiptOut:
        r = await self._receipt(receipt_id)
        await self._user(user_id, r.company)
        return await self._receipt_out(r)

    async def _account_names(self, company: str) -> dict[str, str]:
        return {i: f"{c} {n}" for i, c, n in (await self.session.execute(
            select(AchiAccAccount.id, AchiAccAccount.code, AchiAccAccount.name).where(AchiAccAccount.company == company)
        )).all()}

    # ── expenses ────────────────────────────────────────────────────────────

    def _expense_out(self, e: AchiAccExpense, names: dict[str, str]) -> ExpenseOut:
        return ExpenseOut(
            id=e.id, company=e.company, number=e.number, code=code("EXP", e.number), status=e.status,
            expense_date=e.expense_date, supplier=e.supplier, description=e.description, reference=e.reference,
            account_id=e.account_id, account_name=names.get(e.account_id, ""),
            paid_from_account_id=e.paid_from_account_id, paid_from_name=names.get(e.paid_from_account_id, ""),
            method=e.method, currency=e.currency, fx_rate=e.fx_rate, amount=to_major(e.amount_minor),
            vat_percent=e.vat_percent, vat=to_major(e.vat_minor), total=to_major(e.total_minor),
            entry_id=e.entry_id, created_at=e.created_at,
        )

    async def create_expense(self, user_id: str, data: ExpenseIn) -> ExpenseOut:
        user = await self._user(user_id, data.company)
        account = await self._account(data.company, data.account_id, types=("expense", "asset"), bank=False,
                                      label="Expense account")
        paid_from = await self._account(data.company, data.paid_from_account_id, types=("asset",), bank=True,
                                        label="Paid from")
        settings = await self._settings(data.company)
        rate = "1" if data.currency == settings.base_currency else data.fx_rate
        if data.currency != settings.base_currency and Decimal(rate) == 1:
            raise _unprocessable(f"Set the exchange rate from {data.currency} to {settings.base_currency}")
        amount = to_minor(data.amount)
        vat = percent_of(amount, data.vat_percent)
        e = AchiAccExpense(
            company=data.company, number=await self._next_number(AchiAccExpense, _LOCK_EXPENSE, data.company),
            expense_date=data.expense_date, supplier=data.supplier, description=data.description,
            reference=data.reference, account_id=account.id, paid_from_account_id=paid_from.id, method=data.method,
            currency=data.currency, fx_rate=rate, amount_minor=amount, vat_percent=data.vat_percent or "0",
            vat_minor=vat, total_minor=amount + vat, created_by_user_id=str(user.id),
        )
        self.session.add(e)
        await self.session.flush()
        roles = await self._roles(data.company)
        exp = code("EXP", e.number)
        what = data.supplier or data.description[:80]
        total_base = convert(e.total_minor, rate)
        vat_base = convert(vat, rate)
        lines = [
            {"account_id": account.id, "debit": total_base - vat_base, "description": f"{exp} {what}"},
            {"account_id": roles["vat_input"].id, "debit": vat_base, "description": f"{exp} VAT {e.vat_percent}%"},
            {"account_id": paid_from.id, "credit": total_base, "description": f"{exp} {what}"},
        ]
        entry = await self._post(data.company, user, data.expense_date, f"Expense {exp} — {what}", "expense", e.id, lines)
        e.entry_id = entry.id
        await self.session.commit()
        return self._expense_out(e, await self._account_names(data.company))

    async def void_expense(self, user_id: str, expense_id: str, day: date | None, reason: str) -> ExpenseOut:
        e = (await self.session.execute(
            select(AchiAccExpense).where(AchiAccExpense.id == expense_id).with_for_update()
        )).scalar_one_or_none()
        if e is None:
            raise _not_found("Expense")
        user = await self._user(user_id, e.company, manage=True)
        if e.status != "posted":
            raise HTTPException(status.HTTP_409_CONFLICT, "This expense is already void")
        await self._reverse(e.entry_id, user, day or _today(),
                            f"Void of expense {code('EXP', e.number)}" + (f" — {reason}" if reason else ""))
        e.status = "void"
        e.voided_at = _now()
        await self.session.commit()
        return self._expense_out(e, await self._account_names(e.company))

    async def list_expenses(self, user_id: str, company: str, *, q: str | None = None,
                            account_id: str | None = None, date_from: date | None = None,
                            date_to: date | None = None, limit: int = 500) -> list[ExpenseOut]:
        await self._user(user_id, company)
        query = select(AchiAccExpense).where(AchiAccExpense.company == company)
        if account_id:
            query = query.where(AchiAccExpense.account_id == account_id)
        if date_from:
            query = query.where(AchiAccExpense.expense_date >= date_from)
        if date_to:
            query = query.where(AchiAccExpense.expense_date <= date_to)
        if q:
            like = f"%{q.strip().lower()}%"
            query = query.where(or_(func.lower(AchiAccExpense.supplier).like(like),
                                    func.lower(AchiAccExpense.description).like(like),
                                    func.lower(AchiAccExpense.reference).like(like)))
        rows = (await self.session.execute(
            query.order_by(AchiAccExpense.expense_date.desc(), AchiAccExpense.number.desc()).limit(limit)
        )).scalars().all()
        names = await self._account_names(company)
        return [self._expense_out(e, names) for e in rows]

    # ── journal ─────────────────────────────────────────────────────────────

    async def _source_codes(self, entries: list[AchiAccEntry]) -> dict[str, str]:
        by_type: dict[str, set[str]] = defaultdict(set)
        for e in entries:
            if e.source_id:
                by_type[e.source_type].add(e.source_id)
        out: dict[str, str] = {}
        for source_type, model, prefix in (("invoice", AchiSalesInvoice, "INV"), ("receipt", AchiAccReceipt, "RCT"),
                                           ("allocation", AchiAccReceipt, "RCT"), ("expense", AchiAccExpense, "EXP")):
            ids = by_type.get(source_type)
            if ids:
                for row_id, number in (await self.session.execute(
                    select(model.id, model.number).where(model.id.in_(ids))
                )).all():
                    out[row_id] = code(prefix, number)
        return out

    async def _entries_out(self, entries: list[AchiAccEntry]) -> list[EntryOut]:
        if not entries:
            return []
        ids = [e.id for e in entries]
        lines = (await self.session.execute(
            select(AchiAccLine, AchiAccAccount.code, AchiAccAccount.name)
            .join(AchiAccAccount, AchiAccAccount.id == AchiAccLine.account_id)
            .where(AchiAccLine.entry_id.in_(ids)).order_by(AchiAccLine.position)
        )).all()
        grouped: dict[str, list[EntryLineOut]] = defaultdict(list)
        for line, acc_code, acc_name in lines:
            grouped[line.entry_id].append(EntryLineOut(
                account_id=line.account_id, account_code=acc_code, account_name=acc_name,
                debit=to_major(line.debit_minor), credit=to_major(line.credit_minor), description=line.description,
            ))
        sources = await self._source_codes(entries)
        return [
            EntryOut(
                id=e.id, company=e.company, number=e.number, code=code("JE", e.number), entry_date=e.entry_date,
                memo=e.memo, source_type=e.source_type, source_id=e.source_id,
                source_code=sources.get(e.source_id or ""), reversal_of_id=e.reversal_of_id,
                reversed_by_id=e.reversed_by_id, total=to_major(e.total_minor), created_at=e.created_at,
                lines=grouped.get(e.id, []),
            )
            for e in entries
        ]

    async def list_entries(self, user_id: str, company: str, *, date_from: date | None = None,
                           date_to: date | None = None, source_type: str | None = None,
                           q: str | None = None, limit: int = 300) -> list[EntryOut]:
        await self._user(user_id, company)
        query = select(AchiAccEntry).where(AchiAccEntry.company == company)
        if date_from:
            query = query.where(AchiAccEntry.entry_date >= date_from)
        if date_to:
            query = query.where(AchiAccEntry.entry_date <= date_to)
        if source_type:
            query = query.where(AchiAccEntry.source_type == source_type)
        if q:
            digits = "".join(ch for ch in q if ch.isdigit())
            conds = [func.lower(AchiAccEntry.memo).like(f"%{q.strip().lower()}%")]
            if digits:
                conds.append(AchiAccEntry.number == int(digits))
            query = query.where(or_(*conds))
        rows = (await self.session.execute(
            query.order_by(AchiAccEntry.entry_date.desc(), AchiAccEntry.number.desc()).limit(limit)
        )).scalars().all()
        return await self._entries_out(list(rows))

    async def create_journal(self, user_id: str, data: JournalIn) -> EntryOut:
        user = await self._user(user_id, data.company, manage=True)
        lines = []
        for line in data.lines:
            await self._account(data.company, line.account_id, label="Journal line")
            lines.append({"account_id": line.account_id, "debit": to_minor(line.debit), "credit": to_minor(line.credit),
                          "description": line.description})
        entry = await self._post(data.company, user, data.entry_date, data.memo or "Journal entry", "manual", None, lines)
        await self.session.commit()
        return (await self._entries_out([entry]))[0]

    async def void_entry(self, user_id: str, entry_id: str, day: date | None, reason: str) -> EntryOut:
        entry = await self.session.get(AchiAccEntry, entry_id)
        if entry is None:
            raise _not_found("Journal entry")
        user = await self._user(user_id, entry.company, manage=True)
        if entry.source_type != "manual" or entry.reversal_of_id:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "This entry comes from a document. Void the invoice, receipt or expense instead")
        if entry.reversed_by_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "This entry has already been reversed")
        reversal = await self._reverse(entry.id, user, day or _today(),
                                       f"Reversal of {code('JE', entry.number)}" + (f" — {reason}" if reason else ""))
        await self.session.commit()
        return (await self._entries_out([reversal]))[0]

    # ── reports ─────────────────────────────────────────────────────────────

    async def _accounts(self, company: str) -> list[AchiAccAccount]:
        return list((await self.session.execute(
            select(AchiAccAccount).where(AchiAccAccount.company == company).order_by(AchiAccAccount.code)
        )).scalars().all())

    def _row(self, acc: AchiAccAccount, amount: int) -> dict:
        return {"account_id": acc.id, "code": acc.code, "name": acc.name, "type": acc.type, "amount": to_major(amount)}

    async def trial_balance(self, user_id: str, company: str, as_of: date) -> dict:
        await self._user(user_id, company)
        sums = await self._balances(company, date_to=as_of)
        rows, total_d, total_c = [], 0, 0
        for acc in await self._accounts(company):
            d, c = sums.get(acc.id, (0, 0))
            if not d and not c:
                continue
            net = d - c
            total_d += max(net, 0)
            total_c += max(-net, 0)
            rows.append({"account_id": acc.id, "code": acc.code, "name": acc.name, "type": acc.type,
                         "debit": to_major(max(net, 0)), "credit": to_major(max(-net, 0))})
        return {"as_of": as_of, "rows": rows, "total_debit": to_major(total_d), "total_credit": to_major(total_c),
                "balanced": total_d == total_c, "currency": (await self._settings(company)).base_currency}

    async def _profit(self, company: str, date_from: date | None, date_to: date | None) -> dict:
        sums = await self._balances(company, date_from=date_from, date_to=date_to)
        income, cost, overhead = [], [], []
        totals = {"income": 0, "cost": 0, "overhead": 0}
        for acc in await self._accounts(company):
            if acc.type not in ("income", "expense") or acc.id not in sums:
                continue
            amount = self._natural(acc.type, *sums[acc.id])
            if not amount:
                continue
            if acc.type == "income":
                income.append(self._row(acc, amount)); totals["income"] += amount
            elif acc.code.startswith("5"):
                cost.append(self._row(acc, amount)); totals["cost"] += amount
            else:
                overhead.append(self._row(acc, amount)); totals["overhead"] += amount
        gross = totals["income"] - totals["cost"]
        return {
            "income": income, "cost_of_sales": cost, "expenses": overhead,
            "total_income": to_major(totals["income"]), "total_cost_of_sales": to_major(totals["cost"]),
            "gross_profit": to_major(gross), "total_expenses": to_major(totals["overhead"]),
            "net_profit": to_major(gross - totals["overhead"]), "_net": gross - totals["overhead"],
        }

    async def profit_and_loss(self, user_id: str, company: str, date_from: date, date_to: date) -> dict:
        await self._user(user_id, company)
        out = await self._profit(company, date_from, date_to)
        out.pop("_net")
        return {"from": date_from, "to": date_to, "currency": (await self._settings(company)).base_currency, **out}

    async def balance_sheet(self, user_id: str, company: str, as_of: date) -> dict:
        await self._user(user_id, company)
        sums = await self._balances(company, date_to=as_of)
        sections = {"asset": [], "liability": [], "equity": []}
        totals = {"asset": 0, "liability": 0, "equity": 0}
        for acc in await self._accounts(company):
            if acc.type not in sections or acc.id not in sums:
                continue
            amount = self._natural(acc.type, *sums[acc.id])
            if amount:
                sections[acc.type].append(self._row(acc, amount))
                totals[acc.type] += amount
        earnings = (await self._profit(company, None, as_of))["_net"]
        equity_total = totals["equity"] + earnings
        return {
            "as_of": as_of, "currency": (await self._settings(company)).base_currency,
            "assets": sections["asset"], "liabilities": sections["liability"], "equity": sections["equity"],
            "current_earnings": to_major(earnings),
            "total_assets": to_major(totals["asset"]), "total_liabilities": to_major(totals["liability"]),
            "total_equity": to_major(equity_total),
            "total_liabilities_and_equity": to_major(totals["liability"] + equity_total),
            "balanced": totals["asset"] == totals["liability"] + equity_total,
        }

    async def ledger(self, user_id: str, company: str, account_id: str, date_from: date, date_to: date) -> dict:
        await self._user(user_id, company)
        acc = await self.session.get(AchiAccAccount, account_id)
        if acc is None or acc.company != company:
            raise _not_found("Account")
        opening_d, opening_c = (await self.session.execute(
            select(func.coalesce(func.sum(AchiAccLine.debit_minor), 0), func.coalesce(func.sum(AchiAccLine.credit_minor), 0))
            .where(AchiAccLine.account_id == acc.id, AchiAccLine.entry_date < date_from)
        )).one()
        running = self._natural(acc.type, int(opening_d), int(opening_c))
        opening = running
        rows = (await self.session.execute(
            select(AchiAccLine, AchiAccEntry)
            .join(AchiAccEntry, AchiAccEntry.id == AchiAccLine.entry_id)
            .where(AchiAccLine.account_id == acc.id, AchiAccLine.entry_date >= date_from,
                   AchiAccLine.entry_date <= date_to)
            .order_by(AchiAccLine.entry_date, AchiAccEntry.number, AchiAccLine.position)
        )).all()
        sources = await self._source_codes([e for _, e in rows])
        lines, total_d, total_c = [], 0, 0
        for line, entry in rows:
            running += self._natural(acc.type, line.debit_minor, line.credit_minor)
            total_d += line.debit_minor
            total_c += line.credit_minor
            lines.append({
                "date": line.entry_date, "entry_id": entry.id, "entry_code": code("JE", entry.number),
                "source_type": entry.source_type, "source_id": entry.source_id,
                "source_code": sources.get(entry.source_id or ""), "memo": entry.memo,
                "description": line.description, "debit": to_major(line.debit_minor),
                "credit": to_major(line.credit_minor), "balance": to_major(running),
            })
        return {"account": self._row(acc, running), "from": date_from, "to": date_to,
                "opening": to_major(opening), "closing": to_major(running), "lines": lines,
                "total_debit": to_major(total_d), "total_credit": to_major(total_c)}

    async def aged_receivables(self, user_id: str, company: str, as_of: date) -> dict:
        await self._user(user_id, company)
        rows = (await self.session.execute(
            select(AchiSalesInvoice).where(
                AchiSalesInvoice.company == company, AchiSalesInvoice.status == "issued",
                AchiSalesInvoice.paid_minor < AchiSalesInvoice.total_minor, AchiSalesInvoice.issue_date <= as_of,
            ).order_by(AchiSalesInvoice.due_date, AchiSalesInvoice.number)
        )).scalars().all()
        buckets = ("current", "1_30", "31_60", "61_90", "over_90")
        customers: dict[str, dict] = {}
        totals = dict.fromkeys(buckets, 0)
        invoices = []
        for inv in rows:
            balance = inv.total_minor - inv.paid_minor
            base = convert(balance, inv.fx_rate)
            late = (as_of - (inv.due_date or inv.issue_date)).days
            bucket = "current" if late <= 0 else "1_30" if late <= 30 else "31_60" if late <= 60 \
                else "61_90" if late <= 90 else "over_90"
            name = inv.customer_company or inv.customer_name or "—"
            key = inv.contact_id or name.strip().lower()
            c = customers.setdefault(key, {"customer": name, "contact_id": inv.contact_id, "total": 0,
                                           **dict.fromkeys(buckets, 0), "invoices": 0})
            c[bucket] += base
            c["total"] += base
            c["invoices"] += 1
            totals[bucket] += base
            invoices.append({"id": inv.id, "code": code("INV", inv.number), "customer": name,
                             "issue_date": inv.issue_date, "due_date": inv.due_date, "days_late": max(late, 0),
                             "currency": inv.currency, "balance": to_major(balance), "base_balance": to_major(base),
                             "bucket": bucket})
        listed = sorted(customers.values(), key=lambda c: -c["total"])
        for c in listed:
            for k in (*buckets, "total"):
                c[k] = to_major(c[k])
        return {"as_of": as_of, "currency": (await self._settings(company)).base_currency, "customers": listed,
                "invoices": invoices, "totals": {k: to_major(v) for k, v in totals.items()},
                "total": to_major(sum(totals.values()))}

    async def vat_report(self, user_id: str, company: str, date_from: date, date_to: date) -> dict:
        await self._user(user_id, company)
        roles = await self._roles(company)
        sums = await self._balances(company, date_from=date_from, date_to=date_to)
        out_d, out_c = sums.get(roles["vat_output"].id, (0, 0))
        in_d, in_c = sums.get(roles["vat_input"].id, (0, 0))
        output_vat, input_vat = out_c - out_d, in_d - in_c
        sales = (await self.session.execute(
            select(AchiSalesInvoice).where(
                AchiSalesInvoice.company == company, AchiSalesInvoice.status == "issued",
                AchiSalesInvoice.issue_date >= date_from, AchiSalesInvoice.issue_date <= date_to)
        )).scalars().all()
        purchases = (await self.session.execute(
            select(AchiAccExpense).where(
                AchiAccExpense.company == company, AchiAccExpense.status == "posted",
                AchiAccExpense.expense_date >= date_from, AchiAccExpense.expense_date <= date_to)
        )).scalars().all()
        return {
            "from": date_from, "to": date_to, "currency": (await self._settings(company)).base_currency,
            "sales_net": to_major(sum(convert(i.subtotal_minor, i.fx_rate) for i in sales)),
            "sales_count": len(sales), "output_vat": to_major(output_vat),
            "purchases_net": to_major(sum(convert(e.amount_minor, e.fx_rate) for e in purchases)),
            "purchases_count": len(purchases), "input_vat": to_major(input_vat),
            "net_vat": to_major(output_vat - input_vat),
        }

    async def overview(self, user_id: str, company: str) -> dict:
        await self._user(user_id, company)
        today = _today()
        month_start = today.replace(day=1)
        sums = await self._balances(company, date_to=today)
        accounts = await self._accounts(company)
        banks = [{"account_id": a.id, "code": a.code, "name": a.name,
                  "balance": to_major(self._natural(a.type, *sums.get(a.id, (0, 0))))}
                 for a in accounts if a.is_bank and a.active]
        cash_total = sum(self._natural(a.type, *sums.get(a.id, (0, 0))) for a in accounts if a.is_bank)
        roles = await self._roles(company)
        ar = self._natural("asset", *sums.get(roles["receivable"].id, (0, 0)))
        deposits = self._natural("liability", *sums.get(roles["customer_deposits"].id, (0, 0)))
        vat_due = self._natural("liability", *sums.get(roles["vat_output"].id, (0, 0))) \
            - self._natural("asset", *sums.get(roles["vat_input"].id, (0, 0)))
        open_rows = (await self.session.execute(
            select(AchiSalesInvoice).where(
                AchiSalesInvoice.company == company, AchiSalesInvoice.status == "issued",
                AchiSalesInvoice.paid_minor < AchiSalesInvoice.total_minor)
            .order_by(AchiSalesInvoice.due_date)
        )).scalars().all()
        overdue = [i for i in open_rows if i.due_date and i.due_date < today]
        month = await self._profit(company, month_start, today)
        # Six months of income and expenses, oldest first, for the chart.
        series = []
        start = month_start
        for _ in range(5):
            start = (start - timedelta(days=1)).replace(day=1)
        cursor = start
        while cursor <= month_start:
            nxt = (cursor + timedelta(days=32)).replace(day=1)
            p = await self._profit(company, cursor, nxt - timedelta(days=1))
            series.append({"month": cursor.strftime("%Y-%m"), "income": p["total_income"],
                           "expenses": to_major(to_minor(p["total_cost_of_sales"]) + to_minor(p["total_expenses"])),
                           "profit": p["net_profit"]})
            cursor = nxt
        drafts = (await self.session.execute(
            select(func.count()).select_from(AchiSalesInvoice).where(
                AchiSalesInvoice.company == company, AchiSalesInvoice.status == "draft")
        )).scalar()
        recent = (await self.session.execute(
            select(AchiAccEntry).where(AchiAccEntry.company == company)
            .order_by(AchiAccEntry.created_at.desc()).limit(8)
        )).scalars().all()
        return {
            "currency": (await self._settings(company)).base_currency,
            "cash_total": to_major(cash_total), "banks": banks, "receivable": to_major(ar),
            "customer_deposits": to_major(deposits), "vat_due": to_major(vat_due),
            "overdue_count": len(overdue),
            "overdue_total": to_major(sum(convert(i.total_minor - i.paid_minor, i.fx_rate) for i in overdue)),
            "open_count": len(open_rows), "draft_count": int(drafts or 0),
            "month_income": month["total_income"],
            "month_expenses": to_major(to_minor(month["total_cost_of_sales"]) + to_minor(month["total_expenses"])),
            "month_profit": month["net_profit"], "series": series,
            "unpaid": [{"id": i.id, "code": code("INV", i.number), "customer": i.customer_company or i.customer_name,
                        "due_date": i.due_date, "currency": i.currency, "balance": to_major(i.total_minor - i.paid_minor),
                        "overdue": bool(i.due_date and i.due_date < today)} for i in open_rows[:8]],
            "recent": [e.model_dump() for e in await self._entries_out(list(recent))],
        }

    async def customers(self, user_id: str, company: str, q: str | None) -> list[dict]:
        """People and companies already invoiced or quoted, for the customer picker."""
        await self._user(user_id, company)
        like = f"%{(q or '').strip().lower()}%"
        seen: dict[str, dict] = {}
        inv_rows = (await self.session.execute(
            select(AchiSalesInvoice.customer_name, AchiSalesInvoice.customer_company, AchiSalesInvoice.customer_mobile,
                   AchiSalesInvoice.customer_email, AchiSalesInvoice.customer_address,
                   AchiSalesInvoice.customer_tax_number, AchiSalesInvoice.contact_id)
            .where(AchiSalesInvoice.company == company,
                   or_(func.lower(AchiSalesInvoice.customer_name).like(like),
                       func.lower(AchiSalesInvoice.customer_company).like(like)))
            .order_by(AchiSalesInvoice.created_at.desc()).limit(200)
        )).all()
        for name, comp, mobile, email, address, tax, contact in inv_rows:
            key = (comp or name or "").strip().lower()
            if key and key not in seen:
                seen[key] = {"customer_name": name, "customer_company": comp, "customer_mobile": mobile,
                             "customer_email": email, "customer_address": address, "customer_tax_number": tax,
                             "contact_id": contact}
        if company == "achi":
            q_rows = (await self.session.execute(
                select(Quotation.customer_name, Quotation.customer_company, Quotation.customer_mobile,
                       Quotation.customer_email, Quotation.contact_id)
                .where(or_(func.lower(func.coalesce(Quotation.customer_name, "")).like(like),
                           func.lower(func.coalesce(Quotation.customer_company, "")).like(like)))
                .order_by(Quotation.created_at.desc()).limit(200)
            )).all()
            for name, comp, mobile, email, contact in q_rows:
                key = (comp or name or "").strip().lower()
                if key and key not in seen:
                    seen[key] = {"customer_name": name or "", "customer_company": comp or "",
                                 "customer_mobile": mobile or "", "customer_email": email or "",
                                 "customer_address": "", "customer_tax_number": "", "contact_id": contact}
        return list(seen.values())[:100]

