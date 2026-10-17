#!/bin/bash
set -euo pipefail
umask 077
# Qualified AMI provides this exact hashed package, Node22, Docker Compose v2,
# AWS CLI v2, util-linux and ext4 tools. This script NEVER formats a volume.
test "$#" -eq 5
VOLUME_ID="$1"; SECRET_ARN="$2"; PACKAGE_HASH="$3"; PHASE="$4"; REGION="$5"
test "$PHASE" = initialize -o "$PHASE" = resume
cd /opt/unfiltered-medplum
node - "$PACKAGE_HASH" <<'JS'
const fs = require('node:fs'), crypto = require('node:crypto');
if (process.versions.node !== '22.22.3') process.exit(1);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const p = JSON.parse(fs.readFileSync('package.json'));
if (p.packageHash !== process.argv[2] || digest(JSON.stringify(p.files)) !== p.packageHash || p.platform !== 'linux/arm64') process.exit(1);
for (const [name, expected] of Object.entries(p.files)) {
  if (!/^(?:[A-Za-z0-9_-]+\.mjs|compose\.yml|images\.lock\.json|bootstrap\.sh|clinic\.json)$/.test(name)) process.exit(1);
  const stat = fs.lstatSync(name);
  if (!stat.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(name)) !== expected) process.exit(1);
}
JS
node volume.mjs --volume-id "$VOLUME_ID" --clinic /opt/unfiltered-medplum/clinic.json
install -d -m 0700 /run/unfiltered-medplum
BASE="$(mktemp -d /run/unfiltered-medplum/runtime.XXXXXXXXXXXX)"
export AWS_MAX_ATTEMPTS=1 AWS_PAGER='' AWS_DEFAULT_REGION="$REGION"
aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text --cli-connect-timeout 5 --cli-read-timeout 10 > "$BASE/backend-secret.json"
node render.mjs --backend-secret "$BASE/backend-secret.json" --phase "$PHASE" --data /srv/unfiltered-medplum --output "$BASE/config" --listen 0.0.0.0:8103
rm -- "$BASE/backend-secret.json"
PROJECT="$(node -e 'const p=require("./package.json"), c=require("./clinic.json"); process.stdout.write("uf-aws-medplum-"+c.stackId+"-"+p.profileHash.slice(0,12))')"
# Only paths/public identity enter systemd's environment; private values remain files.
printf 'CONFIG=%s\nPROJECT=%s\n' "$BASE/config" "$PROJECT" > /run/unfiltered-medplum/service.env
