# SolusVM 2 / KVM: Live &amp; Offline Migration Failures After a Hardware/Node Refresh

> **Category:** Virtualization / KVM / libvirt / SolusVM
> **Applies to:** SolusVM 2 (Docker-based control panel), libvirt/QEMU-KVM compute nodes, AlmaLinux/RHEL 9.x
> **Symptom class:** VM migrations between two hypervisor nodes fail silently or with misleading errors, both in live and offline (cold) mode

> **Note on identifiers:** all node names, IPs, VM names and UUIDs below are illustrative placeholders. Replace them with your own environment's values.

---

## TL;DR

If migrations between two KVM nodes fail — **live migration** aborting with `Domain not found` / `domain is no longer running`, and **offline migration** *also* failing with `operation failed: domain is no longer running` — you are likely looking at **two independent, coexisting bugs**, not one:

1. **Live migration:** the two hosts have different CPU generations, and the VM is configured with `cpu mode='host-passthrough'`. The destination cannot restore CPU state/extensions the source CPU exposed, so the destination QEMU process crashes mid-migration.
2. **Offline (cold) migration:** a libvirt regression on AlmaLinux/RHEL 9.8 incorrectly runs a QEMU-monitor-dependent code path against a domain that isn't running, so the final hand-off step always fails — even though the disk actually copies successfully.

The fix that resolves the live-migration path (and sidesteps the offline-migration bug entirely) is: **change the VM's CPU model from `host-passthrough` to a common baseline model supported by both hosts**, then migrate live instead of offline.

---

## 1. Symptoms

- Migrating a VM from Node A to Node B fails, both when done **live** and when the VM is **powered off** first.
- The panel/UI shows the migration task as `done_with_errors` (or similar) with no useful detail.
- The VM itself never goes down — it stays fully running on its original node throughout every failed attempt.
- Migrations from *other* source nodes to the same destination succeed fine — isolating the problem to one specific node pair.
- Raw error messages recovered from the task/migration backend look like:

```
Cannot migrate VM "<uuid>":
migrate to destination: failed to call DomainMigrateBegin3Params on source
for domain "<uuid>": operation failed: domain is no longer running
```

```
Cannot migrate VM "<uuid>":
migrate to destination: failed to call DomainMigrateFinish3Params on destination
for domain "<uuid>": Domain not found: no domain with matching uuid '<uuid>'
```

Both of these are **after-effects** of an internal abort, not the actual cause — they show up whether the real problem is CPU incompatibility or the libvirt bug below.

---

## 2. Environment / Architecture Context

- SolusVM 2 control plane runs as Docker containers (API, workers, PostgreSQL, RabbitMQ, cache, etc.) on a master node.
- Each hypervisor ("Compute Resource") runs a lightweight Go agent (typically `/usr/local/solus/bin/agent`, logging to `/var/log/solus/agent.log`) which executes the actual libvirt/QEMU operations — the master node is not where migrations physically happen.
- Migration tasks flow through a message queue (e.g., RabbitMQ) to per-node consumers, which then drive the standard libvirt v3 migration API: `DomainMigrateBegin3Params` → `DomainMigratePrepare3Params` → `DomainMigratePerform3Params` → `DomainMigrateFinish3Params` → `DomainMigrateConfirm3Params`.
- This class of bug can affect any libvirt/KVM-based platform doing node-to-node migration, not just SolusVM — the underlying causes are in libvirt/QEMU and CPU hardware, not the panel software.

---

## 3. Diagnostic Approach

Work top-down: control-plane logs → backend task database → hypervisor state → hypervisor logs.

### 3.1 Check the real error behind the panel's generic status

Panel UIs often collapse the real error into a generic "failed" status. Look at the backend task/migration tables directly (e.g., via the management database) for the actual child-task error text — this is where the `DomainMigrateBegin3Params` / `Finish3Params` messages above come from.

### 3.2 Confirm the VM's actual state, independent of the panel

```bash
# On the source hypervisor
virsh list --all
virsh domstate <VM-UUID>
```

