ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY candidate.deb legacy.deb /fixtures/
COPY node /usr/local/bin/node
COPY scripts /fixtures/scripts
COPY packages /fixtures/packages
COPY acceptance/bootstrap/container.py /fixtures/container.py
RUN apt-get update && apt-get install -y python3 ca-certificates libatomic1 && /usr/local/bin/node --version && useradd --create-home fixture
ENTRYPOINT ["/usr/bin/python3", "-I", "/fixtures/container.py"]
