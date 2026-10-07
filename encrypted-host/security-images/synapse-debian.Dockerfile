ARG BASE
FROM ${BASE}
COPY repository /tmp/security-repository
COPY security.sources /tmp/security.sources
RUN mkdir -p /tmp/security-lists/partial /tmp/security-archives/partial && \
    apt-get -o Dir::Etc::sourcelist=/tmp/security.sources -o Dir::Etc::sourceparts=- -o Dir::State::lists=/tmp/security-lists -o Dir::Cache::archives=/tmp/security-archives update && \
    apt-get -o Dir::Etc::sourcelist=/tmp/security.sources -o Dir::Etc::sourceparts=- -o Dir::State::lists=/tmp/security-lists -o Dir::Cache::archives=/tmp/security-archives --yes --no-install-recommends --no-remove --only-upgrade install libpcre2-8-0=10.46-1~deb13u3 libssl3t64=3.5.7-1~deb13u3 openssl=3.5.7-1~deb13u3 openssl-provider-legacy=3.5.7-1~deb13u3 && \
    python -m pip check && \
    rm -rf /tmp/security-repository /tmp/security.sources /tmp/security-lists /tmp/security-archives
