# Pinned. Upstream ships ~2.9 releases/day and its version numbers carry no
# compatibility signal (10.9.0 -> 11.9.0 in six days), so never track :latest.
FROM python:3.12-slim

ARG OCE_VERSION=11.9.0

# libgl/libglib: opencv-python-headless still dlopen()s them at import.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "openconstructionerp==${OCE_VERSION}"

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
