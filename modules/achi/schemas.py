from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

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
    owner_name: str | None = None   # User.full_name; the grid derives initials from it
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

SURVEY_STATUSES = ("Draft", "Scheduled", "In Progress", "Completed", "Cancelled")
SURVEY_SITE_TYPES = ("Residential", "Commercial", "Industrial")
SURVEY_ROOF_TYPES = ("Flat", "Pitched", "Mixed", "N/A")
SURVEY_UNITS = ("m", "m²", "m³", "cm", "mm", "ft", "in", "kg", "g", "L", "mL", "pcs", "units")
LEGACY_SURVEY_STATUSES = {
    "planned": "Scheduled",
    "on_site": "In Progress",
    "surveyed": "Completed",
    "quoted": "Completed",
    "cancelled": "Cancelled",
}


class SurveyMeasurementIn(BaseModel):
    """Frappe ``Site Survey Measurement`` child row."""

    model_config = ConfigDict(str_strip_whitespace=True)

    label: str | None = Field(default=None, max_length=255)
    value: float | None = None
    unit: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_UNITS))


class SurveyMeasurementOut(SurveyMeasurementIn):
    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_id: str


class SurveyCreate(BaseModel):
    """The writable fields from Frappe's ``Site Survey`` DocType."""

    model_config = ConfigDict(str_strip_whitespace=True)

    status: str = Field(default="Draft", pattern="^(%s)$" % "|".join(SURVEY_STATUSES))
    survey_date: date | None = None
    assigned_to: str | None = Field(default=None, max_length=255)
    customer: str | None = Field(default=None, max_length=255)
    lead: str | None = Field(default=None, max_length=255)
    contact: str | None = Field(default=None, max_length=255)
    site_location: str | None = Field(default=None, max_length=255)
    google_maps_url: str | None = Field(default=None, max_length=1000)
    site_type: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_SITE_TYPES))
    roof_type: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_ROOF_TYPES))
    site_area: float | None = None
    notes: str | None = None
    updates: str | None = None
    drawing: str | None = None
    measurements: list[SurveyMeasurementIn] = Field(default_factory=list)


class SurveyUpdate(BaseModel):
    """Partial update using the same field names and Select options as Frappe."""

    model_config = ConfigDict(str_strip_whitespace=True)

    status: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_STATUSES))
    survey_date: date | None = None
    assigned_to: str | None = Field(default=None, max_length=255)
    customer: str | None = Field(default=None, max_length=255)
    lead: str | None = Field(default=None, max_length=255)
    contact: str | None = Field(default=None, max_length=255)
    site_location: str | None = Field(default=None, max_length=255)
    google_maps_url: str | None = Field(default=None, max_length=1000)
    site_type: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_SITE_TYPES))
    roof_type: str | None = Field(default=None, pattern="^(%s)$" % "|".join(SURVEY_ROOF_TYPES))
    site_area: float | None = None
    notes: str | None = None
    updates: str | None = None
    drawing: str | None = None
    measurements: list[SurveyMeasurementIn] | None = None


class SurveyAttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_id: str
    label: str | None = None
    url: str | None = None
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


class SurveyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_number: str
    status: str = "Draft"
    survey_date: date | None = None
    assigned_to: str | None = None
    customer: str | None = None
    lead: str | None = None
    contact: str | None = None
    site_location: str | None = None
    google_maps_url: str | None = None
    site_type: str | None = None
    roof_type: str | None = None
    site_area: float | None = None
    notes: str | None = None
    updates: str | None = None
    has_drawing: int = 0
    drawing: str = ""
    has_measurements: int = 0
    created_at: datetime
    attachments: list[SurveyAttachmentOut] = Field(default_factory=list)
    measurements: list[SurveyMeasurementOut] = Field(default_factory=list)

    @field_validator("status", mode="before")
    @classmethod
    def align_legacy_status(cls, value):
        return LEGACY_SURVEY_STATUSES.get(str(value), value)


class SurveyRowOut(BaseModel):
    """Flat row for the survey list — no attachments, no drawing blob."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    survey_number: str
    status: str = "Draft"
    survey_date: date | None = None
    assigned_to: str | None = None
    customer: str | None = None
    lead: str | None = None
    contact: str | None = None
    site_location: str | None = None
    google_maps_url: str | None = None
    site_type: str | None = None
    roof_type: str | None = None
    site_area: float | None = None
    has_drawing: int = 0
    has_measurements: int = 0
    photo_count: int = 0
    created_at: datetime

    @field_validator("status", mode="before")
    @classmethod
    def align_legacy_status(cls, value):
        return LEGACY_SURVEY_STATUSES.get(str(value), value)


# ── quotations ────────────────────────────────────────────────────────────
# Money crosses this boundary as a decimal STRING ("1250.00"), not a float, and
# is converted to integer minor units in quotation_service. See to_minor there.

QUOTATION_STATUSES = ("draft", "sent", "accepted", "rejected", "expired")


class QuotationEstimate(BaseModel):
    """The quick estimate, as the card sends it."""

    area_sqm: str | None = None
    duration_weeks: str | None = None
    rate: str | None = None          # per m² per week
    erection: str | None = None
    transport: str | None = None
    extras: str | None = None
    discount: str | None = None
    vat_percent: str | None = None
    currency: str = "USD"


class QuotationDraftFromLog(QuotationEstimate):
    """Draft a quotation from a call log row.

    Customer fields are optional overrides: left blank they are taken from the
    row, so the common case is the estimate numbers and nothing else.
    """

    customer_name: str | None = None
    customer_company: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    site_city: str | None = None
    site_address: str | None = None
    scope: str | None = None
    notes: str | None = None
    valid_until: date | None = None


class QuotationUpdate(QuotationEstimate):
    customer_name: str | None = None
    customer_company: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    site_city: str | None = None
    site_address: str | None = None
    scope: str | None = None
    notes: str | None = None
    valid_until: date | None = None
    status: str | None = None

    @model_validator(mode="after")
    def _check_status(self):
        if self.status is not None and self.status not in QUOTATION_STATUSES:
            raise ValueError(f"status must be one of {QUOTATION_STATUSES}")
        return self


class QuotationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    quotation_number: str
    file_id: str | None = None
    survey_id: str | None = None
    contact_id: str | None = None

    customer_name: str | None = None
    customer_company: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    site_city: str | None = None
    site_address: str | None = None

    area_sqm: str | None = None
    duration_weeks: str | None = None
    currency: str = "USD"
    vat_percent: str | None = None

    # Decimal strings for display; the integers stay server-side.
    rate: str | None = None
    erection: str | None = None
    transport: str | None = None
    extras: str | None = None
    discount: str | None = None
    subtotal: str | None = None
    vat: str | None = None
    total: str | None = None

    scope: str | None = None
    notes: str | None = None
    valid_until: date | None = None
    status: str
    created_at: datetime | None = None
