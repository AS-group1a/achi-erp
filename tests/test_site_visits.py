"""Tests for the Site Visit page's server side, without a database.

* Moving an enquiry into the Site visit stage opens a Draft site visit for it
  (ContactFileService.update -> _open_site_visit), once per open visit.
* The SV / ENQ codes and the Mobile / WA choice the table shows.
"""

from __future__ import annotations

import asyncio
import os
import unittest
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://unit:unit@127.0.0.1:1/achi_site_visit_unit",
)
os.environ.setdefault("APP_ENV", "development")

try:
    from modules.achi.models import ContactFile, SiteSurvey
    from modules.achi.schemas import ContactFileUpdate
    from modules.achi.service import CONTACT_INFO_TAG, ContactFileService
    from modules.achi.survey_router import _phone_for_row
    from modules.achi.survey_service import enquiry_code, site_visit_code
except ModuleNotFoundError:
    HAS_APP_TEST_ENV = False
else:
    HAS_APP_TEST_ENV = True


class _Result:
    def __init__(self, value=None):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class FakeSession:
    """Answers the two queries _open_site_visit makes: 'is there an open visit
    for this file?' and 'the highest survey number this year'."""

    def __init__(self, open_visit: bool = False, contact=None):
        self.open_visit = open_visit
        self.contact = contact
        self.added: list = []

    async def execute(self, stmt):
        if "max(" in str(stmt):
            return _Result(None)                       # first visit of the year
        return _Result("visit-1" if self.open_visit else None)

    async def get(self, _model, _key):
        return self.contact

    def add(self, row):
        self.added.append(row)

    async def commit(self):
        pass

    async def refresh(self, _obj):
        pass


def enquiry(stage: str = "quotation") -> "ContactFile":
    return ContactFile(
        id="file-1", file_number="ACHI-2026-00042", stage=stage, status="open",
        contact_id="contact-1", lead_first_name="Rami", lead_last_name="Haddad",
        lead_company="Zerock", lead_mobile="+961 70 111 222",
        city="Jounieh", site_location="Kaslik tower",
    )


def run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(HAS_APP_TEST_ENV, "requires the ACHI application test environment")
class OpenSiteVisitTests(unittest.TestCase):
    def update(self, f, session, **changes):
        return run(ContactFileService(session).update(f, ContactFileUpdate(**changes)))

    def test_moving_to_site_visit_opens_a_draft_visit(self) -> None:
        contact = SimpleNamespace(first_name="Rami", last_name="Haddad", company_name="Zerock",
                                  primary_phone="+961 3 999 000")
        session = FakeSession(contact=contact)
        self.update(enquiry(), session, stage="site_survey")
        visits = [row for row in session.added if isinstance(row, SiteSurvey)]
        self.assertEqual(len(visits), 1)
        visit = visits[0]
        self.assertEqual(visit.status, "Draft")
        self.assertEqual(visit.file_id, "file-1")
        self.assertTrue(visit.survey_number.endswith("-00001"))
        self.assertEqual(visit.lead_name, "Rami Haddad")
        self.assertEqual(visit.lead_mobile, "+961 3 999 000")
        self.assertEqual((visit.city, visit.site_location), ("Jounieh", "Kaslik tower"))

    def test_no_duplicate_while_a_visit_is_open(self) -> None:
        session = FakeSession(open_visit=True)
        self.update(enquiry(), session, stage="site_survey")
        self.assertEqual(session.added, [])

    def test_other_stage_changes_open_nothing(self) -> None:
        session = FakeSession()
        self.update(enquiry(), session, stage="drawing")
        self.update(enquiry("site_survey"), session, stage="site_survey")   # already there
        self.update(enquiry(), session, status="scheduled")
        self.assertEqual(session.added, [])

    def test_typed_lead_is_used_without_a_directory_contact(self) -> None:
        session = FakeSession(contact=None)
        self.update(enquiry(), session, stage="site_survey")
        visit = session.added[0]
        self.assertEqual(visit.lead_name, "Rami Haddad")
        self.assertEqual(visit.lead_mobile, "+961 70 111 222")


@unittest.skipUnless(HAS_APP_TEST_ENV, "requires the ACHI application test environment")
class SiteVisitRowTests(unittest.TestCase):
    def test_codes(self) -> None:
        self.assertEqual(site_visit_code("ACHI-SV-2026-00007"), "SV-00007")
        self.assertEqual(enquiry_code("ACHI-2026-00123"), "ENQ-00123")
        self.assertEqual(site_visit_code("legacy"), "legacy")

    def test_phone_prefers_whatsapp_then_first_number(self) -> None:
        def contact(phones, primary=None):
            return SimpleNamespace(custom_properties={CONTACT_INFO_TAG: {"phones": phones}}, primary_phone=primary)

        both = contact([{"label": "Mobile", "number": "70 1"}, {"label": "WhatsApp", "number": "3 2"}])
        self.assertEqual(_phone_for_row(both, None), ("3 2", "whatsapp"))
        self.assertEqual(_phone_for_row(contact([{"label": "Office", "number": "01 5"}]), None), ("01 5", "mobile"))
        self.assertEqual(_phone_for_row(None, "76 9"), ("76 9", "mobile"))
        self.assertEqual(_phone_for_row(None, None), (None, ""))


if __name__ == "__main__":
    unittest.main()