Confirms whether the failure caused any real downtime (in our case: it never did — the VM stays running on the source throughout every failed attempt).

### 3.3 Compare migration history across different source nodes

If some other source node → destination pairs succeed while only one pair consistently fails, that isolates the fault to that specific node pair (usually CPU or OS version related) rather than the destination being broadly broken.

### 3.4 Rule out network/firewall

```bash
ping -c 4 <destination-ip>
nc -zv <destination-ip> <agent-port>
iptables -L -n   # check both directions
```

### 3.5 Capture the hypervisor agent log during a live failure

```bash
tail -f /var/log/solus/agent.log | grep --line-buffered '<VM-UUID>'
```

Watch for the exact libvirt call sequence and where it stops.

### 3.6 Compare CPU capabilities between the two nodes — the key diagnostic step

```bash
virsh domcapabilities | grep -A5 '<cpu>'
lscpu | grep 'Model name'
```

If the source and destination report different CPU model families (e.g., a newer "Skylake"-class CPU vs. an older "Broadwell"-class CPU), and the VM is running `host-passthrough`, you've very likely found root cause #1 below.

---

## 4. Root Cause #1 — CPU Generation Mismatch with `host-passthrough` (blocks LIVE migration)

`cpu mode='host-passthrough'` exposes the *entire* physical instruction set of the source CPU directly to the guest — including extensions unique to newer CPU generations (e.g., AVX-512/XSAVE-family extensions present on newer Xeon Scalable CPUs but absent on older Xeon E5-v4-class CPUs).

During a **live** migration, the guest's live CPU register state has to be transferred to and restored on the destination. If the destination CPU physically lacks instructions/extensions the source exposed to the guest, that restore fails and the destination QEMU process aborts — typically visible in the destination's QEMU log as something like:

```
qemu-kvm: warning: TSC frequency mismatch between VM (X kHz) and host (Y kHz), and TSC scaling unavailable
qemu-kvm: Failed to set XSAVE: Invalid argument
```

The libvirt-level errors in Section 1 are simply what bubbles up after that internal crash — they look like the VM vanished, but it never did; only the *migration attempt* died.

**Verification:** if the VM boots and runs fine on the source with `host-passthrough`, but the destination's `lscpu`/`domcapabilities` output shows a smaller/older feature set, this is confirmed.

---

## 5. Root Cause #2 — AlmaLinux/RHEL 9.8 libvirt Regression (blocks OFFLINE/cold migration)

Independently of the CPU issue, a **cold (offline) migration** — VM fully shut down first — can also fail, at the very last step, even though the disk copy completes successfully:

```
libvirtd[...]: operation failed: domain is no longer running
```

This is a confirmed **libvirt regression in AlmaLinux/RHEL 9.8**, where the offline-migration code path incorrectly invokes a function meant only for *running* domains (a QEMU-monitor-dependent call), which naturally fails against a domain that's intentionally not running. This is tracked upstream:

- Red Hat bug reference: **RHEL-156800**
- Upstream libvirt issue: **libvirt GitLab #865**
- Fixed upstream in commit `59fde80f`; expected in a future RHEL point release.

This is a **platform/OS-level defect**, unrelated to any specific panel software, VM configuration, or customer environment.

**Practical implication:** if your live-migration path is blocked by root cause #1, don't fall back to offline/cold migration as a "safe" alternative without testing it first on this OS version — it may hit this separate bug and also fail, just later in the process (after a potentially lengthy disk copy).

---

## 6. The Fix: Move to a Common CPU Baseline, Then Migrate Live

Since offline migration is blocked platform-wide by Root Cause #2, the practical fix is to make **live** migration CPU-compatible instead — and it turns out to be the *lower-downtime* option anyway.

### 6.1 Pick a baseline CPU model supported by both hosts

```bash
# Run on BOTH source and destination, compare output
virsh domcapabilities | grep -A20 "<cpu mode='custom'"
```

Pick a named QEMU CPU model present on both nodes' capability list (e.g., an older, common baseline like `Broadwell-noTSX-IBRS`). It should sit at or below the *oldest* CPU generation in your node pool.

