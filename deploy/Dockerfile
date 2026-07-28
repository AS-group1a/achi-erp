# Pinned. Upstream ships ~2.9 releases/day and its version numbers carry no
# compatibility signal (10.9.0 -> 11.9.0 in six days), so never track :latest.
# -bookworm is pinned deliberately for a stable, glibc-known toolchain (bare
# python:3.12-slim now tracks trixie). It is also the base the DDC converter
# .debs below install cleanly on — verified by a live runtime install.
FROM python:3.12-slim-bookworm

ARG OCE_VERSION=11.9.0

# libgl/libglib: opencv-python-headless still dlopen()s them at import.
# fonts-dejavu-core: so text labels in a drawing render (geometry renders without
#   a font, but labels do not).
# ca-certificates: HTTPS apt for the DDC converter repo below.
# These are essential — the build fails if any is missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 curl fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# DDC DWG converter (DataDrivenConstruction) — the engine OCE's Takeoff module
# uses to read DWG. cad_render.py converts DWG through it (convert_cad_to_excel).
# Baked in here so it survives image rebuilds: OCE's runtime installer runs as
# root and lands the binary in /usr/bin, which every `docker compose up --build`
# wipes — so a runtime install would have to be redone after every deploy. apt
# also resolves the binary's system libraries (a bare extraction does not).
# BEST-EFFORT: a repo outage or version drift must NEVER freeze the deploy (the
# libredwg-on-trixie lesson) — DWG preview then falls back to download, and an
# admin can still install at runtime via the Takeoff UI. amd64 only (x86 binary).
RUN echo "deb [trusted=yes] https://pkg.datadrivenconstruction.io stable main" > /etc/apt/sources.list.d/ddc.list \
    && ( apt-get update && apt-get install -y --no-install-recommends \
            ddc-dwgconverter ddc-deps-kernel ddc-deps-drawings ddc-deps-architecture ddc-thirdparty \
         || echo "WARN: DDC DWG converter not baked in (repo unreachable / version drift); runtime install still available" ) \
    && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/ddc.list

RUN pip install --no-cache-dir "openconstructionerp==${OCE_VERSION}"

# --- ACHI's own module -------------------------------------------------------
# The loader scans app/modules/ on the filesystem (MODULES_DIR is hardcoded to the
# installed package; there is no entry-point or env-var path for modules, unlike
# packs). So our module is copied in at build time. This is still NOT a fork:
# upstream's own files are untouched and OCE_VERSION upgrades cleanly.
# The python path is resolved rather than hardcoded so a base-image python bump
# doesn't silently drop the module.
COPY modules/achi /tmp/achi
RUN APP_DIR="$(python -c 'import app, pathlib; print(pathlib.Path(app.__file__).parent)')"     && cp -r /tmp/achi "$APP_DIR/modules/achi"     && rm -rf /tmp/achi     && python -c "from app.core.module_loader import module_loader; assert any(m.name=='oe_achi' for m in module_loader.discover()), 'oe_achi not discovered'; print('oe_achi discovered OK')"

# Pack discovery ignores --data-dir and always resolves to ~/.openestimate
# (app/core/module_state.py::_resolve_data_dir — the SQLite branch is dead since
# v6.6.0). HOME must therefore be a mounted volume or the pack vanishes on recreate.
ENV HOME=/data
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

EXPOSE 8080
CMD ["openconstructionerp", "serve", "--host", "0.0.0.0", "--port", "8080", \
     "--data-dir", "/data", "--no-demo", "--quiet"]
