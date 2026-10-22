# Local CPU background-removal sidecar (u2net).
#
# Base image digest was resolved from the Docker Hub registry manifest for
# library/python:3.12.11-slim-bookworm. Update it deliberately, never silently.
FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMBA_NUM_THREADS=1 \
    NUMBA_CACHE_DIR=/tmp/numba \
    U2NET_HOME=/opt/models \
    BG_REMOVAL_PORT=7000

WORKDIR /service

# Fully pinned runtime closure (no CLI/UI extras, no GPU runtime).
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt && pip check

# Build-time provisioning of the fixed u2net weights. The downloader verifies
# the upstream MD5 checksum and fails the build on mismatch, so a tampered or
# truncated artifact can never reach the runtime image.
COPY model.py provision.py ./
RUN python provision.py && ls -l /opt/models

COPY engine.py service.py ./
COPY licenses ./licenses

# The runtime user is not root, so the service files must stay world readable.
RUN chmod -R a+rX /service

# Unprivileged runtime user; the model file is world-readable and immutable.
USER 65532:65532

EXPOSE 7000

# Readiness == the checksum-verified model is loaded in the worker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys;\
r=urllib.request.urlopen('http://127.0.0.1:7000/health',timeout=4);\
sys.exit(0 if r.status==200 else 1)"]

CMD ["python", "service.py"]
