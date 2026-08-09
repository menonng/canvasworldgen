# Phase 1 — environment required for the companion mod verification

Phase 1 proves four things about Minecraft Java 26.2 with running code, not from
memory. None of it can be done in the current sandbox: the hosts that serve the
Minecraft jar, its mappings and the mod toolchains are unreachable.

Measured from this sandbox:

| Host | Purpose | Result |
|---|---|---|
| `piston-data.mojang.com` | Minecraft client/server jar, official mappings | connection refused |
| `libraries.minecraft.net` | Minecraft's own library dependencies | connection refused |
| `maven.fabricmc.net` | Fabric Loom, Yarn mappings, Fabric API | connection refused |
| `maven.neoforged.net` | NeoForge and its Gradle plugin | connection refused |
| `repo1.maven.org` | Maven Central | 200 |
| `services.gradle.org` | Gradle distributions | 200 |

Gradle itself works. Everything Minecraft-specific does not, so the project
cannot compile against 26.2 at all.

---

## What the environment has to provide

### Network

Outbound HTTPS to these hosts, at minimum:

```
piston-meta.mojang.com          version manifest
piston-data.mojang.com          client jar, server jar, official mappings
libraries.minecraft.net         Minecraft's transitive libraries
resources.download.minecraft.net  assets (only needed to launch a client)
maven.fabricmc.net              Fabric Loom, Yarn, Fabric API      (Fabric path)
maven.neoforged.net             NeoForge, ModDevGradle             (NeoForge path)
repo1.maven.org                 Maven Central
services.gradle.org             Gradle wrapper distribution
plugins.gradle.org              Gradle plugin portal
```

A Nexus/Artifactory mirror in front of all of them works equally well; the
toolchain only needs the artifacts, not those exact domains.

### Software

- **JDK 21** or newer. Confirmed already present in this sandbox
  (`openjdk 21.0.10`), so only the network is missing.
- **Gradle** via the wrapper, so nothing to install by hand.
- ~6 GB free disk for the Gradle cache, decompiled sources and a test world.
- ~4 GB RAM for the dev server. A GPU or display is not required — every
  Phase 1 check runs on a **dedicated server**, headless.

### Licensing

Nothing paid. Minecraft's jar is fetched by Loom/ModDevGradle under Mojang's
normal terms, the same as any mod developer's machine. No account is needed for
a headless server run.

---

## What Phase 1 will actually verify

Each item is a runnable check with a pass/fail outcome, not a written opinion.

### 1. Registering a custom density function type

Register a `MapCodec` into the `minecraft:worldgen/density_function_type`
registry — confirmed to exist in 26.2 with 34 vanilla entries — and reference it
from datapack JSON.

**Pass:** a dedicated server starts with a datapack whose noise settings
reference `<namespace>:map_sample`, and the world loads without a codec error.
**Fail signal:** `Unknown density function type` during datapack load.

### 2. Reading world X/Z

Determine, from the decompiled 26.2 sources, how a density function receives its
sample position, and confirm the values are absolute world block coordinates
rather than chunk-local or cell-local ones.

**Pass:** a probe density function that returns `x` verbatim produces terrain
whose height rises linearly with X, measured by reading block heights at known
coordinates through `/execute`.

### 3. Thread-safe field caching

Chunk generation runs on a worker pool, so the sampler is called concurrently
from many threads. Verify a read-only field loaded once at datapack load is safe
to share, and measure the cost of a sample.

**Pass:** 10 000 chunks generated with 8 worker threads produce byte-identical
region output across three runs, with no data race under `-Xcheck:jni` and a
thread sanitiser pass. Also measures chunks/second against vanilla as a
baseline, since a slow sampler is as bad as an incorrect one.

### 4. Minimum working prototype

Wire the custom function into the vanilla noise router — overriding only
`overworld/continents`, exactly as the datapack layer already does — and confirm
a hand-authored 64×64 test field appears in-world at the right coordinates and
orientation.

**Pass:** a checkerboard field produces a checkerboard of islands whose corners
land within one chunk of the intended coordinates, verified from a top-down
render. This also fixes the axis convention, which is where this kind of
integration usually goes wrong.

Only after all four pass does the Exact Export structure get finalised.

---

## Ways to run it

**Give this session network access.** Unblock the hosts above and Phase 1 runs
here end to end, the same way the datapack layer was verified against the real
26.2 data.

**Run it locally yourself.** Any machine with JDK 21 and normal internet works.
I prepare the Gradle project, the test datapack and a checklist of what to read
out of the decompiled sources; you run it and send back the results; I write the
implementation against those findings. The Java body waits until then — writing
it from memory is exactly what these four checks exist to avoid.

**A CI runner.** A GitHub Actions job on `ubuntu-latest` has all the access
needed and can run a headless dedicated server. Slowest feedback loop of the
three, but fully automatic and it doubles as a regression test later.

---

## Meanwhile

Phases 3 to 6 need none of this and are proceeding:

- **Phase 3** — the project schema, at [`schema/project.schema.json`](../schema/project.schema.json)
- **Phase 4** — the web map editor
- **Phase 5** — map analysis into procedural parameters
- **Phase 6** — the design-versus-result preview

That path produces a site where Procedural Export works completely. Exact Export
is added later as one more branch at the export step, against the same project
data.
