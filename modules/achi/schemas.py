from __future__ import annotations

import json
from datetime import date, datetime
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

# No "client" stage: becoming a client isn't a file state, it's the file
# converting into a project.
STAGES = ("prospect", "lead", "site_survey", "measurements")
STATUSES = ("open", "scheduled", "viewed", "cancelled", "done")
# What the Add Log dropdown offers. NOT a closed set: the field is validated by
# length, not by membership, so the UI can add an option without a deploy and the
# rows already carrying the older values (inbound_call, quotation, note) stay
# editable instead of failing validation on their next save.
LOG_TYPES = ("Prospect", "Lead", "Client", "Field", "Fleet", "Yard",
             "Invoice", "Balance", "General")


class ModuleInfo(BaseModel):
    module: str
    version: str
    company: str
    note: str


class SocialIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    platform: str = Field(default="", max_length=32)
    handle: str = Field(default="", max_length=128)


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
    role: str | None = Field(default=None, max_length=64)
    company_type: str | None = Field(default=None, max_length=64)
    mobile: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = Field(default=None, max_length=255)
    socials: list[SocialIn] = Field(default_factory=list)

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
    # Fields the Add Log popup edits but that have no inline-grid editor; the
    # popup PATCHes them here on edit (column names, so update()'s setattr works).
    lead_role: str | None = None
    lead_company_type: str | None = None
    lead_socials: str | None = None
    site_number: str | None = None
    site_building: str | None = None
    site_floor: str | None = None
    assigned_to_user_id: str | None = None
    notes: str | None = None


class FileConvertRequest(BaseModel):
    """The contact becomes a client: the file converts into an OCE project."""

    model_config = ConfigDict(str_strip_whitespace=True)

    project_id: str = Field(..., max_length=36, description="An existing oe_projects project")


class FileLogCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    log_type: str = Field(default="General", max_length=64)
    category: str | None = Field(default=None, max_length=64)
    reference: str | None = Field(default=None, max_length=64)
    tags: str = Field(default="", max_length=255)
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

    log_type: str | None = Field(default=None, max_length=64)
    category: str | None = Field(default=None, max_length=64)
    reference: str | None = Field(default=None, max_length=64)
    tags: str | None = Field(default=None, max_length=255)
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
    reference: str | None = None
    tags: str = ""
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
    site_number: str | None = Field(default=None, max_length=32)
    site_building: str | None = Field(default=None, max_length=64)
    site_floor: str | None = Field(default=None, max_length=32)


class QuickLogCreate(BaseModel):
    """Log a call and let the file and contact appear underneath it."""

    model_config = ConfigDict(str_strip_whitespace=True)

    person: PersonIn
    site: SiteIn | None = None

    status: str = Field(default="open", pattern="^(%s)$" % "|".join(STATUSES))
    log_type: str = Field(default="General", max_length=64)
    category: str | None = Field(default=None, max_length=64)
    reference: str | None = Field(default=None, max_length=64)
    tags: str = Field(default="", max_length=255)
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
    # How an already-existing contact was recognised — "email", "phone" or
    # "company". None when the contact was created fresh (or none at all), so
    # the UI can say WHY no new contact appeared in the directory.
    contact_matched_by: str | None = None
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
    reference: str | None = None
    tags: str = ""
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
    role: str | None = None
    company_type: str | None = None
    socials: str | None = None            # JSON array of {platform, handle}
    # site (from the file)
    site_location: str | None = None
    city: str | None
    district: str | None = None
    street: str | None = None
    country: str | None = None
    maps_url: str | None = None
    site_number: str | None = None
    site_building: str | None = None
    site_floor: str | None = None
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
    # True when an email has already been sent to this row's address (any teammate),
    # so the grid can flag it and warn before re-emailing the same person.
    email_sent: bool = False


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
    """Flat row for the survey list — summaries instead of file/blob payloads."""

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
    has_measurements: int = 0
    measurement_count: int = 0
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


# ── custom cities (added on the fly, stored server-side) ────────────────────

class GeoCityIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    country: str = Field(min_length=1, max_length=64)
    district: str = Field(min_length=1, max_length=128)
    city: str = Field(min_length=1, max_length=128)