### 6.2 Why the panel's "override CPU" setting may not help existing VMs

Many panel UIs expose a "libvirt XML override" / "custom CPU" setting at the Compute Resource (node) level. In our case, this setting saved correctly to the backend database but **only took effect for newly created VMs** — it did not retroactively apply to VMs that already existed, even across a panel-driven stop/start cycle. If `virsh dumpxml` still shows the old CPU mode after toggling this setting and restarting the VM through the panel, don't keep retrying the panel UI — edit the persistent domain XML directly instead (next section).

### 6.3 Manual CPU model change (per existing VM)

Run on the **source** node, for each affected VM:

```bash
# 1. Export the VM's current persistent (inactive) config
virsh dumpxml --inactive <VM-UUID> > /root/<VM-ID>-cpu.xml
cp /root/<VM-ID>-cpu.xml /root/<VM-ID>-cpu.xml.bak

# 2. Replace the host-passthrough CPU stanza with a custom baseline model
sed -i "s|<cpu mode='host-passthrough' check='none' migratable='on'/>|<cpu mode='custom' match='exact' check='none'><model fallback='allow'>Broadwell-noTSX-IBRS</model></cpu>|" /root/<VM-ID>-cpu.xml

# 3. Sanity-check the replacement took effect
grep -A3 '<cpu' /root/<VM-ID>-cpu.xml

# 4. Apply it
virsh define /root/<VM-ID>-cpu.xml
```

### 6.4 Apply the new config (requires one short reboot)

The new CPU definition only takes effect on the VM's *next* cold boot — a running VM keeps its old live CPU state in memory.

```bash
# Graceful shutdown — try the panel/ACPI shutdown first.
# If the guest is unresponsive to ACPI (e.g., stuck at a lock screen),
# fall back to a guest-agent-based shutdown, which is safe and simply
# fails harmlessly if the agent can't respond:
virsh shutdown <VM-UUID> --mode agent

virsh domstate <VM-UUID>   # wait for: shut off

virsh start <VM-UUID>

# Confirm the new CPU model actually expanded correctly:
virsh dumpxml <VM-UUID> | grep -A4 '<cpu'
# Expect something like:
#   <cpu mode='custom' match='exact' check='full'>
#     <model fallback='forbid'>Broadwell-noTSX-IBRS</model>
#     <feature policy='require' name='f16c'/>
#     <feature policy='require' name='rdrand'/>
```

This reboot is the *only* downtime this fix requires (a couple of minutes) — the subsequent migration then runs live, with the guest online throughout.

### 6.5 Migrate live

Trigger the live migration through your normal panel/API workflow (or directly: `virsh migrate --live --persistent <VM-UUID> qemu+tcp://<destination>/system`). Monitor the hypervisor agent log for the standard sequence and watch for a clean finish:

```bash
tail -f /var/log/solus/agent.log | grep --line-buffered '<VM-UUID>'
```

A clean, successful finish looks like:

```
... Call DomainMigrateFinish3Params with canceled 0 on destination ...
... Call DomainMigrateConfirm3Params with canceled 0 on source ...
... Received libvirt lifecycle "shutdown" event ...
... Received libvirt lifecycle "stopped" event ...
... End of "<uuid>" domain migration ...
... Released VM task lock ...
```

`canceled 0` on both `Finish3Params` and `Confirm3Params` is the key confirmation of success — a "shutdown"/"stopped" event on the source *right after* these two calls is the expected, normal teardown of the source-side copy once the destination has taken over — not a crash.

---

## 7. A Secondary Failure Mode: Crash at the Final Handshake + Stuck Migration Lock

Even after the CPU fix, one migration attempt (on the largest/longest-running VM in this case) failed differently — **after** the entire disk and memory had already transferred (confirmed via `virsh domjobinfo` showing `Data remaining: 0`), right at the very last handshake step:

