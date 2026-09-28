/**
 * rules.js — mapping between `cpanel-audit.sh` report labels and the
 * Bob_Portal server-audit checklist.
 *
 * This is the ONLY file you should need to edit when the audit script's
 * output changes or when the portal checklist gains/renames an item.
 * No parser code changes are required.
 *
 * Each item:
 *   category      - label shown in the portal checklist (used to find the modal)
 *   titleAliases  - extra spellings accepted when matching the modal title in the DOM
 *   occurrence    - which modal to use when several share the same title
 *                   (0 = first in DOM order). "Control Panel", "Operating System"
 *                   and "CMS" appear under both Software Updates and Software Life Time.
 *   sources       - report labels to look for, in priority order. First hit wins.
 *   extras        - extra report labels appended to "Additional details" as context
 *   interpret     - how to turn the report value into active/inactive:
 *                     "standard"        verdict word at the start or in (parens)
 *                     "invert"          flip the verdict ("Reboot required: Yes" = bad)
 *                     "count-zero-good" numeric value; 0 = active, >0 = inactive
 *                     "presence"        non-empty / not "none" = active
 *   recommendation- attached only when the resolved status is "inactive"
 */

const AUDIT_RULES = {
  /* Verdict words, matched case-insensitively at the start of a value or
     inside a trailing (parenthesised) group. Longest phrase wins, so
     "not configured" is not mistaken for a bare "not". */
  verdicts: {
    active: [
      "good", "ok", "okay", "optimal", "running", "active", "enabled",
      "present", "installed", "configured", "secure", "supported",
      "healthy", "pass", "passed", "up to date", "up-to-date", "current",
      "normal", "low", "no issues", "none pending", "clean", "protected", "yes"
    ],
    inactive: [
      "not configured", "not installed", "not enabled", "not present",
      "not found", "not set", "not available", "no backup", "end of life",
      "end-of-life", "out of date", "update available", "updates available",
      "security update", "security updates", "needs attention",
      "eol versions present",
      "warning", "warn", "high", "critical", "error", "fail", "failed",
      "disabled", "inactive", "missing", "absent", "unknown", "outdated",
      "eol", "unsupported", "expired", "insecure", "weak", "exceeded",
      "full", "stale", "none", "no", "attention", "review", "partial"
    ]
  },

  /* Values that mean "there is nothing here" for interpret: "presence" */
  emptyValues: ["", "-", "n/a", "na", "none", "null", "not set", "unknown", "not available"],

  sections: [
    {
      section: "Threat Protection",
      items: [
        {
          category: "System Firewall",
          titleAliases: ["System Firewall", "Firewall"],
          sources: ["System Firewall", "Firewall"],
          recommendation: {
            issue: "No active host firewall was detected, or the running firewall is only partially configured.",
            recommendation: "Enable and configure a host firewall (firewalld/iptables/nftables) plus cPHulk, restricting inbound access to the ports the server actually needs.",
            hours: 1
          }
        },
        {
          category: "Malware Scanner",
          titleAliases: ["Malware Scanner", "Malware Scanning"],
          sources: ["Malware Scanner"],
          extras: ["ClamAV", "Bobcares scripts", "Cron job"],
          recommendation: {
            issue: "No malware scanner is installed, or scheduled scanning is not running.",
            recommendation: "Install ClamAV (or the panel's malware scanner) and schedule a recurring scan with alerting on detections.",
            hours: 1
          }
        },
        {
          category: "Failed Login Detection",
          titleAliases: ["Failed Login Detection", "Brute Force Protection", "Failed Login Protection"],
          sources: ["Failed Login Detection", "Brute Force Protection"],
          recommendation: {
            issue: "Failed-login / brute-force detection is not active on the server.",
            recommendation: "Enable cPHulk, Imunify360 or fail2ban so repeated failed authentication attempts are throttled and blocked automatically.",
            hours: 1
          }
        },
        {
          category: "Web App Firewall",
          titleAliases: ["Web App Firewall", "Web Application Firewall", "WAF", "ModSecurity"],
          sources: ["Web App Firewall", "Web Application Firewall", "ModSecurity"],
          recommendation: {
            issue: "Web Application Firewall (ModSecurity) rules engine status is unclear or the engine is off.",
            recommendation: "Enable and configure ModSecurity with an active rule set to protect against XSS, SQL injection and related web attacks.",
            hours: 1
          }
        },
        {
          category: "Rootkit Scanner",
          titleAliases: ["Rootkit Scanner", "Rootkit Scanning"],
          sources: ["Rootkit Scanner"],
          extras: ["chkrootkit", "rkhunter"],
          recommendation: {
            issue: "No rootkit scanner is installed on the server.",
            recommendation: "Install chkrootkit and rkhunter, and schedule periodic scans with results mailed to the administrator.",
            hours: 1
          }
        }
      ]
    },

    {
      section: "Software Updates",
      items: [
        {
          category: "Control Panel",
          titleAliases: ["Control Panel", "Control panel"],
          occurrence: 0,
          sources: ["Control panel", "Control Panel", "cPanel Version"],
          recommendation: {
            issue: "The control panel is not running the latest release available on its update tier.",
            recommendation: "Schedule a control panel update to the latest release in a maintenance window, after confirming a working backup.",
            hours: 1
          }
        },
        {
          category: "Operating System",
          titleAliases: ["Operating System", "OS"],
          occurrence: 0,
          sources: ["OS packages pending", "Operating System updates", "OS Updates"],
          interpret: "count-zero-good",
          extras: ["Security updates", "Package Manager", "Running kernel", "KernelCare", "Reboot required"],
          recommendation: {
            issue: "Operating system packages (including security updates) are pending installation.",
            recommendation: "Apply the pending OS and security updates in a maintenance window and reboot if kernel or core libraries were replaced.",
            hours: 1
          }
        },
        {
          category: "PHP",
          titleAliases: ["PHP"],
          sources: ["PHP pending", "PHP updates"],
          interpret: "count-zero-good",
          recommendation: {
            issue: "PHP packages have updates pending.",
            recommendation: "Update the installed PHP versions to the latest patch release for each branch in use.",
            hours: 1
          }
        },
        {
          category: "CMS",
          titleAliases: ["CMS"],
          occurrence: 0,
          sources: ["CMS pending", "CMS updates", "CMS core updates"],
          interpret: "count-zero-good",
          recommendation: {
            issue: "One or more hosted CMS installations are running outdated core/plugin versions.",
            recommendation: "Update the affected CMS cores, themes and plugins, or enable automatic minor-version updates where the site owner permits it.",
            hours: 2
          }
        },
        {
          category: "Web Server",
          titleAliases: ["Web Server", "Webserver", "Apache", "HTTPD"],
          sources: ["httpd/apache pending", "Web Server pending", "Apache pending"],
          interpret: "count-zero-good",
          recommendation: {
            issue: "The web server has package updates pending.",
            recommendation: "Update Apache/LiteSpeed/nginx to the current packaged release and restart the service in a maintenance window.",
            hours: 1
          }
        },
        {
          category: "Database Server",
          titleAliases: ["Database Server", "Database", "MySQL", "MariaDB"],
          sources: ["MySQL/MariaDB pending", "Database pending", "MySQL pending"],
          interpret: "count-zero-good",
          recommendation: {
            issue: "The database server has package updates pending.",
            recommendation: "Update MySQL/MariaDB to the current packaged release in a maintenance window, after a verified database dump.",
            hours: 1
          }
        },
        {
          category: "Other Softwares",
          titleAliases: ["Other Softwares", "Other Software", "Others"],
          sources: ["Other pending", "Other softwares pending"],
          interpret: "count-zero-good",
          recommendation: {
            issue: "Other installed packages have updates pending.",
            recommendation: "Review and apply the remaining pending package updates in a maintenance window.",
            hours: 1
          }
        }
      ]
    },

    {
      section: "Server Health",
      items: [
        {
          category: "Server Uptime",
          titleAliases: ["Server Uptime", "System Uptime"],
          sources: ["Server Uptime", "System Uptime"]
        },
        {
          category: "HTTP Uptime",
          titleAliases: ["HTTP Uptime", "Web Server Uptime"],
          sources: ["HTTP Uptime", "Web Server Uptime"]
        },
        {
          category: "CPU Usage",
          titleAliases: ["CPU Usage", "CPU"],
          sources: ["CPU Usage"],
          recommendation: {
            issue: "Sustained CPU load is above the comfortable range for this server's core count.",
            recommendation: "Identify the top CPU consumers, tune or throttle the responsible accounts/processes, and resize the server if the load is genuinely organic.",
            hours: 2
          }
        },
        {
          category: "RAM Usage",
          titleAliases: ["RAM Usage", "Memory Usage", "Memory"],
          sources: ["RAM Usage", "Memory Usage"],
          recommendation: {
            issue: "Memory utilisation is high enough to risk OOM events under peak load.",
            recommendation: "Review the largest memory consumers, tune service worker/pool limits, and add RAM if usage is legitimately at capacity.",
            hours: 2
          }
        },
        {
          category: "Disc Space Usage",
          titleAliases: ["Disc Space Usage", "Disk Space Usage", "Disk Usage", "Disc Usage"],
          sources: ["Disk Usage", "Disc Space Usage", "Disk Space Usage"],
          recommendation: {
            issue: "Disk utilisation is high enough that the filesystem could fill up.",
            recommendation: "Clear old logs/backups/temp data, review account quotas, and extend the volume if the growth is genuine.",
            hours: 1
          }
        },
        {
          category: "Email Queue",
          titleAliases: ["Email Queue", "Mail Queue"],
          sources: ["Email Queue", "Mail Queue"],
          recommendation: {
            issue: "The outbound mail queue is larger than expected, which usually indicates a delivery problem or a compromised/spamming account.",
            recommendation: "Inspect the queue for the dominant sender, deal with any compromised account or mailing loop, and clear frozen messages.",
            hours: 1
          }
        },
        {
          category: "IP Reputation",
          titleAliases: ["IP Reputation", "IP Blacklist", "RBL", "Blacklist Status"],
          sources: ["IP Reputation", "Blacklist Status", "RBL"],
          recommendation: {
            issue: "The server's main IP is listed on one or more blocklists / RBLs.",
            recommendation: "Fix the abuse source (compromised account, open relay, mailing practice), then request delisting from each blocklist.",
            hours: 2
          }
        }
      ]
    },

    {
      section: "Backup",
      items: [
        {
          category: "Local",
          titleAliases: ["Local", "Local Backup", "Local Backups"],
          sources: ["Local Backup", "Backup Local", "Local backups"],
          recommendation: {
            issue: "Local backups are not configured or are not completing.",
            recommendation: "Enable the panel's backup system with a local destination and verify that the most recent run completed successfully.",
            hours: 1
          }
        },
        {
          category: "Remote",
          titleAliases: ["Remote", "Remote Backup", "Remote Backups", "Offsite Backup"],
          sources: ["Remote Backup", "Backup Remote", "Remote backups"],
          recommendation: {
            issue: "No off-server backup destination is configured, so a host-level failure would lose all data.",
            recommendation: "Configure an additional remote/offsite backup destination and verify a restore from it.",
            hours: 2
          }
        },
        {
          category: "Daily",
          titleAliases: ["Daily", "Daily Backup"],
          sources: ["Daily Backup", "Backup Daily"],
          recommendation: {
            issue: "Daily backup retention is not enabled.",
            recommendation: "Enable daily backups with a retention period agreed with the customer.",
            hours: 1
          }
        },
        {
          category: "Weekly",
          titleAliases: ["Weekly", "Weekly Backup"],
          sources: ["Weekly Backup", "Backup Weekly"],
          recommendation: {
            issue: "Weekly backup retention is not enabled.",
            recommendation: "Enable weekly backups with a retention period agreed with the customer.",
            hours: 1
          }
        },
        {
          category: "Monthly",
          titleAliases: ["Monthly", "Monthly Backup"],
          sources: ["Monthly Backup", "Backup Monthly"],
          recommendation: {
            issue: "Monthly backup retention is not enabled.",
            recommendation: "Enable monthly backups with a retention period agreed with the customer.",
            hours: 1
          }
        },
        {
          category: "Recent Last Backup",
          titleAliases: ["Recent Last Backup", "Last Backup", "Most Recent Backup"],
          sources: ["Last Backup", "Recent Last Backup", "Last backup age"],
          recommendation: {
            issue: "The most recent backup is older than the agreed backup interval.",
            recommendation: "Investigate why the backup schedule is not completing (disk space, destination credentials, transport errors) and run a fresh backup.",
            hours: 1
          }
        },
        {
          category: "Size Of Last Backup",
          titleAliases: ["Size Of Last Backup", "Last Backup Size", "Backup Size"],
          sources: ["Last Backup Size", "Backup Size", "Size of last backup"],
          recommendation: {
            issue: "The size of the latest backup looks inconsistent with the data on the server, which can indicate a truncated or partial backup.",
            recommendation: "Compare the backup size against account usage and run a test restore to confirm the backup set is complete.",
            hours: 1
          }
        }
      ]
    },

    {
      section: "Software Life Time",
      items: [
        {
          category: "Control Panel",
          titleAliases: ["Control Panel", "Control panel"],
          occurrence: 1,
          sources: ["Control Panel", "Control Panel EOL", "Control panel lifetime"],
          recommendation: {
            issue: "The installed control panel version is at or approaching end of life.",
            recommendation: "Plan an upgrade to a supported control panel release before the vendor's end-of-life date.",
            hours: 2
          }
        },
        {
          category: "Operating System",
          titleAliases: ["Operating System", "OS"],
          occurrence: 1,
          sources: ["Operating System", "OS EOL", "Operating System Life Time", "OS / Version"],
          recommendation: {
            issue: "The operating system release is at or approaching end of life, so it will stop receiving security patches.",
            recommendation: "Plan a migration or in-place upgrade to a supported OS release well before the end-of-life date.",
            hours: 4
          }
        },
        {
          category: "CMS",
          titleAliases: ["CMS"],
          occurrence: 1,
          sources: ["CMS", "CMS EOL", "CMS Life Time", "Outdated CMS"],
          recommendation: {
            issue: "One or more hosted CMS installations run a branch that is no longer receiving security fixes.",
            recommendation: "Upgrade the affected sites to a supported CMS branch, or isolate them if the site owner declines.",
            hours: 2
          }
        },
        {
          category: "Software Stack",
          titleAliases: ["Software Stack", "Stack"],
          occurrence: 0,
          sources: ["PHP EOL", "Software Stack", "Stack EOL", "Software stack lifetime"],
          extras: ["PHP versions", "PHP default"],
          recommendation: {
            issue: "Part of the software stack (PHP branch, database server or web server) is past its supported lifetime.",
            recommendation: "Move the affected components onto supported versions, coordinating PHP branch moves with the site owners.",
            hours: 3
          }
        }
      ]
    },

    {
      section: "Proactive Defence",
      items: [
        {
          category: "/tmp Security",
          titleAliases: ["/tmp Security", "tmp Security", "Tmp Security"],
          sources: ["/tmp noexec", "/tmp Security", "tmp Security", "/tmp partition"],
          recommendation: {
            issue: "/tmp is not mounted with the hardening options that stop code execution from world-writable temp space.",
            recommendation: "Mount /tmp (and /var/tmp, /dev/shm) with noexec, nosuid and nodev, after confirming no legitimate application depends on executing from /tmp.",
            hours: 1
          }
        },
        {
          category: "Reboot Procedure",
          titleAliases: ["Reboot Procedure", "Reboot"],
          sources: ["Reboot Procedure", { label: "Reboot required", interpret: "invert" }],
          extras: ["Services to restart", "KernelCare", "Running kernel"],
          recommendation: {
            issue: "Core components have been updated since the last boot, so the running kernel/libraries differ from what is installed on disk.",
            recommendation: "Schedule a reboot (or restart the listed services) in an agreed maintenance window so the updated components are actually in use.",
            hours: 1
          }
        },
        {
          category: "IP RDNS",
          titleAliases: ["IP RDNS", "RDNS", "rDNS", "Reverse DNS"],
          sources: ["IP RDNS", "Reverse DNS", { label: "rDNS", interpret: "presence" }],
          extras: ["Hostname", "Main IP"],
          recommendation: {
            issue: "Reverse DNS for the main IP is missing or does not match the server hostname, which hurts outbound mail deliverability.",
            recommendation: "Set the PTR record for the main IP to the server hostname with the IP owner, and make sure forward and reverse records agree.",
            hours: 1
          }
        },
        {
          category: "Malware Scan",
          titleAliases: ["Malware Scan", "Malware Scan Run"],
          sources: ["Malware Scan", "Last Malware Scan", "Scan triggered"],
          recommendation: {
            issue: "No recent malware scan has been run on the server.",
            recommendation: "Run a full malware scan, review the findings with the customer, and schedule recurring scans.",
            hours: 2
          }
        },
        {
          category: "Rootkit Check",
          titleAliases: ["Rootkit Check", "Rootkit Scan"],
          sources: ["Rootkit Check", "Last Rootkit Scan", "Rootkit Scan"],
          recommendation: {
            issue: "No recent rootkit check has been run on the server.",
            recommendation: "Run chkrootkit/rkhunter, review the findings, and schedule the check to run periodically.",
            hours: 1
          }
        },
        {
          category: "SSH Root Access Security",
          titleAliases: ["SSH Root Access Security", "SSH Root Access", "SSH Root Login"],
          sources: [
            "SSH Root Access",
            "PermitRootLogin",
            "SSH Root Login",
            { label: "SSH Password Auth", interpret: "invert" }
          ],
          extras: ["SSH Password Auth", "SSH Port(s)"],
          recommendation: {
            issue: "SSH allows direct root login and/or password authentication, widening the brute-force surface.",
            recommendation: "Disable direct root login and password authentication in sshd_config, moving to key-based access for a sudo-capable user (coordinate with the customer first).",
            hours: 1
          }
        },
        {
          category: "PHP Functions Security",
          titleAliases: ["PHP Functions Security", "PHP Functions", "Disabled PHP Functions"],
          sources: ["PHP Functions", "Disabled PHP functions", "PHP disable_functions"],
          recommendation: {
            issue: "Dangerous PHP functions are not disabled, so a single compromised script can execute system commands.",
            recommendation: "Disable exec, system, passthru, shell_exec, popen and proc_open via disable_functions, after checking no hosted application depends on them.",
            hours: 1
          }
        },
        {
          category: "Root password health",
          titleAliases: ["Root password health", "Root Password Health", "Root Password"],
          sources: ["Root password", "Root Password Health", "Root password strength"],
          recommendation: {
            issue: "The root password does not meet current strength/rotation policy.",
            recommendation: "Rotate the root password to a long random value stored in the password manager, and record the rotation date.",
            hours: 1
          }
        }
      ]
    }
  ]
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = AUDIT_RULES;
}
if (typeof window !== "undefined") {
  window.AUDIT_RULES = AUDIT_RULES;
}
