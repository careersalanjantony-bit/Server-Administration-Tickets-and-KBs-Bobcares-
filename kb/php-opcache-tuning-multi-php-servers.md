# PHP OPcache: RAM-Aware Tuning Across Multiple PHP Versions (cPanel/EA4 + PHP-FPM)

> **Category:** Web Hosting / PHP / Performance Tuning
> **Applies to:** cPanel/WHM with EasyApache 4, multiple `ea-phpXX` versions installed, PHP-FPM handler; concepts transfer to any multi-version PHP host
> **Symptom class:** PHP-heavy sites recompiling code on every request, OPcache thrashing/restarting, or a server where "raise OPcache memory" was applied without a RAM budget

> **Note on identifiers:** all hostnames, usernames, domains and version numbers below are illustrative placeholders. Replace them with your own environment's values.

---

## TL;DR

The recommendation that actually holds up on a shared server is **not** a fixed number — it's a budget:

1. **Measure before you size.** Count the PHP files that will be cached, read the live `opcache_get_status()` counters, and check whether the server is even OPcache-bound. Sizing from guesses is how you end up with 3 GB of shared memory reserved on a box that is short on RAM.
2. **Budget `memory_consumption + interned_strings_buffer` per PHP version that has running FPM pools** — not per worker, not per site. Keep the total for all versions combined under **~10% of physical RAM** (hard ceiling ~15%).
3. **Do not give standby versions the same allocation as the active one.** Aligning PHP 8.3/8.4 with 8.2 "ahead of a future upgrade" is sound housekeeping *only* while those versions have no pools running. The moment they do, your OPcache footprint multiplies by the number of versions.
4. **The two settings that most often actually hurt** are `interned_strings_buffer` (8 MB default is too small for WordPress/WooCommerce-class code) and `max_accelerated_files` (default too low for a busy shared server). `memory_consumption` is the one people raise first and usually need least.
5. **Put the settings in a `zz-`prefixed drop-in under `php.d/`**, never in the EA4-owned `10-opcache.ini`, or a PHP package update will silently revert them.

---

## 1. When This Applies

Reach for this when any of the following is true:

- Sites on the server are CPU-heavy on PHP and the server has plenty of RAM headroom that OPcache isn't using.
- `opcache_get_status()` shows **`oom_restarts` or `hash_restarts` climbing**, which means OPcache is flushing and recompiling the whole cache repeatedly.
- `interned_strings_usage.free_memory` is at or near **0**.
- `num_cached_keys` is close to `max_cached_keys`.
- Multiple PHP versions are installed and their OPcache configuration has drifted apart, so behaviour depends on which version a site happens to be on.

**When this does *not* apply:** if the server is already under memory pressure, swapping, or saturating its FPM pools, OPcache tuning is the wrong lever and raising `memory_consumption` will make things worse. See §9.

---

## 2. How OPcache Actually Allocates Memory

This is the part that determines the RAM budget, and it is the part most often gotten wrong.

**One shared memory segment per PHP-FPM master process.** Under the PHP-FPM handler, each `ea-phpXX-php-fpm` service is one master process, and it allocates **one** OPcache shared memory segment at startup. Every worker of every pool under that master shares it.

This means:

- Ten pools (ten cPanel users) on PHP 8.2 → **one** segment, not ten.
- Fifty workers on PHP 8.2 → **one** segment, not fifty.
- PHP 8.1, 8.2 and 8.3 each with running pools → **three** segments.

So the multiplier for your budget is **the number of PHP versions with at least one active FPM pool**, and nothing else.

> **Handler caveat.** This one-segment-per-version model is specific to PHP-FPM. Under LiteSpeed/`mod_lsapi`, per-user `lsphp` process groups can each carry their own OPcache segment, which multiplies the footprint by *users*, not versions — a completely different and much larger budget. Under CGI/suPHP, OPcache gives almost nothing because the process dies with the request. Confirm the handler before applying any of the numbers below.

**Budget the interned strings buffer as additive.** Treat each version's footprint as:

```
memory_consumption + interned_strings_buffer
```

Whether the interned strings buffer is carved out of the opcode buffer or reserved on top of it has varied across PHP branches; the additive assumption is the safe one for capacity planning. Confirm the real figure against live `opcache_get_status()` output (§8) rather than against theory.