```
qemu-kvm: Failed to peek at channel
qemu-kvm: unknown channel magic: <n>
...
qemu-kvm: ../util/yank.c:107: void yank_unregister_instance(...): Assertion `QLIST_EMPTY(&entry->yankfns)' failed.
```

This crashed the destination-side QEMU process during migration cleanup, which in turn left the **source-side VM stuck in a `paused` state** — genuine, real downtime, unlike every other failure mode in this KB, which never actually interrupted service.

### 7.1 Recovery procedure

**Step 1 — try a normal resume:**

```bash
virsh resume <VM-UUID>
```

If you get:

```
error: Failed to resume domain '<uuid>'
error: Timed out during operation: cannot acquire state change lock (held by monitor=remoteDispatchDomainMigratePerform3Params)
```

...the migration RPC thread is still wedged inside the management daemon, holding a lock that a normal `resume` can't override.

**Step 2 — try to cancel the stuck job:**

```bash
virsh domjobinfo <VM-UUID>   # if "Time elapsed" is still climbing between two checks, the job is genuinely still "alive" from libvirt's point of view
virsh domjobabort <VM-UUID>
virsh resume <VM-UUID>
```

**Step 3 — if that doesn't clear it, restart the management daemon (safe):**

```bash
systemctl is-active libvirtd virtqemud 2>/dev/null   # check which one is actually running
systemctl restart libvirtd      # or virtqemud, whichever was active
```

This is **safe for every other VM on the node.** The management daemon (`libvirtd`/`virtqemud`) is only the *management* layer — each running VM is its own independent `qemu-kvm` process. Restarting the daemon does not stop, pause, or restart any running VM; it simply resets the daemon's own in-memory lock/job table and reattaches to the already-running processes. Verify with `virsh list --all` immediately after — every other VM should be untouched.

After the restart, re-check the affected domain — it will very likely already show as `running` again on its own (the "paused" state was the *management layer's* cached view, not the guest's real state).

### 7.2 Confirming no data was actually lost

This failure mode looks alarming ("did the migration wipe my data?") but is safe by construction:

- The **source** copy is the authoritative one throughout a migration and is never modified/deleted until the destination explicitly confirms success (`DomainMigrateConfirm3Params`) — which never happened here.
- The **destination**'s copy — even if it had fully transferred — was only ever a provisional, in-progress copy. Since the migration never reached the final "confirm" step, it gets discarded/cleaned up automatically as part of the failed transaction's rollback. An empty destination directory after a failed migration is expected cleanup behavior, not data loss.

Full post-recovery verification:

```bash
virsh domstate <VM-UUID>
virsh domifaddr <VM-UUID> --source agent   # confirms the guest OS itself (not just the hypervisor) is responsive
ping -c 4 <guest-ip>
```

### 7.3 Possible contributing factor: destination host load

We could not conclusively prove it, but circumstantial evidence pointed at host contention increasing the odds of hitting this bug:

- This failure happened on the **largest, longest-running** transfer of the batch — more wall-clock exposure time for a rare, timing-sensitive fault.
- `top` on the destination during this window showed a climbing load average and **~49% I/O wait** — meaning migration threads inside QEMU were competing heavily for CPU/disk scheduling, which is exactly the kind of condition that can expose edge cases in buffer/stream-framing code.
- A later, otherwise-identical retry succeeded cleanly while destination load was measurably lower and *trending down* rather than up.

**Recommendation:** before starting a live migration of a large VM, check the destination's load trend, not just its instantaneous value:

```bash
cat /proc/loadavg     # compare 1-min vs 5-min vs 15-min figures — rising or falling?
free -h
```

If load is climbing and I/O wait is high, consider waiting for a quieter window, especially for your largest VMs.

---

## 8. Post-Migration Verification Checklist

Run all of these before considering a migration fully closed out:

```bash
# On the destination node
virsh list --all | grep <VM-UUID>
virsh domstate <VM-UUID>

# CPU model actually took effect (not silently still host-passthrough)
virsh dumpxml <VM-UUID> | grep -A4 '<cpu'

# No errors in the QEMU log
tail -50 /var/log/libvirt/qemu/<VM-UUID>.log | grep -i err

# Disk landed intact and matches source size
du -sh /var/lib/libvirt/images/<VM-ID>/0

