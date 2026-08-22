# Plan 11a / D8 + FORK-C — production Postgres WITH pgBackRest inside the same image.
#
# FORK-C did not get decided, it DISSOLVED under measurement. `archive_command` executes inside
# the postgres SERVER's container: the spike booted `postgres:16` with
# `archive_command='pgbackrest ... archive-push %p'` and no binary installed and got
#
#     FATAL:  archive command failed with exit code 127
#     DETAIL:  The failed archive command was: pgbackrest --stanza=spike archive-push pg_wal/...
#
# so a sidecar or a host installation cannot do continuous WAL archiving AT ALL. `restore_command`
# has exactly the same shape on the way back. The binary therefore lives here, and the image stays
# a thin derivation of the stock one: same entrypoint, same data directory, same everything else.
#
# NOTHING PROVIDER-SHAPED IS BAKED IN (D4/GC1). pgbackrest.conf is deploy-directory config mounted
# at /etc/pgbackrest, and the object-store endpoint, bucket, keys and repo cipher passphrase arrive
# as PGBACKREST_* environment variables that deploy.sh derives from /opt/hmis-prod/.env.r2. Racked
# on on-prem metal against MinIO tomorrow, this file does not change and neither does the compose
# service — the six values are RE-POINTED.
#
# Built by deploy.sh as `hmis-prod/db:latest`; the compose `db` service runs it by tag.
FROM postgres:16

# pgbackrest comes from the PGDG repository the stock image already configures, so the version
# tracks the one the spike measured (2.59.1) rather than the distribution's older package.
# `pgbackrest version` at the end makes the build log itself the evidence that the binary is
# present and runs.
#
# ca-certificates IS NOT OPTIONAL AND IS NOT HYGIENE, and this was measured rather than foreseen:
# `postgres:16` ships NO system CA store at all (`/etc/ssl/certs` holds two files, neither of them
# a bundle, and the package is `un`), so the very first command pgBackRest sent to the object store
# died with
#
#     ERROR: [095]: unable to verify certificate presented by '<endpoint>:443': [20] unable to get
#            local issuer certificate
#
# The fix is the CA store, NOT `repo-storage-verify-tls=n`: turning verification off would make
# every backup and every restore trust whatever answered on port 443 (AGENT-RULES rule 14). No
# ca-file is named in pgbackrest.conf either, so the OpenSSL default path is used and a stage-3
# MinIO with a private CA re-points one environment variable instead of editing a config file.
#
# NEEDRESTART_MODE=l per AGENT-RULES rule 9. There is no needrestart inside this image, but the
# rule is unconditional and the guard costs nothing.
RUN set -eux; \
    NEEDRESTART_MODE=l apt-get update; \
    NEEDRESTART_MODE=l apt-get install -y --no-install-recommends pgbackrest ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    test -s /etc/ssl/certs/ca-certificates.crt; \
    install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest; \
    pgbackrest version