**Reserved is not resident — but plan as if it were.** The segment is mapped at startup and pages are faulted in as files are cached, so a freshly restarted FPM master does not immediately show the full `memory_consumption` as resident. On a busy server it will fill. Budget for the full number.

---

## 3. Collect the Data Before You Size Anything

Run all of this *before* the maintenance window. The output is what turns "how much should we give it?" into an answerable question.

### 3.1 The RAM budget itself

```bash
free -m
# Note: "available", not "free" — that is the number that matters.

# Is the box already swapping? If yes, stop and fix that first.
vmstat 1 5
swapon --show
```

### 3.2 Which PHP versions exist, and which are actually serving

```bash
# Installed versions
whmapi1 php_get_installed_versions

# System default
whmapi1 php_get_system_default_version

# Which domain runs which version — this tells you what is actually in use
whmapi1 php_get_vhost_versions | grep -E 'version|vhost'

# Which handler each version uses (FPM vs CGI vs suPHP vs lsapi)
whmapi1 php_get_handlers
```

Then the decisive check — **how many FPM masters are actually running**:

```bash
systemctl list-units 'ea-php*-php-fpm*' --no-pager

# Pool count per version (0 pools = that version costs nothing today)
for v in /opt/cpanel/ea-php*; do
  n=$(ls "$v"/root/etc/php-fpm.d/*.conf 2>/dev/null | wc -l)
  echo "$(basename "$v"): $n pool(s)"
done
```

### 3.3 How many PHP files need caching

This sizes `max_accelerated_files` directly:

```bash
# Total PHP files across all user docroots.
# Expect this to take a while on a large server; run it with nice/ionice.
nice -n 19 ionice -c3 find /home -type f -name '*.php' 2>/dev/null | wc -l
```

Compare the result against your configured `max_accelerated_files`. If it exceeds it, OPcache cannot hold the working set and will evict/restart continuously.

### 3.4 Current configuration per version

```bash
for v in /opt/cpanel/ea-php*/root/usr/bin/php; do
  echo "=== $v ==="
  "$v" -i 2>/dev/null | grep -E '^opcache\.(enable|memory_consumption|interned_strings_buffer|max_accelerated_files|max_wasted_percentage|validate_timestamps|revalidate_freq|save_comments|jit)'
done
```

> `php -i` from the CLI shows the **configuration** the FPM master would load, not the FPM master's **runtime state**. The CLI SAPI has its own (usually disabled) OPcache instance. For runtime counters you must ask the FPM process — see §8.

### 3.5 Runtime counters from the live FPM process

The numbers that tell you whether the current sizing is wrong. See §8 for how to obtain them. The four that matter:

| Counter | What it means if it's bad |
|---|---|
| `opcache_statistics.oom_restarts` | **> 0 and climbing** → `memory_consumption` too small |
| `opcache_statistics.hash_restarts` | **> 0 and climbing** → `max_accelerated_files` too small |
| `interned_strings_usage.free_memory` | **at/near 0** → `interned_strings_buffer` too small |
| `opcache_statistics.opcache_hit_rate` | **< ~95%** on steady traffic → cache is not holding the working set |

A server with all four healthy does not need OPcache tuning, whatever its RAM.

---

## 4. The RAM-Aware Sizing Framework

### 4.1 The ceiling

```
Total OPcache across all versions  ≤  10% of physical RAM        (target)
                                   ≤  15% of physical RAM        (hard ceiling)
```

OPcache competes with the MySQL/MariaDB buffer pool, PHP-FPM worker RSS (typically 40–120 MB per worker and by far the largest consumer on a busy box), the web server, and the kernel page cache. On a shared hosting server, page cache and the DB buffer pool buy you more than an oversized opcode cache does.

### 4.2 Starting points by server RAM

Per **active** version (has running FPM pools) and per **standby** version (installed, no pools yet):