class GeoCityOut(GeoCityIn):
    model_config = ConfigDict(from_attributes=True)
    id: str


class GeoDistrictIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    country: str = Field(min_length=1, max_length=64)
    district: str = Field(min_length=1, max_length=128)


class GeoDistrictOut(GeoDistrictIn):
    model_config = ConfigDict(from_attributes=True)
    id: str


# ── Team chat ─────────────────────────────────────────────────────────────


class ChatMessageIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=4000)
    # None = post to the whole team; set = a private DM to this one user.
    recipient_user_id: str | None = Field(default=None, max_length=36)
    # User ids tagged in `text`, resolved on the client from the member list.
    mentions: list[str] = Field(default_factory=list)


class ChatMessagePatch(BaseModel):
    resolved: bool


class ChatMemberOut(BaseModel):
    """A teammate the chat can @mention or DM — id and display name only, so the
    directory is safe for any authenticated user (no email/role/PII)."""
    id: str
    name: str


class ChatMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    author_user_id: str | None = None
    author_name: str
    text: str
    # DM addressing (both None on a team-wide message).
    recipient_user_id: str | None = None
    recipient_name: str = ""
    # Parsed from the stored JSON string into a list for the client.
    mentions: list[str] = Field(default_factory=list)
    created_at: datetime

    @field_validator("mentions", mode="before")
    @classmethod
    def _parse_mentions(cls, value):
        if isinstance(value, str):
            if not value.strip():
                return []
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                return []
            return [str(x) for x in parsed] if isinstance(parsed, list) else []
        return value or []


# ── Page comments ─────────────────────────────────────────────────────────


# The comment workflow. "open" is the default, untagged state; the Comments-tab
# filter chips are All / Resolved / Testing / Done. Kept in sync with the values
# accepted by CommentPatch and rendered in ui/comment.js.
COMMENT_STATUSES = ("open", "testing", "done", "resolved")


class CommentIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    # Empty allowed: a comment may carry only an image/video and no words. The
    # client blocks posting when BOTH text and attachments are empty.
    text: str = Field(default="", max_length=4000)
    where: str = ""                      # page label; truncated to 128 server-side
    parent_id: str | None = None         # set to reply to a comment


class CommentAttachmentOut(BaseModel):
    """One image/video attached to a comment — what the panel renders inline."""

    model_config = ConfigDict(from_attributes=True)
    id: str
    comment_id: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


class CommentPatch(BaseModel):
    """Update a comment's workflow: its status and/or who has claimed it.

    ``assigned`` is a signal, not an id: True claims the comment for the current
    user (the server fills in the name), False releases it. Assignment is
    deliberately not restricted to the author — anyone may pick up a comment,
    which is the whole point of showing "Assigned by X" to the team.
    """

    model_config = ConfigDict(str_strip_whitespace=True)
    status: str | None = Field(default=None, pattern="^(%s)$" % "|".join(COMMENT_STATUSES))
    assigned: bool | None = None


class CommentReplyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    author_name: str
    where: str
    text: str
    created_at: datetime
    attachments: list[CommentAttachmentOut] = Field(default_factory=list)


class CommentOut(CommentReplyOut):
    status: str = "open"
    assigned_to_user_id: str | None = None
    assigned_to_name: str = ""
    replies: list[CommentReplyOut] = Field(default_factory=list)


class ContactInfoPhoneIn(BaseModel):
    """One phone number stored in ACHI's namespaced contact bucket."""

    model_config = ConfigDict(str_strip_whitespace=True)

    label: str = Field(default="Mobile", max_length=32)
    number: str = Field(..., min_length=1, max_length=50)


class ContactInfoEmailIn(BaseModel):
    """One labelled email stored in ACHI's namespaced contact bucket."""

    model_config = ConfigDict(str_strip_whitespace=True)

    label: str = Field(default="Other", max_length=32)
    address: EmailStr = Field(..., max_length=255)


class ContactInfoRelatedContactIn(BaseModel):
    """An alternate person to call when the main contact is unavailable."""

    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(..., min_length=1, max_length=255)
    tag: str | None = Field(default=None, max_length=64)
    phone: str = Field(..., min_length=1, max_length=50)


