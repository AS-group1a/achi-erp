from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

# No "client" stage: becoming a client isn't a file state, it's the file
# converting into a project.
STAGES = ("prospect", "lead", "site_survey", "measurements")
STATUSES = ("open", "scheduled", "viewed", "cancelled", "done")
LOG_TYPES = ("inbound_call", "outbound_call", "quotation", "field", "job", "transfer", "note")


class ModuleInfo(BaseModel):
    module: str
    version: str
    company: str
    note: str


class PersonIn(BaseModel):
    """Who the file is for.

    Only used to FIND or CREATE the contact — none of this is stored on the file.
    Identity belongs to the contact directory (contacts/bridge.py: "the canonical
    store for person data").
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    is_company: bool = False
    prefix: str | None = Field(default=None, max_length=16)      # Mr/Ms/Mrs/Dr/Eng/Arch
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    company_name: str | None = Field(default=None, max_length=255)
    mobile: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def _require_a_name(self) -> "PersonIn":
        if self.is_company:
            if not (self.company_name or "").strip():
                raise ValueError("company_name is required when is_company is true")
        elif not ((self.first_name or "").strip() or (self.last_name or "").strip()):
            raise ValueError("first_name or last_name is required when is_company is false")
        return self


class ContactFileCreate(BaseModel):
    """Open a file. Either name an existing contact, or describe the person."""

    model_config = ConfigDict(str_strip_whitespace=True)

    contact_id: str | None = Field(default=None, max_length=36)
    person: PersonIn | None = None

    subject: str = Field(default="", max_length=255)
    stage: str = Field(default="prospect", pattern="^(%s)$" % "|".join(STAGES))
    status: str = Field(default="open", pattern="^(%s)$" % "|".join(STATUSES))

    country: str | None = Field(default=None, max_length=64)
    district: str | None = Field(default=None, max_length=128)
    city: str | None = Field(default=None, max_length=128)
    street: str | None = Field(default=None, max_length=255)
    site_location: str | None = None
    maps_url: str | None = Field(default=None, max_length=1024)

    assigned_to_user_id: str | None = Field(default=None, max_length=36)
    notes: str = ""

    @model_validator(mode="after")
    def _one_of(self) -> "ContactFileCreate":
        if not self.contact_id and not self.person:
            raise ValueError("provide either contact_id (existing contact) or person (to find/create one)")
        return self


class ContactFileUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    subject: str | None = None
    stage: str | None = Field(default=None, pattern="^(%s)$" % "|".join(STAGES))
    status: str | None = Field(default=None, pattern="^(%s)$" % "|".join(STATUSES))
    country: str | None = None
    district: str | None = None
    city: str | None = None
    street: str | None = None
    site_location: str | None = None
    maps_url: str | None = None
    assigned_to_user_id: str | None = None
    notes: str | None = None


class FileConvertRequest(BaseModel):
    """The contact becomes a client: the file converts into an OCE project."""

    model_config = ConfigDict(str_strip_whitespace=True)

    project_id: str = Field(..., max_length=36, description="An existing oe_projects project")


class FileLogCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    log_type: str = Field(default="note", pattern="^(%s)$" % "|".join(LOG_TYPES))
    category: str | None = Field(default=None, max_length=64)
    occurred_at: datetime | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    description: str = ""
    updates: str = ""
    follow_up_date: date | None = None
    follow_up_notes: str = ""


class ContactPatch(BaseModel):
    """Inline-edit the file's linked contact (name / company / phone / email)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    prefix: str | None = Field(default=None, max_length=16)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    company_name: str | None = Field(default=None, max_length=255)
    mobile: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = Field(default=None, max_length=255)


class FileLogUpdate(BaseModel):
    """Edit an existing log entry in place (inline grid edits)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    log_type: str | None = Field(default=None, pattern="^(%s)$" % "|".join(LOG_TYPES))
    category: str | None = Field(default=None, max_length=64)
    occurred_at: datetime | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    description: str | None = None
    updates: str | None = None
    follow_up_date: date | None = None
    follow_up_notes: str | None = None
    # The canvas JSON from the description popup. ``has_drawing`` is derived in
    # the service from the payload, never trusted from the client.
    drawing: str | None = None


class AttachmentOut(BaseModel):
    """One file attached to a log — what the popup's file list renders."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    log_id: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


class FileLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    file_id: str
    log_type: str
    occurred_at: datetime | None
    duration_seconds: int | None
    description: str
    follow_up_date: date | None
    follow_up_notes: str
    has_drawing: int = 0
    created_by: str | None
    created_at: datetime


class ContactFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    file_number: str
    contact_id: str | None = None
    subject: str
    stage: str
    status: str
    country: str | None
    district: str | None
    city: str | None
    street: str | None
    site_location: str | None
    maps_url: str | None
    project_id: str | None
    converted_at: datetime | None
    owner_user_id: str | None
    assigned_to_user_id: str | None
    notes: str
    created_at: datetime
    logs: list[FileLogOut] = []
    # joined from the contact directory for display; not stored on the file
    contact_name: str | None = None


class ContactFileListOut(BaseModel):
    """Flat and small — this is what a table renders.

    The Frappe list view needed 1,368 lines of JS because it rebuilt a grid by
    hand. The data was never the problem; don't let it become one here.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    file_number: str
    contact_id: str | None = None
    contact_name: str | None = None
    subject: str
    stage: str
    status: str
    city: str | None
    project_id: str | None
    assigned_to_user_id: str | None
    created_at: datetime


# ── Quick capture: the log IS the UI ──────────────────────────────────────
# A user logs a call. The contact and the file are created behind them; neither
# is something anyone should have to think about, let alone create by hand.


class SiteIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    country: str | None = Field(default=None, max_length=64)
    district: str | None = Field(default=None, max_length=128)
    city: str | None = Field(default=None, max_length=128)
    street: str | None = Field(default=None, max_length=255)
    site_location: str | None = None
    maps_url: str | None = Field(default=None, max_length=1024)


class QuickLogCreate(BaseModel):
    """Log a call and let the file and contact appear underneath it."""

    model_config = ConfigDict(str_strip_whitespace=True)

    person: PersonIn
    site: SiteIn | None = None

    status: str = Field(default="open", pattern="^(%s)$" % "|".join(STATUSES))
    log_type: str = Field(default="inbound_call", pattern="^(%s)$" % "|".join(LOG_TYPES))
    category: str | None = Field(default=None, max_length=64)
    occurred_at: datetime | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    description: str = ""
    updates: str = ""
    follow_up_date: date | None = None
    follow_up_notes: str = ""

    subject: str = Field(default="", max_length=255)
    stage: str = Field(default="prospect", pattern="^(%s)$" % "|".join(STAGES))
    # Force a new file even if this contact already has one open — a second,
    # unrelated enquiry from someone we already know.
    new_file: bool = False


class QuickLogOut(BaseModel):
    """What the log UI needs back: the entry, plus where it landed."""

    log: FileLogOut
    file_id: str
    file_number: str
    file_created: bool
    # None when the row had no phone or email: we do not put unreachable names in
    # the contacts directory. The typed identity is kept on the file instead.
    contact_id: str | None = None
    contact_name: str | None = None
    contact_created: bool = False
    # Set when a company was named alongside a person — it gets its own contact.
    company_contact_id: str | None = None


class LogRowOut(BaseModel):
    """A row in the log table — flat, joined, no client-side assembly.

    Enriched with the contact + file fields the grid columns need, so the table
    renders without any per-row lookups.
    """

    id: str
    log_type: str
    category: str | None = None
    occurred_at: datetime | None
    description: str
    updates: str = ""
    follow_up_date: date | None
    follow_up_notes: str = ""
    # Indicators the grid needs to mark a description cell without fetching the
    # blob or the attachment rows per line.
    has_drawing: int = 0
    attachment_count: int = 0
    created_at: datetime
    file_id: str
    file_number: str
    stage: str
    status: str
    subject: str = ""
    # site (from the file)
    site_location: str | None = None
    city: str | None
    district: str | None = None
    street: str | None = None
    country: str | None = None
    maps_url: str | None = None
    owner: str | None = None
    # contact (from the canonical directory; None when the row had no phone/email,
    # in which case the name fields below come from the file as typed)
    contact_id: str | None = None
    company_contact_id: str | None = None
    contact_name: str | None = None
    prefix: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    company_name: str | None = None
    mobile: str | None = None
    email: str | None = None


# ── Site survey ───────────────────────────────────────────────────────────

TRUCK_ACCESS = ("unknown", "yes", "tight", "no")
PARKING = ("unknown", "on_site", "street", "none")
SURVEY_STATUS = ("planned", "on_site", "surveyed", "quoted", "cancelled")


class SurveyCreate(BaseModel):
    """Raise a survey — typically from the office, before driving out."""

    model_config = ConfigDict(str_strip_whitespace=True)

    file_id: str | None = Field(default=None, max_length=36)
    contact_id: str | None = Field(default=None, max_length=36)
    lead_name: str | None = Field(default=None, max_length=255)
    lead_company: str | None = Field(default=None, max_length=255)
    lead_mobile: str | None = Field(default=None, max_length=32)

    country: str | None = Field(default=None, max_length=64)
    district: str | None = Field(default=None, max_length=128)
    city: str | None = Field(default=None, max_length=128)
    street: str | None = Field(default=None, max_length=255)
    site_location: str | None = None
    maps_url: str | None = Field(default=None, max_length=1024)
    scheduled_for: datetime | None = None


class SurveyUpdate(BaseModel):
    """Everything the surveyor fills in on site. All optional — the page saves
    each section as it is completed rather than demanding the whole form."""

    model_config = ConfigDict(str_strip_whitespace=True)

    lead_name: str | None = Field(default=None, max_length=255)
    lead_company: str | None = Field(default=None, max_length=255)
    lead_mobile: str | None = Field(default=None, max_length=32)

    country: str | None = Field(default=None, max_length=64)
    district: str | None = Field(default=None, max_length=128)
    city: str | None = Field(default=None, max_length=128)
    street: str | None = Field(default=None, max_length=255)
    site_location: str | None = None
    maps_url: str | None = Field(default=None, max_length=1024)
    scheduled_for: datetime | None = None

    truck_access: str | None = Field(default=None, pattern="^(%s)$" % "|".join(TRUCK_ACCESS))
    parking: str | None = Field(default=None, pattern="^(%s)$" % "|".join(PARKING))
    road_notes: str | None = None
    access_notes: str | None = None

    arrived_at: datetime | None = None
    people_met: str | None = None
    description: str | None = None
    # has_drawing is derived from the payload, never trusted from the client.
    drawing: str | None = None

    status: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_STATUS))


class SurveyAttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_id: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


class SurveyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_number: str
    file_id: str | None = None
    contact_id: str | None = None
    lead_name: str | None = None
    lead_company: str | None = None
    lead_mobile: str | None = None

    country: str | None = None
    district: str | None = None
    city: str | None = None
    street: str | None = None
    site_location: str | None = None
    maps_url: str | None = None
    scheduled_for: datetime | None = None

    truck_access: str = "unknown"
    parking: str = "unknown"
    road_notes: str = ""
    access_notes: str = ""

    arrived_at: datetime | None = None
    people_met: str = ""
    description: str = ""
    has_drawing: int = 0

    status: str = "planned"
    created_at: datetime
    attachments: list[SurveyAttachmentOut] = []


class SurveyRowOut(BaseModel):
    """Flat row for the survey list — no attachments, no drawing blob."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_number: str
    lead_name: str | None = None
    lead_company: str | None = None
    city: str | None = None
    site_location: str | None = None
    truck_access: str = "unknown"
    parking: str = "unknown"
    status: str = "planned"
    scheduled_for: datetime | None = None
    arrived_at: datetime | None = None
    has_drawing: int = 0
    photo_count: int = 0
    created_at: datetime
