ARG BASE
FROM ${BASE}
COPY *.whl /tmp/security-wheels/
COPY requirements.txt /tmp/security-wheels/requirements.txt
RUN python -m pip install --no-index --no-deps --require-hashes --find-links=/tmp/security-wheels -r /tmp/security-wheels/requirements.txt && python -m pip check && rm -rf /tmp/security-wheels
