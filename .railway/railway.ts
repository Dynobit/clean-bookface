// Railway SDK 3.12.0 / CLI >=5.42.1. Read docs/INSTALL.md before planning.
// Applying this file creates paid resources; it does not select a billing plan.
import { defineRailway, github, project, service, volume } from 'railway/iac';

// Edit this example in your own private deployment copy before creating users.
const domain = 'friends.example';
const repository = 'Dynobit/clean-bookface';
const region = 'europe-west4';

export default defineRailway(() => {
  const data = volume('bookface-data', { region, sizeMB: 20_000 });
  const app = service('clean-bookface', {
    source: github(repository, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node provider-start.mjs server',
    healthcheck: '/healthz',
    healthcheckTimeout: 120,
    replicas: { [region]: 1 },
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      overlapSeconds: 0,
      drainingSeconds: 60,
      sleepApplication: false,
    },
    domains: [{ domain, port: 3000 }],
    volumeMounts: { '/data': data },
    tracing: { enabled: false, autoInstrumentation: false },
    env: {
      NODE_ENV: 'production',
      APP_ORIGIN: `https://${domain}`,
      INSTANCE_NAME: 'Our circle',
      BIND_ADDRESS: '0.0.0.0',
      PORT: '3000',
      DATA_DIR: '/data',
      FEDERATION_ENABLED: 'false',
      MAINTENANCE_MODE: 'false',
      MAX_UPLOAD_BYTES: '1073741824',
      // 5 GiB total archive allowance; remaining disk supports staging,
      // derivatives and the database. Backups need separate storage.
      MAX_ACCOUNTS: '5',
      ARCHIVE_ACCOUNT_BYTES: '1073741824',
      // Only the narrow bootstrap starts as root. The server and CLI drop to
      // uid/gid 1000 before opening the database or handling any request.
      RAILWAY_RUN_UID: '0',
    },
  });
  return project('clean-bookface', { resources: [app, data] });
});
