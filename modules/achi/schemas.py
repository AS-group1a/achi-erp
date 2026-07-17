from __future__ import annotations

from pydantic import BaseModel, Field


class ModuleInfo(BaseModel):
    module: str
    version: str
    company: str
    note: str


class ScaffoldComponentOut(BaseModel):
    id: str
    code: str
    description: str = ""
    weight_kg: float | None = Field(default=None)
