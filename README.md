# Server Administration — Tickets & Knowledge Base (Bobcares)

A collection of sanitized troubleshooting write-ups and knowledge-base articles from real server administration / infrastructure support cases, kept for future reference on similar issues.

Each article documents: the symptoms observed, the diagnostic path taken, the confirmed root cause(s), the exact commands used to resolve the issue, and any lessons learned. All customer-identifying details (names, tickets, domains, IPs, hostnames) are stripped or replaced with generic placeholders before publishing here.

## Articles

- [SolusVM 2 / KVM: Live & Offline Migration Failures After a Hardware/Node Refresh](kb/solusvm-kvm-live-migration-troubleshooting.md) — CPU generation mismatch (`host-passthrough`) blocking live migration, plus an independent AlmaLinux/RHEL 9.8 libvirt regression blocking offline migration. Covers diagnosis, the CPU-baseline fix, a stuck-migration-lock recovery procedure, and a full verification checklist.
- [PHP OPcache: RAM-Aware Tuning Across Multiple PHP Versions (cPanel/EA4 + PHP-FPM)](kb/php-opcache-tuning-multi-php-servers.md) — how OPcache allocates shared memory (one segment per PHP-FPM master, not per user or worker), a RAM-budgeted sizing framework for servers running several PHP versions side by side, making the settings survive PHP package updates, verification from the live FPM process, and ruling out the bottlenecks OPcache tuning will not fix.