# Guest OS itself is responsive (not just the hypervisor's view)
virsh domifaddr <VM-UUID> --source agent
ping -c 4 <guest-ip>
```

```bash
# On the source node — confirm old disk was actually reclaimed
du -sh /var/lib/libvirt/images/<VM-ID>/0 2>/dev/null || echo "cleaned up, path gone"
```

> **Tip:** a bare `ls` on the VM's old image *directory* isn't sufficient — an empty leftover directory (or a stray attached ISO) will still return "present" even after the actual disk file is gone. Check the specific disk file path, not just the directory.

---

## 9. Real-Time Monitoring Snippets

**Live progress from the source (authoritative for an outgoing migration):**

```bash
watch -n 2 'virsh domjobinfo <VM-UUID>'
```

Key fields: `Data processed` / `Data remaining` / `Data total`, and `Memory bandwidth` for live throughput. Note this command only works from the **source** side — running it on the destination returns `migration statistics are available only on the source host`, which is expected, not an error.

**Transfer size + live speed + ETA, computed from destination disk growth** (useful when you want more granularity than `domjobinfo` alone, or want to log it):

```bash
watch -n 2 'CURR=$(du -sm /var/lib/libvirt/images/<VM-ID>/0 | cut -f1); PREV=$(cat /tmp/<VM-ID>_prev 2>/dev/null || echo $CURR); SPEED=$(( (CURR - PREV) / 2 )); GB=$(( CURR / 1024 )); TOTAL=<total-size-in-MB>; REMAIN=$(( TOTAL - CURR )); if [ $REMAIN -le 0 ]; then ETA="finishing up"; elif [ $SPEED -gt 0 ]; then ETA="$(( REMAIN / SPEED / 60 )) min"; else ETA="calculating..."; fi; LOAD=$(cut -d" " -f1-3 /proc/loadavg); echo "Speed: ${SPEED} MB/s"; echo "Total (GB): ${GB} GB"; echo "Total (MB): ${CURR} MB"; echo "ETA: ${ETA}"; echo "Load avg (1/5/15m): ${LOAD}"; echo $CURR > /tmp/<VM-ID>_prev'
```

(`watch` re-runs its command fresh each interval with no memory of the last run, so the script stashes the previous reading in `/tmp` to compute a delta-based speed.)

---

## 10. Lessons Learned

- **A migration failure that "looks like" the VM disappeared usually isn't** — `Domain not found` / `domain is no longer running` from a migration API call are downstream symptoms of an *aborted migration*, not evidence the VM itself crashed. Always independently confirm the VM's real state with `virsh domstate`/`list --all` before assuming any impact.
- **"Fails live and fails offline" doesn't mean "one root cause."** Investigate each migration mode independently — in this case they were two completely unrelated bugs that happened to coexist.
- **`host-passthrough` is a migration liability** across any hardware-heterogeneous node pool. If you need to migrate between CPU generations, a named baseline model is the only reliable option.
- **Panel-level configuration overrides may only apply going forward**, not retroactively to existing resources — verify with a direct hypervisor-level check (`virsh dumpxml`) rather than trusting the UI's saved-settings confirmation.
- **A stuck libvirt job lock is recoverable without any data risk** — `domjobabort` first, then a full daemon restart if needed. The daemon restart does not touch other running VMs.
- **Host load/contention is worth checking before starting large live migrations**, not just after something goes wrong — it's cheap insurance against timing-sensitive failure modes.

---

## References
- https://support.solusvm.com/hc/en-us/articles/40875972240535-SolusVM2-offline-migration-failed-with-the-error-operation-failed-domain-is-no-longer-running
- Upstream libvirt issue: <https://gitlab.com/libvirt/libvirt/-/issues/865>
- Red Hat Bugzilla/JIRA reference: RHEL-156800
- `virsh` migration API: `DomainMigrateBegin3Params`, `DomainMigratePrepare3Params`, `DomainMigratePerform3Params`, `DomainMigrateFinish3Params`, `DomainMigrateConfirm3Params`
- QEMU CPU model definitions: `virsh domcapabilities`
