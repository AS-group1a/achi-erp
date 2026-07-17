from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ModuleInfo(BaseModel):
    module: str
    version: str
    company: str
    note: str

STAGES = ("prospect", "lead", "site_survey", "measurements", "client")
STATUSES = ("open", "scheduled", "viewed", "cancelled", "done")
LOG_TYPES = ("inbound_call", "outbound_call", "quotation", "field", "job", "transfer", "note")


class ClientFileCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    is_company: bool = False
    prefix: str | None = Field(default=None, max_length=16)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    company_name: str | None = Field(default=None, max_length=255)

    mobile: str | None = Field(default=None, max_length=32)
    tel: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=255)

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
    def _require_a_name(self) -> "ClientFileCreate":
        """A file must be findable by a human. Enforce the name that matches is_company."""
        if self.is_company:
            if not (self.company_name or "").strip():
                raise ValueError("company_name is required when is_company is true")
        elif not ((self.first_name or "").strip() or (self.last_name or "").strip()):
            raise ValueError("first_name or last_name is required when is_company is false")
        return self


class ClientFileUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    prefix: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    company_name: str | None = None
    mobile: str | None = None
    tel: str | None = None
    email: str | None = None
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


class FileLogCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    log_type: str = Field(default="note", pattern="^(%s)$" % "|".join(LOG_TYPES))
    occurred_at: datetime | None = None
    duration_seconds: int | None = Field(default=None, ge=0)
    description: str = ""
    follow_up_date: date | None = None
    follow_up_notes: str = ""


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
    created_by: str | None
    created_at: datetime


class ClientFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    file_number: str
    display_name: str
    is_company: bool
    prefix: str | None
    first_name: str | None
    last_name: str | None
    company_name: str | None
    mobile: str | None
    tel: str | None
    email: str | None
    stage: str
    status: str
    country: str | None
    district: str | None
    city: str | None
    street: str | None
    site_location: str | None
    maps_url: str | None
    contact_id: str | None
    owner_user_id: str | None
    assigned_to_user_id: str | None
    notes: str
    created_at: datetime
    logs: list[FileLogOut] = []


class ClientFileListOut(BaseModel):
    """Deliberately flat and small — this is what a table renders.

    The Frappe list view needed 1,368 lines of JS because it rebuilt a grid by
    hand. The data was never the problem; don't let it become one here.
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    file_number: str
    display_name: str
    is_company: bool
    stage: str
    status: str
    mobile: str | None
    email: str | None
    city: str | None
    contact_id: str | None
    assigned_to_user_id: str | None
    created_at: datetime