| Physical RAM | `memory_consumption` (active) | `memory_consumption` (standby) | `interned_strings_buffer` | `max_accelerated_files` |
|---|---|---|---|---|
| 4 GB   | 96 MB      | 64 MB  | 8 MB  | 16229 |
| 8 GB   | 128 MB     | 64 MB  | 16 MB | 16229 |
| 16 GB  | 256 MB     | 128 MB | 16 MB | 32531 |
| 32 GB  | 384 MB     | 192 MB | 32 MB | 32531 |
| 64 GB  | 512 MB     | 256 MB | 32 MB | 32531 |
| 128 GB+| 512–768 MB | 256 MB | 64 MB | 65407 |

These are **starting points to be corrected by §3.5 counters**, not targets to hit. If measured peak `used_memory` on the active version sits at 140 MB, a 512 MB allocation is 370 MB of reserved-but-idle RAM per version — it is not "headroom for later", it is memory the DB could have used.

The working rule: **`memory_consumption` ≈ measured peak `used_memory` × 1.5–2**.

### 4.3 Worked example — 32 GB server, 6 installed versions, 2 active

Installed: PHP 7.4, 8.0, 8.1, 8.2, 8.3, 8.4. Active pools on 8.1 and 8.2 only.

**Budget:** 10% of 32 GB ≈ **3.2 GB** total ceiling.

*The naive approach* — align every version to 512/32, the same profile, "so they're ready":

```
6 × (512 + 32) = 3264 MB   ← at the ceiling before a single site moves
```

That is fine *today* (4 of those 6 have no pools, so nothing is allocated) and becomes a problem the instant a site is switched to 8.3 or 8.4, which is exactly the "future upgrade" the alignment was meant to prepare for. The configuration quietly arms a memory-pressure event.

*The sized approach:*

```
Active   (8.1, 8.2):  2 × (384 + 32) =  832 MB
Standby  (7.4, 8.0, 8.3, 8.4): 4 × (192 + 32) =  896 MB
                                       -----------
Worst case, every version active:      1728 MB   (5.4% of RAM)
Actual today (2 versions active):       832 MB   (2.5% of RAM)
```

Same consistency, same forward-readiness, and the worst case is survivable.

### 4.4 `max_accelerated_files` and the prime rounding

Set it above the file count from §3.3, with room to grow. OPcache rounds the configured value **up to the next prime in an internal table**, so `opcache_get_status()` reports a `max_cached_keys` that differs from what you configured. This is normal.

**Compare `num_cached_keys` against `max_cached_keys`** — never against your configured value.

Values in common use: `16229`, `32531`, `65407`. (`32531` is the EA4 default on current cPanel builds; check yours rather than assuming.)

---

## 5. The Settings That Matter

### 5.1 Set these

| Directive | Recommendation | Why |
|---|---|---|
| `opcache.enable` | `1` | — |
| `opcache.enable_cli` | `0` | CLI processes are short-lived; a separate cache per invocation wastes memory and gains nothing. |
| `opcache.memory_consumption` | Per §4 | Opcode buffer. |
| `opcache.interned_strings_buffer` | 16–64 MB per §4 | **The most commonly undersized directive.** The 8 MB default is exhausted quickly by WordPress/WooCommerce-class codebases; once full, string interning stops and memory use *rises*. |
| `opcache.max_accelerated_files` | Per §4.4 | Must exceed the real file count. |
| `opcache.max_wasted_percentage` | `10` | Triggers a restart to reclaim stale entries once wasted memory passes this share. Leave at 10 unless you see frequent scheduled restarts. |
| `opcache.validate_timestamps` | `1` | **Keep on for shared hosting.** See §5.3. |
| `opcache.save_comments` | `1` | **Do not disable.** Doctrine annotations, PHPUnit, and numerous WordPress plugins read docblocks at runtime. Disabling it saves a little memory and breaks sites — a classic false economy. |
| `opcache.validate_permission` | `1` (multi-tenant) | Makes OPcache verify the current user can read the file before serving it from cache. Relevant when many cPanel users share one FPM master's segment. |

### 5.2 Leave these alone

| Directive | Recommendation | Why |
|---|---|---|
| `opcache.jit` / `opcache.jit_buffer_size` | Off (`jit_buffer_size=0`) | For CMS/e-commerce web traffic the gain is typically 0–5% — these workloads are I/O and database bound, not opcode-dispatch bound. JIT has a real history of instability. Not where the wins are. |
| `opcache.preload` | Not on shared hosting | Needs a per-application preload script and pins memory per pool. Appropriate for a single-app server, not a multi-tenant one. |
| `opcache.huge_code_pages` | `0` | Interacts badly with transparent huge pages on some kernels; marginal benefit. |
| `opcache.file_cache` | Optional | Persists compiled opcodes to disk so restarts re-warm faster. Costs disk and adds a cache-invalidation surface. Only worth it if FPM restarts are frequent. |

