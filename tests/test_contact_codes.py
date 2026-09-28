"""Tests for the Contacts page directory codes (CO-00001 / C-00001).

No database is needed: a small in-memory stand-in for the async session answers
the two query shapes contact_codes() issues (fetch the codes of some contacts;
the highest number of one kind) and can simulate a lost race on commit.
"""

from __future__ import annotations

import asyncio
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_contact_codes_unit",
)
os.environ.setdefault("APP_ENV", "development")

try:
    from sqlalchemy.exc import IntegrityError

    from modules.achi.models import AchiContactCode
    from modules.achi.service import CONTACT_INFO_TAG, contact_codes, contact_kind
except ModuleNotFoundError:
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True


class _Result:
    def __init__(self, rows=None, scalar=None):
        self._rows, self._scalar = rows or [], scalar

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)

    def scalar(self):
        return self._scalar


class FakeSession:
    """Stores committed AchiContactCode rows; pending adds commit or roll back."""

    def __init__(self, fail_commits: int = 0):
        self.rows: list = []
        self.pending: list = []
        self.fail_commits = fail_commits

    async def execute(self, stmt):
        sql = str(stmt)
        if "max(" in sql:
            kind = stmt.whereclause.right.value
            nums = [r.number for r in self.rows if r.kind == kind]
            return _Result(scalar=max(nums) if nums else None)
        ids = set(stmt.whereclause.right.value)
        return _Result(rows=[r for r in self.rows if r.contact_id in ids])

    def add(self, row):
        self.pending.append(row)

    async def commit(self):
        if self.fail_commits:
            self.fail_commits -= 1
            # A concurrent request took this number: store a clashing row.
            clash = self.pending[0]
            self.rows.append(AchiContactCode(contact_id="other", kind=clash.kind, number=clash.number))
            raise IntegrityError("insert", {}, Exception("duplicate number"))
        self.rows.extend(self.pending)
        self.pending = []

    async def rollback(self):
        self.pending = []


T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def person(cid, day, first="Ali"):
    return SimpleNamespace(id=cid, created_at=T0 + timedelta(days=day), first_name=first,
                           last_name="", company_name="", custom_properties={})


def company(cid, day, name="Zerock"):
    return SimpleNamespace(id=cid, created_at=T0 + timedelta(days=day), first_name="",
                           last_name="", company_name=name,
                           custom_properties={CONTACT_INFO_TAG: {"record_type": "company"}})


def run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(HAS_APP_TEST_ENV, "requires the ACHI application test environment")
class ContactCodeTests(unittest.TestCase):
    def test_kind_follows_record_type_then_names(self) -> None:
        self.assertEqual(contact_kind(company("a", 0)), "company")
        self.assertEqual(contact_kind(person("b", 0)), "person")
        inferred = SimpleNamespace(first_name="", last_name="", company_name="ACME", custom_properties={})
        self.assertEqual(contact_kind(inferred), "company")

    def test_existing_directory_numbered_by_creation_date_per_kind(self) -> None:
        session = FakeSession()
        contacts = [person("p2", 5), company("c1", 1), person("p1", 2), company("c2", 9)]
        codes = run(contact_codes(session, contacts))
        self.assertEqual(codes, {"p1": "C-00001", "p2": "C-00002", "c1": "CO-00001", "c2": "CO-00002"})

    def test_codes_are_stable_and_new_contacts_take_the_next_number(self) -> None:
        session = FakeSession()
        run(contact_codes(session, [person("p1", 1), company("c1", 2)]))
        stored = len(session.rows)
        again = run(contact_codes(session, [person("p1", 1), company("c1", 2)]))
        self.assertEqual(len(session.rows), stored)          # nothing re-assigned
        self.assertEqual(again, {"p1": "C-00001", "c1": "CO-00001"})
        # Even a contact created "earlier" than existing ones gets the next number.
        codes = run(contact_codes(session, [person("p1", 1), company("c1", 2), person("p0", 0)]))
        self.assertEqual(codes["p0"], "C-00002")
        self.assertEqual(codes["p1"], "C-00001")

    def test_switching_kind_gets_a_code_in_the_new_kind(self) -> None:
        session = FakeSession()
        run(contact_codes(session, [person("x", 1)]))
        switched = company("x", 1)
        self.assertEqual(run(contact_codes(session, [switched])), {"x": "CO-00001"})

    def test_lost_race_retries_against_the_new_maximum(self) -> None:
        session = FakeSession(fail_commits=1)
        codes = run(contact_codes(session, [person("p1", 1)]))
        self.assertEqual(codes, {"p1": "C-00002"})           # "other" took C-00001


if __name__ == "__main__":
    unittest.main()
