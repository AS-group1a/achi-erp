"""Accounting routes, mounted under /api/v1/achi/accounting by router.py."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response, status
from fastapi.responses import HTMLResponse, PlainTextResponse

from app.dependencies import CurrentUserId, SessionDep

from .acc_schemas import (
    AccountIn,
    AccountOut,
    AccountUpdate,
    AllocateIn,
    Company,
    EntryOut,
    ExpenseIn,
    ExpenseOut,
    InvoiceIn,
    InvoiceOut,
    JournalIn,
    ReceiptIn,
    ReceiptOut,
    SettingsOut,
    SettingsUpdate,
    VoidIn,
)
from .acc_service import AccountingService
from .company_access import active_user, require_company
from .hr_models import COMPANIES

acc_router = APIRouter(prefix="/accounting")
_UI_DIR = Path(__file__).parent / "ui"
_NO_STORE = {"Cache-Control": "no-store, max-age=0"}
CompanyQ = Annotated[Company, Query()]
Day = Annotated[date | None, Query()]


def _page(name: str) -> HTMLResponse:
    return HTMLResponse((_UI_DIR / name).read_text(encoding="utf-8"), headers=_NO_STORE)


def _asset(name: str, media_type: str) -> PlainTextResponse:
    return PlainTextResponse((_UI_DIR / name).read_text(encoding="utf-8"), media_type=media_type, headers=_NO_STORE)


@acc_router.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def accounting_ui() -> HTMLResponse:
    return _page("accounting.html")


@acc_router.get("/invoice", response_class=HTMLResponse, include_in_schema=False)
def invoice_ui() -> HTMLResponse:
    """The invoice editor: ?id=<invoice>, or ?company=<co> for a new one."""
    return _page("invoice_editor.html")


@acc_router.get("/accounting.css", response_class=PlainTextResponse, include_in_schema=False)
def accounting_css() -> PlainTextResponse:
    return _asset("accounting.css", "text/css")


@acc_router.get("/accounting.js", response_class=PlainTextResponse, include_in_schema=False)
def accounting_js() -> PlainTextResponse:
    return _asset("accounting.js", "application/javascript")


@acc_router.get("/invoice.js", response_class=PlainTextResponse, include_in_schema=False)
def invoice_js() -> PlainTextResponse:
    return _asset("invoice_editor.js", "application/javascript")


@acc_router.get("/me")
async def accounting_me(session: SessionDep, user_id: CurrentUserId, company: CompanyQ) -> dict:
    return await AccountingService(session).access(user_id, company)


@acc_router.get("/letterhead")
async def letterhead(session: SessionDep, user_id: CurrentUserId, company: CompanyQ) -> dict:
    """What documents print at the top. Open to anyone who may open the company
    (quotations print it too), not only to Accounting users."""
    await require_company(session, await active_user(session, user_id), company)
    svc = AccountingService(session)
    await svc.ensure_company(company)
    s = await svc._settings(company)
    return {"company": company, "legal_name": s.legal_name or COMPANIES[company], "address": s.address,
            "phone": s.phone, "email": s.email, "tax_number": s.tax_number, "bank_details": s.bank_details}


# ── settings and accounts ───────────────────────────────────────────────────

@acc_router.get("/settings", response_model=SettingsOut)
async def get_settings(session: SessionDep, user_id: CurrentUserId, company: CompanyQ) -> SettingsOut:
    return await AccountingService(session).get_settings(user_id, company)


@acc_router.patch("/settings", response_model=SettingsOut)
async def update_settings(data: SettingsUpdate, session: SessionDep, user_id: CurrentUserId,
                          company: CompanyQ) -> SettingsOut:
    return await AccountingService(session).update_settings(user_id, company, data)


@acc_router.get("/accounts", response_model=list[AccountOut])
async def list_accounts(session: SessionDep, user_id: CurrentUserId, company: CompanyQ) -> list[AccountOut]:
    return await AccountingService(session).list_accounts(user_id, company)


@acc_router.post("/accounts", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
async def create_account(data: AccountIn, session: SessionDep, user_id: CurrentUserId) -> AccountOut:
    return await AccountingService(session).create_account(user_id, data)


@acc_router.patch("/accounts/{account_id}", response_model=AccountOut)
async def update_account(account_id: str, data: AccountUpdate, session: SessionDep,
                         user_id: CurrentUserId) -> AccountOut:
    return await AccountingService(session).update_account(user_id, account_id, data)


@acc_router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(account_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    await AccountingService(session).delete_account(user_id, account_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@acc_router.get("/customers")
async def customers(session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
                    q: Annotated[str | None, Query(max_length=120)] = None) -> list[dict]:
    return await AccountingService(session).customers(user_id, company, q)


# ── invoices ────────────────────────────────────────────────────────────────

InvoiceState = Literal["draft", "issued", "void", "unpaid", "overdue", "paid"]


@acc_router.get("/invoices", response_model=list[InvoiceOut])
async def list_invoices(
    session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
    state: Annotated[InvoiceState | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=120)] = None,
    quotation_id: Annotated[str | None, Query(max_length=36)] = None,
    date_from: Day = None, date_to: Day = None,
) -> list[InvoiceOut]:
    return await AccountingService(session).list_invoices(
        user_id, company, state=state, q=q, quotation_id=quotation_id, date_from=date_from, date_to=date_to)


@acc_router.post("/invoices", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
async def create_invoice(data: InvoiceIn, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).create_invoice(user_id, data)


@acc_router.post("/invoices/from-quotation/{quotation_id}", response_model=InvoiceOut,
                 status_code=status.HTTP_201_CREATED)
async def invoice_from_quotation(quotation_id: str, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).invoice_from_quotation(user_id, quotation_id)


@acc_router.get("/invoices/{invoice_id}", response_model=InvoiceOut)
async def get_invoice(invoice_id: str, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).get_invoice(user_id, invoice_id)


@acc_router.put("/invoices/{invoice_id}", response_model=InvoiceOut)
async def update_invoice(invoice_id: str, data: InvoiceIn, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).update_invoice(user_id, invoice_id, data)


@acc_router.delete("/invoices/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_invoice(invoice_id: str, session: SessionDep, user_id: CurrentUserId) -> Response:
    await AccountingService(session).delete_invoice(user_id, invoice_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@acc_router.post("/invoices/{invoice_id}/issue", response_model=InvoiceOut)
async def issue_invoice(invoice_id: str, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).issue_invoice(user_id, invoice_id)


@acc_router.post("/invoices/{invoice_id}/void", response_model=InvoiceOut)
async def void_invoice(invoice_id: str, data: VoidIn, session: SessionDep, user_id: CurrentUserId) -> InvoiceOut:
    return await AccountingService(session).void_invoice(user_id, invoice_id, data.void_date, data.reason)


# ── receipts ────────────────────────────────────────────────────────────────

@acc_router.get("/receipts", response_model=list[ReceiptOut])
async def list_receipts(
    session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
    q: Annotated[str | None, Query(max_length=120)] = None, date_from: Day = None, date_to: Day = None,
) -> list[ReceiptOut]:
    return await AccountingService(session).list_receipts(user_id, company, q=q, date_from=date_from, date_to=date_to)


@acc_router.post("/receipts", response_model=ReceiptOut, status_code=status.HTTP_201_CREATED)
async def create_receipt(data: ReceiptIn, session: SessionDep, user_id: CurrentUserId) -> ReceiptOut:
    return await AccountingService(session).create_receipt(user_id, data)


@acc_router.get("/receipts/{receipt_id}", response_model=ReceiptOut)
async def get_receipt(receipt_id: str, session: SessionDep, user_id: CurrentUserId) -> ReceiptOut:
    return await AccountingService(session).get_receipt(user_id, receipt_id)


@acc_router.post("/receipts/{receipt_id}/allocate", response_model=ReceiptOut)
async def allocate_receipt(receipt_id: str, data: AllocateIn, session: SessionDep, user_id: CurrentUserId) -> ReceiptOut:
    return await AccountingService(session).allocate_receipt(user_id, receipt_id, data)


@acc_router.post("/receipts/{receipt_id}/void", response_model=ReceiptOut)
async def void_receipt(receipt_id: str, data: VoidIn, session: SessionDep, user_id: CurrentUserId) -> ReceiptOut:
    return await AccountingService(session).void_receipt(user_id, receipt_id, data.void_date, data.reason)


# ── expenses ────────────────────────────────────────────────────────────────

@acc_router.get("/expenses", response_model=list[ExpenseOut])
async def list_expenses(
    session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
    q: Annotated[str | None, Query(max_length=120)] = None,
    account_id: Annotated[str | None, Query(max_length=36)] = None, date_from: Day = None, date_to: Day = None,
) -> list[ExpenseOut]:
    return await AccountingService(session).list_expenses(
        user_id, company, q=q, account_id=account_id, date_from=date_from, date_to=date_to)


@acc_router.post("/expenses", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
async def create_expense(data: ExpenseIn, session: SessionDep, user_id: CurrentUserId) -> ExpenseOut:
    return await AccountingService(session).create_expense(user_id, data)


@acc_router.post("/expenses/{expense_id}/void", response_model=ExpenseOut)
async def void_expense(expense_id: str, data: VoidIn, session: SessionDep, user_id: CurrentUserId) -> ExpenseOut:
    return await AccountingService(session).void_expense(user_id, expense_id, data.void_date, data.reason)


# ── journal ─────────────────────────────────────────────────────────────────

@acc_router.get("/journal", response_model=list[EntryOut])
async def list_entries(
    session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
    source_type: Annotated[Literal["manual", "invoice", "receipt", "allocation", "expense"] | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=120)] = None, date_from: Day = None, date_to: Day = None,
) -> list[EntryOut]:
    return await AccountingService(session).list_entries(
        user_id, company, date_from=date_from, date_to=date_to, source_type=source_type, q=q)


@acc_router.post("/journal", response_model=EntryOut, status_code=status.HTTP_201_CREATED)
async def create_journal(data: JournalIn, session: SessionDep, user_id: CurrentUserId) -> EntryOut:
    return await AccountingService(session).create_journal(user_id, data)


@acc_router.post("/journal/{entry_id}/void", response_model=EntryOut)
async def void_entry(entry_id: str, data: VoidIn, session: SessionDep, user_id: CurrentUserId) -> EntryOut:
    return await AccountingService(session).void_entry(user_id, entry_id, data.void_date, data.reason)


# ── reports ─────────────────────────────────────────────────────────────────

def _today() -> date:
    return date.today()


@acc_router.get("/reports/overview")
async def overview(session: SessionDep, user_id: CurrentUserId, company: CompanyQ) -> dict:
    return await AccountingService(session).overview(user_id, company)


@acc_router.get("/reports/trial-balance")
async def trial_balance(session: SessionDep, user_id: CurrentUserId, company: CompanyQ, as_of: Day = None) -> dict:
    return await AccountingService(session).trial_balance(user_id, company, as_of or _today())


@acc_router.get("/reports/profit-loss")
async def profit_loss(session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
                      date_from: Day = None, date_to: Day = None) -> dict:
    today = _today()
    return await AccountingService(session).profit_and_loss(
        user_id, company, date_from or today.replace(month=1, day=1), date_to or today)


@acc_router.get("/reports/balance-sheet")
async def balance_sheet(session: SessionDep, user_id: CurrentUserId, company: CompanyQ, as_of: Day = None) -> dict:
    return await AccountingService(session).balance_sheet(user_id, company, as_of or _today())


@acc_router.get("/reports/ledger")
async def ledger(session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
                 account_id: Annotated[str, Query(max_length=36)], date_from: Day = None, date_to: Day = None) -> dict:
    today = _today()
    return await AccountingService(session).ledger(
        user_id, company, account_id, date_from or today.replace(month=1, day=1), date_to or today)


@acc_router.get("/reports/aged-receivables")
async def aged_receivables(session: SessionDep, user_id: CurrentUserId, company: CompanyQ, as_of: Day = None) -> dict:
    return await AccountingService(session).aged_receivables(user_id, company, as_of or _today())


@acc_router.get("/reports/vat")
async def vat_report(session: SessionDep, user_id: CurrentUserId, company: CompanyQ,
                     date_from: Day = None, date_to: Day = None) -> dict:
    today = _today()
    return await AccountingService(session).vat_report(
        user_id, company, date_from or today.replace(day=1), date_to or today)