### 5.3 `revalidate_freq` — the "how often does site code change" setting

`opcache.validate_timestamps=1` makes OPcache `stat()` each cached file to see whether it changed. `opcache.revalidate_freq` is how many seconds it waits before re-checking a given file.

| Value | Effect | Use when |
|---|---|---|
| `2` (common default) | Changes appear within ~2s. Maximum `stat()` syscall volume. | Default. Safest. |
| `60` | Changes appear within ~1 min. Noticeably fewer syscalls on file-heavy servers. | Clients edit code occasionally and can tolerate a one-minute delay. |
| `validate_timestamps=0` | Changes **never** appear until OPcache is reset. Fastest possible. | Single-app servers with a deploy pipeline that resets OPcache. **Never on shared hosting.** |

On a shared server where clients edit files through cPanel's file manager, WordPress plugin updates, or FTP, `validate_timestamps=0` generates "I changed the file and nothing happened" tickets. If a client asks to leave this at its default, that is the correct call — the syscall saving is real but modest, and the support cost of getting it wrong is not.

---

## 6. Making the Change Survive PHP Package Updates

### 6.1 Where to put it

EA4 ships its own OPcache config, owned by the `ea-phpXX-php-opcache` package:

```
/opt/cpanel/ea-phpXX/root/etc/php.d/10-opcache.ini      ← DO NOT EDIT
```

Editing it means a package update replaces it (or saves your version aside as `.rpmsave`) and your tuning vanishes silently.

PHP loads **every `*.ini` in `php.d/` in alphabetical order**, and later files override earlier ones. So put your settings in an unowned, alphabetically-last drop-in:

```
/opt/cpanel/ea-phpXX/root/etc/php.d/zz-opcache-tuning.ini   ← YOURS
```

No package owns it, so nothing overwrites it.

### 6.2 Writing it

```bash
# Repeat per version. Adjust values per §4.
VER=ea-php82
cat > /opt/cpanel/${VER}/root/etc/php.d/zz-opcache-tuning.ini <<'EOF'
; Managed OPcache tuning. Overrides 10-opcache.ini (loaded later, alphabetically).
; Do not move these values into php.ini — php.d drop-ins load after php.ini and win.
opcache.enable=1
opcache.enable_cli=0
opcache.memory_consumption=384
opcache.interned_strings_buffer=32
opcache.max_accelerated_files=32531
opcache.max_wasted_percentage=10
opcache.validate_timestamps=1
opcache.save_comments=1
opcache.validate_permission=1
EOF
```

### 6.3 Two gotchas that cost real time

**The MultiPHP INI Editor stops appearing to work.** WHM's MultiPHP INI Editor writes to `/opt/cpanel/ea-phpXX/root/etc/php.ini`. Because `php.d/*.ini` loads *after* `php.ini`, your drop-in overrides anything set through the UI. The next engineer will change a value in WHM, see no effect, and lose an hour. **Leave a comment in the drop-in saying so** (as above), and note it in the server's documentation.

**Never leave a backup copy with a `.ini` extension inside `php.d/`.** PHP loads every `*.ini` in that directory. A file named `zz-opcache-tuning.bak.ini` sorts *after* `zz-opcache-tuning.ini` and will silently override your live configuration with the old values. Back up outside the scan directory:

```bash
# Safe — extension is no longer .ini
cp /opt/cpanel/ea-php82/root/etc/php.d/zz-opcache-tuning.ini \
   /root/opcache-backups/ea-php82-zz-opcache-tuning.ini.$(date +%F)

# Also audit for pre-existing offenders before you start:
ls -la /opt/cpanel/ea-php*/root/etc/php.d/
```

Stale backup files and directories inside `php.d/` are worth sweeping for on any server you inherit — they are a common source of "the configuration says X but PHP reports Y".

---

## 7. Applying the Change

