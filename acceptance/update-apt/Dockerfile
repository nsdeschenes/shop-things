FROM ubuntu@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-apt apt-utils dpkg openssl acl gnupg && rm -rf /var/lib/apt/lists/*
COPY packages/electron/update /fixture/code
COPY acceptance/update-apt/run.py /fixture/run.py
ENTRYPOINT ["/usr/bin/python3", "-I", "/fixture/run.py"]
