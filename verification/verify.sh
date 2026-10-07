#!/usr/bin/env bash
set -euo pipefail
mkdir -p /reports
java --version > /reports/toolchains.txt
node --version >> /reports/toolchains.txt
bash ./mvnw --version >> /reports/toolchains.txt
if bash ./mvnw -B -ntp -f backend/pom.xml verify > /reports/backend.log 2>&1; then
  tail -n 12 /reports/backend.log
else
  tail -n 80 /reports/backend.log
  exit 1
fi
cp -r backend/target/surefire-reports /reports/
npm --prefix frontend ci > /reports/frontend-install.log 2>&1
npm --prefix frontend test > /reports/frontend-test.log 2>&1
npm --prefix frontend run build > /reports/frontend-build.log 2>&1
tail -n 12 /reports/frontend-test.log
tail -n 12 /reports/frontend-build.log
printf '%s\n' 'Linux backend/real Redis/frontend verification passed.'