```bash
# 1. Validate the INI parses and the values land, BEFORE restarting anything
/opt/cpanel/ea-php82/root/usr/bin/php -i | grep -E '^opcache\.(memory_consumption|interned_strings_buffer|max_accelerated_files)'

# 2. Restart the FPM master for that version
systemctl restart ea-php82-php-fpm
systemctl status  ea-php82-php-fpm --no-pager

# 3. Repeat per version, one at a time — never restart all versions simultaneously
```

**Expect a brief interruption.** Restarting the FPM master drops the OPcache segment; the first requests after the restart recompile everything, so there is a short latency spike while the cache re-warms. On a busy server this is seconds to a couple of minutes, which is why this belongs in a maintenance window.

**Versions with no pools need no restart** — there is no running master. The configuration takes effect whenever a pool is first created for that version.

---

## 8. Verification

### 8.1 Configuration took effect

```bash
for v in /opt/cpanel/ea-php*/root/usr/bin/php; do
  echo "=== $v ==="
  "$v" -i 2>/dev/null | grep -E '^opcache\.(memory_consumption|interned_strings_buffer|max_accelerated_files|max_wasted_percentage)'
done
```

### 8.2 Runtime counters from the FPM process

`php -i` will not tell you this. Two ways to ask the running FPM master:

**Option A — temporary status file** (simplest; remember to remove it):

```bash
cat > /home/<user>/public_html/_opcache-check.php <<'EOF'
<?php
$s = opcache_get_status(false);
echo "memory used:      " . round($s['memory_usage']['used_memory']/1048576,1) . " MB\n";
echo "memory free:      " . round($s['memory_usage']['free_memory']/1048576,1) . " MB\n";
echo "memory wasted:    " . round($s['memory_usage']['wasted_memory']/1048576,1) . " MB\n";
echo "interned used:    " . round($s['interned_strings_usage']['used_memory']/1048576,1) . " MB\n";
echo "interned free:    " . round($s['interned_strings_usage']['free_memory']/1048576,1) . " MB\n";
echo "cached keys:      {$s['opcache_statistics']['num_cached_keys']} / {$s['opcache_statistics']['max_cached_keys']}\n";
echo "hit rate:         " . round($s['opcache_statistics']['opcache_hit_rate'],2) . "%\n";
echo "oom restarts:     {$s['opcache_statistics']['oom_restarts']}\n";
echo "hash restarts:    {$s['opcache_statistics']['hash_restarts']}\n";
echo "manual restarts:  {$s['opcache_statistics']['manual_restarts']}\n";
EOF

curl -s https://<domain>/_opcache-check.php

# REMOVE IT — it discloses server internals
rm -f /home/<user>/public_html/_opcache-check.php
```

**Option B — `cachetool` over the FPM socket** (no file in a docroot):

```bash
cachetool opcache:status --fcgi=/opt/cpanel/ea-php82/root/usr/var/run/php-fpm/<user>.sock
```

### 8.3 What good looks like

Check again after the cache has warmed under real traffic — **several hours at minimum**, ideally a full daily peak. Immediately after a restart every number looks wonderful because nothing has been cached yet.

- `oom_restarts` and `hash_restarts` — **0**, and staying 0.
- `interned strings free` — comfortably above 0.
- `cached keys` — well under `max_cached_keys`.
- `hit rate` — **> 95%** on steady traffic.
- `memory free` — some headroom, but not most of the buffer. If `used` sits at 15% of `memory_consumption` after a full peak, you over-allocated; give the RAM back.

### 8.4 Confirm sites are actually up

Config validity does not imply working sites. After each version's restart:

```bash
for d in <domain1> <domain2> <domain3>; do
  printf '%s -> ' "$d"
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "https://$d/"
done
```

Also check FPM's own error log for pool startup failures:

```bash
tail -50 /opt/cpanel/ea-php82/root/usr/var/log/php-fpm/error.log
```

---

## 9. Before Blaming OPcache: Is It Even the Bottleneck?

A request to "optimise OPcache" often arrives attached to a general slowness complaint. OPcache tuning addresses *one* specific cost — recompiling PHP source on every request. If that is not the bottleneck, raising `memory_consumption` consumes RAM and changes nothing, and on a memory-pressured box it makes the problem worse.

