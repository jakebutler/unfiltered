# Local Medplum qualification

Synthetic development only. This uses the official Medplum 5.2.3 server/app with PostgreSQL and Redis. It is not the hosted Free plan and cannot prove that plan's entitlements or production authorization.

From the repository root:

```sh
node infra/local/init.mjs
docker compose --env-file infra/local/.env -f infra/local/compose.medplum.yml up -d --wait
```

The API listens at `http://localhost:8103` and Medplum App at `http://localhost:3000`, both bound to loopback. PostgreSQL and Redis have no host ports. Generated credentials stay in ignored `infra/local/.env` with mode 0600; the initializer preserves existing values. No email provider is configured. The bootstrap client is a local super-admin solely for creating isolated synthetic test projects and accounts; it must never become the application runtime credential or proof of staff authorization.

This machine's existing default Colima instance was unhealthy during setup. A separate profile was created without changing the active Docker context:

```sh
colima start unfiltered-s0 --activate=false --cpus 2 --memory 4 --disk 20 --mount none --ssh-config=false
docker --context colima-unfiltered-s0 compose --env-file infra/local/.env -f infra/local/compose.medplum.yml up -d --wait
```

Use that explicit Docker context for subsequent commands on this machine. `docker compose down` stops containers and preserves named data volumes; do not add `--volumes` unless intentionally discarding these synthetic fixtures. `colima stop unfiltered-s0` stops only this profile. The existing default profile was not deleted or reset.

Server readiness is only a setup check. The qualification harness must separately prove conditional writes, rollback/batch behavior, version conflicts, source resolution, role policy, and receipt recovery. All four images are pinned to the pulled ARM64 image digests in the Compose file. Another target architecture must resolve and qualify its matching images; these digests are not a demonstrated multi-architecture deployment. No cloud or paid inference calls are part of these commands.

On October 9, the API health check returned Medplum `5.2.3-39c4978` with PostgreSQL and Redis healthy; the App returned HTTP 200. Role and persistence qualification results are recorded separately. `.runtime.env`, when created by the access qualifier, contains an isolated local service client's credentials and is also ignored.

A network-disabled initialization container sets the named binary-storage volume's root to UID/GID 1000 and mode 0700, matching the pinned server's non-root user. This is required for actual Binary uploads; a healthy server alone does not test storage writability. The server itself continues to run as UID 1000.

Source: [Medplum full-stack guide](https://www.medplum.com/docs/self-hosting/running-full-medplum-stack-in-docker) and [versioned upstream configuration](https://github.com/medplum/medplum/blob/v5.2.3/docker-compose.full-stack.yml).
