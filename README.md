# Server Administration — Tickets & Knowledge Base (Bobcares)

A collection of sanitized troubleshooting write-ups and knowledge-base articles from real server administration / infrastructure support cases, kept for future reference on similar issues.

Each article documents: the symptoms observed, the diagnostic path taken, the confirmed root cause(s), the exact commands used to resolve the issue, and any lessons learned. All customer-identifying details (names, tickets, domains, IPs, hostnames) are stripped or replaced with generic placeholders before publishing here.

## Tools

- [Chamilo Quiz Autopilot](tools/chamilo-quiz-autopilot/) — Firefox extension that answers a Chamilo quiz from your own answer key (handles shuffled questions/options), clicks *Next question*, pauses when unsure, and asks for confirmation before *End test*.
- [Bobcares Audit Autofill](tools/bobcares-audit-autofill/) — Firefox extension that fills in a new server audit from a screenshot of the previous one: every item that was green ✓ is marked *Active* again (dialog → Active → Submit), everything else is left as it is. Shows what it read for you to check first, and supports a dry run.

## Articles

- [SolusVM 2 / KVM: Live & Offline Migration Failures After a Hardware/Node Refresh](kb/solusvm-kvm-live-migration-troubleshooting.md) — CPU generation mismatch (`host-passthrough`) blocking live migration, plus an independent AlmaLinux/RHEL 9.8 libvirt regression blocking offline migration. Covers diagnosis, the CPU-baseline fix, a stuck-migration-lock recovery procedure, and a full verification checklist.