Rule these out first:

```bash
# CPU steal (a noisy neighbour on the hypervisor — nothing you tune here will help)
vmstat 1 5     # 'st' column

# I/O wait — disk-bound, not CPU-bound
iostat -xz 1 5 # %util, await

# Memory pressure and swap — if swapping, OPcache tuning is the WRONG direction
free -m; swapon --show

# FPM pool saturation — the single most common cause of "the server is slow"
grep -i 'max_children' /opt/cpanel/ea-php*/root/usr/var/log/php-fpm/error.log | tail -20
```

> `server reached pm.max_children setting` in the FPM error log means requests are **queuing for a worker**. No amount of OPcache memory fixes that — it needs `pm.max_children` raised (with the RAM to back it) or the offending site found.

```bash
# Slow database queries
mysqladmin processlist | head -30
# and check the slow query log if enabled

# A single site consuming the server
ls -1 /opt/cpanel/ea-php*/root/etc/php-fpm.d/*.conf | while read -r c; do
  u=$(basename "$c" .conf)
  printf '%-20s %s procs\n' "$u" "$(pgrep -fc "pool $u" 2>/dev/null || echo 0)"
done | sort -k2 -rn | head
```

Where OPcache tuning *does* deliver: a CPU-bound server with a large PHP codebase, healthy RAM headroom, and undersized OPcache counters per §3.5. That combination is real and the gains are worth having — typically a meaningful drop in PHP CPU time per request. It just needs to be the diagnosis rather than the reflex.

---

## 10. Rollback

Because the tuning lives in one unowned file per version, rollback is clean:

```bash
rm -f /opt/cpanel/ea-php82/root/etc/php.d/zz-opcache-tuning.ini
systemctl restart ea-php82-php-fpm

# Confirm EA4's shipped defaults are back in effect
/opt/cpanel/ea-php82/root/usr/bin/php -i | grep -E '^opcache\.(memory_consumption|interned_strings_buffer)'
```

This is the main practical argument for the drop-in over editing `php.ini` or `10-opcache.ini`: reverting is deleting one file, with no ambiguity about what the original values were.

---

## 11. Lessons Learned

- **The multiplier is PHP versions with running pools, not users and not workers.** One FPM master, one shared segment. Getting this backwards leads to both wild over-provisioning and panicked under-provisioning.
- **Aligning standby versions to the active version's profile is good housekeeping that arms a future problem.** Consistency across versions is genuinely worth having — it removes "which version is this site on?" from every future investigation. But give standby versions a smaller allocation, or the forward-looking change becomes a memory-pressure incident on the day someone finally migrates a site to PHP 8.4.
- **`interned_strings_buffer` is under-sized far more often than `memory_consumption` is.** The 8 MB default predates modern CMS codebases. It is also the cheaper fix — going 8 → 32 MB costs 24 MB per version; going 128 → 512 MB costs 384 MB.
- **`php -i` shows configuration, `opcache_get_status()` shows reality.** They answer different questions and the CLI SAPI has its own cache. Verifying a tuning change with `php -i` alone proves only that the file parsed.
- **Verify after a peak, not after a restart.** A freshly restarted OPcache reports a perfect hit rate on an empty cache.
- **A `.ini` backup inside `php.d/` is a live configuration file.** Alphabetical load order means a backup can silently win over the file it backs up. Back up outside the directory.
- **Document that the WHM MultiPHP INI Editor is now overridden**, or the next engineer will change a value in the UI, observe nothing, and start debugging PHP.
- **Over-allocation is not free headroom.** Reserved shared memory is RAM the database buffer pool and kernel page cache cannot use. On a shared hosting server those usually return more performance per megabyte than an opcode cache that is 80% empty.

---

## References
- PHP manual — OPcache configuration directives: <https://www.php.net/manual/en/opcache.configuration.php>
- PHP manual — `opcache_get_status()`: <https://www.php.net/manual/en/function.opcache-get-status.php>
- cPanel — EasyApache 4 PHP configuration file locations and `php.d` scan directory behaviour
- cPanel — MultiPHP INI Editor and its interaction with `php.d/*.ini` load order
- `cachetool` (querying OPcache over an FPM socket): <https://github.com/gordalina/cachetool>
