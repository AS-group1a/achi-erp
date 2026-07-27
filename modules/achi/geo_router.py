"""Custom cities for the Add Log site-info cascade.

The country/district/city dropdowns are driven by a predefined map in the page.
When a district's city is missing, the user adds it here and it is saved for
everyone — the reason this is a server route and not the per-browser localStorage
the other add-your-own picklists use.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.dependencies import CurrentUserId, SessionDep

from .models import GeoCity
from .schemas import GeoCityIn, GeoCityOut

geo_router = APIRouter()
logger = logging.getLogger(__name__)


@geo_router.get("/geo/cities", response_model=list[GeoCityOut],
                summary="User-added cities (predefined ones live in the page)")
async def list_cities(
    session: SessionDep, _user_id: CurrentUserId,
    country: str | None = Query(default=None),
    district: str | None = Query(default=None),
) -> list[GeoCityOut]:
    q = select(GeoCity).order_by(GeoCity.city)
    if country:
        q = q.where(func.lower(GeoCity.country) == country.strip().lower())
    if district:
        q = q.where(func.lower(GeoCity.district) == district.strip().lower())
    return [GeoCityOut.model_validate(c) for c in (await session.execute(q)).scalars().all()]


@geo_router.post("/geo/cities", response_model=GeoCityOut,
                 status_code=status.HTTP_201_CREATED, summary="Add a city for a district")
async def add_city(data: GeoCityIn, session: SessionDep, user_id: CurrentUserId) -> GeoCityOut:
    # Idempotent: adding a city that already exists (predefined or custom) returns
    # the existing row rather than erroring — the UI treats add-existing as select.
    existing = (await session.execute(
        select(GeoCity).where(
            func.lower(GeoCity.country) == data.country.lower(),
            func.lower(GeoCity.district) == data.district.lower(),
            func.lower(GeoCity.city) == data.city.lower(),
        )
    )).scalar_one_or_none()
    if existing:
        return GeoCityOut.model_validate(existing)
    row = GeoCity(country=data.country, district=data.district, city=data.city, created_by=user_id)
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:            # lost a race on the unique index — fetch the winner
        await session.rollback()
        row = (await session.execute(
            select(GeoCity).where(
                func.lower(GeoCity.country) == data.country.lower(),
                func.lower(GeoCity.district) == data.district.lower(),
                func.lower(GeoCity.city) == data.city.lower(),
            )
        )).scalar_one()
        return GeoCityOut.model_validate(row)
    await session.refresh(row)
    logger.info("achi: city added %s / %s / %s", data.country, data.district, data.city)
    return GeoCityOut.model_validate(row)