class ContactInfoQuickLinkIn(BaseModel):
    """A labelled URL shown in the Contact Info drawer."""

    model_config = ConfigDict(str_strip_whitespace=True)

    label: str = Field(..., min_length=1, max_length=40)
    url: str = Field(..., min_length=1, max_length=500)

    @field_validator("url")
    @classmethod
    def _safe_url(cls, value: str) -> str:
        lowered = value.lower()
        if not lowered.startswith(("https://", "http://", "mailto:", "tel:")):
            raise ValueError("quick-link URLs must start with http://, https://, mailto:, or tel:")
        return value


class ContactInfoContactIn(BaseModel):
    """Create or replace the Contact Info fields for a canonical OCE contact."""

    model_config = ConfigDict(str_strip_whitespace=True)

    record_type: str = Field(pattern=r"^(person|company)$")
    category: str = Field(
        default="prospect",
        pattern=r"^(client|prospect|lead|supplier|subcontractor|internal|other)$",
    )
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    middle_name: str | None = Field(default=None, max_length=255)
    prefix: str | None = Field(default=None, max_length=16)
    role: str | None = Field(default=None, max_length=64)
    company_name: str | None = Field(default=None, max_length=255)
    company_type: str | None = Field(default=None, max_length=64)
    primary_email: EmailStr | None = Field(default=None, max_length=255)
    emails: list[ContactInfoEmailIn] = Field(default_factory=list, max_length=8)
    phones: list[ContactInfoPhoneIn] = Field(default_factory=list, max_length=8)
    related_contacts: list[ContactInfoRelatedContactIn] = Field(default_factory=list, max_length=8)
    socials: list[SocialIn] = Field(default_factory=list, max_length=12)
    website: str | None = Field(default=None, max_length=500)
    country_code: str | None = Field(default=None, max_length=2)
    city: str | None = Field(default=None, max_length=128)
    location: str | None = Field(default=None, max_length=500)
    maps_url: str | None = Field(default=None, max_length=2048)
    source: str | None = Field(default=None, max_length=80)
    quick_links: list[ContactInfoQuickLinkIn] = Field(default_factory=list, max_length=12)
    notes: str | None = Field(default=None, max_length=5000)
    # When the contact was logged. Mirrors the Add Log popup's date/time; defaults
    # to "now" on the client, but is editable and stored so it can be shown back.
    contact_date: datetime | None = None

    @field_validator("maps_url")
    @classmethod
    def _safe_maps_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        try:
            parsed = urlparse(value)
        except ValueError as exc:
            raise ValueError("invalid Google Maps URL") from exc
        host = (parsed.hostname or "").lower()
        valid_host = (
            host in {"maps.app.goo.gl", "goo.gl", "google.com", "maps.google.com"}
            or host.endswith(".google.com")
        )
        if parsed.scheme not in {"http", "https"} or not valid_host:
            raise ValueError("map URL must be a Google Maps link")
        return value

    @model_validator(mode="after")
    def _validate_identity(self) -> "ContactInfoContactIn":
        if self.record_type == "company":
            if not self.company_name:
                raise ValueError("company_name is required for a company")
            self.first_name = None
            self.last_name = None
            self.middle_name = None
            self.prefix = None
            self.role = None
        elif not (self.first_name or self.last_name):
            raise ValueError("first_name or last_name is required for a person")

        if self.country_code:
            self.country_code = self.country_code.upper()
        if self.emails:
            self.primary_email = self.emails[0].address
        elif self.primary_email:
            self.emails = [ContactInfoEmailIn(label="Primary", address=self.primary_email)]
        return self
# ── Email (Log-page compose popup) ─────────────────────────────────────────


class EmailOut(BaseModel):
    """A sent-email record, as returned to the compose popup and (later) a mailbox
    view. ``status`` is "sent" or "failed"; ``backend`` is the transport that ran
    ("smtp" once the shared company mailbox is configured, "console" in dev)."""

    model_config = ConfigDict(from_attributes=True)
    id: str
    sender_user_id: str | None = None
    sender_name: str = ""
    to_email: str
    subject: str = ""
    body: str = ""
    log_id: str | None = None
    file_id: str | None = None
    contact_id: str | None = None
    status: str = "sent"
    backend: str = ""
    error: str = ""
    attachment_count: int = 0
    attachment_names: str = ""
    created_at: datetime
