// On Linux the JS thread answers an async stat, lstat, access(F_OK) or exists itself when the
// kernel holds the answer in memory (`openat2(RESOLVE_CACHED)`), and hands everything else to
// the thread pool. These tests pin what a caller can observe of that: the same results and
// errors as the pool gives, the same place in the event loop, and that the pool still gets
// what the kernel cannot answer without waiting.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, tempDir } from "harness";
import { statfsSync } from "node:fs";
import { release } from "node:os";

const files = {
  "file.txt": "hello",
  "other/file.txt": "a longer file",
  "sub/inner.txt": "inner",
};

// <linux/magic.h>
const TMPFS = 0x01021994;
const ANSWERS_STATX_FROM_MEMORY = new Set([0xef53, 0x58465342, 0x9123683e, 0xf2f52010, TMPFS, 0x794c7630]);

const [major, minor] = release().split(".").map(Number);
const kernelHasResolveCached = isLinux && (major > 5 || (major === 5 && minor >= 12));

/** Whether the JS thread can answer for a working directory of `dir`. */
function answersFromCache(dir: string) {
  return kernelHasResolveCached && ANSWERS_STATX_FROM_MEMORY.has(Number(statfsSync(dir).type));
}

// tmpfs forgets a name that is not there as soon as the lookup is over.
function remembersMissingNames(dir: string) {
  return Number(statfsSync(dir).type) !== TMPFS;
}

const prelude = `
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const { getCounters } = require("bun:internal-for-testing");
  const plain = value => JSON.parse(JSON.stringify(value ?? null, (key, v) => (typeof v === "bigint" ? v + "n" : v)));
  const failure = e => ({ name: e.name, code: e.code, syscall: e.syscall, errno: e.errno, path: e.path, message: e.message });
  const settle = async f => { try { return { value: plain(await f()) }; } catch (e) { return { error: failure(e) }; } };
  const settleSync = f => { try { return { value: plain(f()) }; } catch (e) { return { error: failure(e) }; } };
  const callback = (f, ...args) => new Promise((resolve, reject) => f(...args, (err, value) => (err ? reject(err) : resolve(value))));
  const nextTurn = () => new Promise(resolve => setImmediate(resolve));
  // Counts what \`f\` adds to the two counters.
  const counted = async f => {
    const before = getCounters();
    const result = await f();
    const after = getCounters();
    return { result, hits: after.fs_cached_hit - before.fs_cached_hit, misses: after.fs_cached_miss - before.fs_cached_miss };
  };
  // The first async calls go to the pool: they leave the names in the kernel's cache and classify the mount.
  const warm = async () => { for (const name of ["file.txt", "missing.txt"]) { await fsp.stat(name).catch(() => {}); await fsp.access(name).catch(() => {}); } };
  // After a call that went to the pool, the JS thread does not ask the kernel for some turns.
  // Resolves once it asks again and has forgotten that call. Gives up where it never answers.
  const asking = async () => {
    for (let i = 0; i < 5000; i++) {
      await nextTurn();
      if ((await counted(() => fsp.stat("file.txt"))).hits === 1) break;
    }
    await nextTurn();
  };
  // A mount or unmount anywhere on the machine makes the kernel refuse a cached lookup that was
  // under way, and that call goes to the pool. So: the first of a few rounds that \`wanted\` accepts.
  const countedUntil = async (wanted, f) => {
    let round;
    for (let i = 0; i < 20; i++) {
      await asking();
      round = await counted(() => f(i));
      if (wanted(round)) break;
    }
    return round;
  };
`;

async function run(dir: string, script: string, env: Record<string, string> = {}) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", prelude + script],
    env: { ...bunEnv, ...env },
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0 || !stdout.trim()) {
    throw new Error(`fixture failed (exit ${exitCode})\n${stdout}\n${stderr}`);
  }
  return JSON.parse(stdout);
}

describe.skipIf(!isLinux)("async fs operations that the kernel can answer from its caches", () => {
  // Each row: the async call, its sync twin, and whether the JS thread answers it given a warm cache.
  const rows: [
    name: string,
    async_: string,
    sync: string,
    answered: "yes" | "never asked" | "never" | "if missing names are remembered" | "on some filesystems",
  ][] = [
    ["stat of a file", `fsp.stat("file.txt")`, `fs.statSync("file.txt")`, "yes"],
    ["stat of a directory", `fsp.stat("sub")`, `fs.statSync("sub")`, "yes"],
    ["stat of the working directory", `fsp.stat(".")`, `fs.statSync(".")`, "yes"],
    ["stat below a directory", `fsp.stat("sub/inner.txt")`, `fs.statSync("sub/inner.txt")`, "yes"],
    ["stat with bigint", `fsp.stat("file.txt", { bigint: true })`, `fs.statSync("file.txt", { bigint: true })`, "yes"],
    ["lstat of a file", `fsp.lstat("file.txt")`, `fs.lstatSync("file.txt")`, "yes"],
    ["lstat of a symlink", `fsp.lstat("link")`, `fs.lstatSync("link")`, "yes"],
    ["lstat of a dangling symlink", `fsp.lstat("dangling")`, `fs.lstatSync("dangling")`, "yes"],
    ["access of a file", `fsp.access("file.txt")`, `fs.accessSync("file.txt")`, "yes"],
    ["access of a directory", `fsp.access("sub", fs.constants.F_OK)`, `fs.accessSync("sub", fs.constants.F_OK)`, "yes"],
    ["exists of a file", `fsp.exists("file.txt")`, `fs.existsSync("file.txt")`, "yes"],
    ["fs.stat with a callback", `callback(fs.stat, "file.txt")`, `fs.statSync("file.txt")`, "yes"],
    ["fs.lstat with a callback", `callback(fs.lstat, "link")`, `fs.lstatSync("link")`, "yes"],
    ["fs.access with a callback", `callback(fs.access, "file.txt")`, `fs.accessSync("file.txt")`, "yes"],
    ["fs.exists with a callback", `new Promise(resolve => fs.exists("file.txt", resolve))`, `fs.existsSync("file.txt")`, "yes"],
    ["Bun.file().stat()", `Bun.file("file.txt").stat()`, `fs.statSync("file.txt")`, "yes"],
    ["stat of a missing file", `fsp.stat("missing.txt")`, `fs.statSync("missing.txt")`, "if missing names are remembered"],
    ["lstat of a missing file", `fsp.lstat("missing.txt")`, `fs.lstatSync("missing.txt")`, "if missing names are remembered"],
    [
      "stat of a missing file without throwIfNoEntry",
      `fsp.stat("missing.txt", { throwIfNoEntry: false })`,
      `fs.statSync("missing.txt", { throwIfNoEntry: false })`,
      "if missing names are remembered",
    ],
    ["access of a missing file", `fsp.access("missing.txt")`, `fs.accessSync("missing.txt")`, "if missing names are remembered"],
    ["exists of a missing file", `fsp.exists("missing.txt")`, `fs.existsSync("missing.txt")`, "if missing names are remembered"],
    [
      "fs.stat of a missing file with a callback",
      `callback(fs.stat, "missing.txt")`,
      `fs.statSync("missing.txt")`,
      "if missing names are remembered",
    ],
    [
      "fs.access of a missing file with a callback",
      `callback(fs.access, "missing.txt")`,
      `fs.accessSync("missing.txt")`,
      "if missing names are remembered",
    ],
    // overlayfs and XFS do not let a cached lookup read a symlink.
    ["stat through a symlink", `fsp.stat("link")`, `fs.statSync("link")`, "on some filesystems"],
    ["stat below a symlink to a directory", `fsp.stat("sublink/inner.txt")`, `fs.statSync("sublink/inner.txt")`, "on some filesystems"],
    ["stat of a dangling symlink", `fsp.stat("dangling")`, `fs.statSync("dangling")`, "on some filesystems"],
    ["exists of a dangling symlink", `fsp.exists("dangling")`, `fs.existsSync("dangling")`, "on some filesystems"],
    // A lookup says nothing of permissions: the kernel is not asked.
    ["access for reading", `fsp.access("file.txt", fs.constants.R_OK)`, `fs.accessSync("file.txt", fs.constants.R_OK)`, "never asked"],
    // The kernel leaves what lies below a file to a lookup that may wait.
    ["stat below a file", `fsp.stat("file.txt/below")`, `fs.statSync("file.txt/below")`, "never"],
  ];

  test.concurrent.each(rows)("%s", async (_name, async_, sync, answered) => {
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const canAnswer = answersFromCache(cwd);
    const isAnswered =
      canAnswer && (answered === "yes" || (answered === "if missing names are remembered" && remembersMissingNames(cwd)));
    const { first, repeats, sync: syncResult } = await run(
      cwd,
      `
      fs.symlinkSync("file.txt", "link");
      fs.symlinkSync("sub", "sublink");
      fs.symlinkSync("nowhere", "dangling");
      (async () => {
        await warm();
        const first = await settle(() => ${async_});
        const repeats = await countedUntil(
          round => !${isAnswered} || (round.hits === 3 && round.misses === 0),
          async () => [await settle(() => ${async_}), await settle(() => ${async_}), await settle(() => ${async_})],
        );
        console.log(JSON.stringify({ first, repeats, sync: settleSync(() => ${sync}) }));
      })();
      `,
    );
    // Whoever answers, the answer is that of the sync function.
    expect(first).toEqual(syncResult);
    expect(repeats.result).toEqual([syncResult, syncResult, syncResult]);

    if (isAnswered) {
      expect({ hits: repeats.hits, misses: repeats.misses }).toEqual({ hits: 3, misses: 0 });
    } else if (canAnswer && answered === "never asked") {
      expect({ hits: repeats.hits, misses: repeats.misses }).toEqual({ hits: 0, misses: 0 });
    } else if (canAnswer && answered === "never") {
      // The first of the three is asked. Then the JS thread stops asking for some turns.
      expect({ hits: repeats.hits, asked: repeats.misses >= 1 }).toEqual({ hits: 0, asked: true });
    }
  });

  test.concurrent("an absolute path on the mount of the root directory", async () => {
    using dir = tempDir("fs-cached", files);
    const canAnswer = answersFromCache("/") && answersFromCache(String(dir));
    const { repeats, sync } = await run(
      String(dir),
      `
      (async () => {
        await warm();
        await fsp.stat("/");
        const repeats = await countedUntil(
          round => !${canAnswer} || round.hits === 3,
          async () => [await settle(() => fsp.stat("/")), await settle(() => fsp.lstat("/")), await settle(() => fsp.access("/"))],
        );
        console.log(JSON.stringify({ repeats, sync: [settleSync(() => fs.statSync("/")), settleSync(() => fs.lstatSync("/")), settleSync(() => fs.accessSync("/"))] }));
      })();
      `,
    );
    expect(repeats.result).toEqual(sync);
    if (canAnswer) {
      expect({ hits: repeats.hits, misses: repeats.misses }).toEqual({ hits: 3, misses: 0 });
    }
  });

  test.concurrent("sees a change of the file at once", async () => {
    using dir = tempDir("fs-cached", files);
    const result = await run(
      String(dir),
      `
      (async () => {
        await warm();
        await asking();
        const seen = [];
        seen.push((await fsp.stat("file.txt")).size);
        fs.appendFileSync("file.txt", " world");
        seen.push((await fsp.stat("file.txt")).size);
        fs.unlinkSync("file.txt");
        seen.push((await settle(() => fsp.stat("file.txt"))).error.code, await fsp.exists("file.txt"));
        fs.mkdirSync("file.txt");
        seen.push((await fsp.stat("file.txt")).isDirectory(), await fsp.exists("file.txt"));
        console.log(JSON.stringify(seen));
      })();
      `,
    );
    expect(result).toEqual([5, 11, "ENOENT", false, true, true]);
  });

  test.concurrent("a relative path follows the working directory", async () => {
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const canAnswer = answersFromCache(cwd);
    const twoHits = `round => !${canAnswer} || round.hits === 2`;
    const result = await run(
      cwd,
      `
      (async () => {
        await warm();
        const sizes = async () => [(await fsp.stat("file.txt")).size, (await fsp.stat("file.txt")).size];
        const here = await countedUntil(${twoHits}, sizes);
        process.chdir("other");
        // The mount of the new working directory is not classified yet: the pool does that.
        const moved = await counted(sizes);
        const there = await countedUntil(${twoHits}, sizes);
        const inner = await fsp.exists("inner.txt");
        process.chdir("../sub");
        const last = [(await settle(() => fsp.stat("file.txt"))).error?.code, await fsp.exists("inner.txt")];
        console.log(JSON.stringify({ here, moved, there, inner, last }));
      })();
      `,
    );
    expect({
      here: result.here.result,
      moved: result.moved.result,
      there: result.there.result,
      inner: result.inner,
      last: result.last,
    }).toEqual({ here: [5, 5], moved: [13, 13], there: [13, 13], inner: false, last: ["ENOENT", true] });
    if (canAnswer) {
      expect({ here: result.here.hits, there: result.there.hits }).toEqual({ here: 2, there: 2 });
    }
  });

  test.concurrent("settles after the caller's microtasks, its nextTicks and the immediates of the turn", async () => {
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const canAnswer = answersFromCache(cwd);
    const contexts = ["fs callback", "promise reaction", "timer", "immediate", "socket"];
    const result = await run(
      cwd,
      `
      const net = require("node:net");
      const order = () => new Promise(resolve => {
        const log = [];
        let answered = 0;
        const before = getCounters().fs_cached_hit;
        const done = () => { if (log.length === 6) resolve({ log, hits: answered }); };
        fsp.stat("file.txt").then(() => { log.push("stat"); done(); });
        fs.access("file.txt", () => { log.push("access"); done(); });
        answered = getCounters().fs_cached_hit - before;
        setImmediate(() => { log.push("immediate"); done(); });
        process.nextTick(() => { log.push("nextTick"); done(); });
        queueMicrotask(() => { log.push("microtask"); done(); });
        log.push("sync");
      });
      (async () => {
        await warm();
        const server = net.createServer(socket => socket.on("data", data => socket.write(data))).listen(0, "127.0.0.1");
        await new Promise(resolve => server.once("listening", resolve));
        const socket = net.connect(server.address().port, "127.0.0.1");
        await new Promise(resolve => socket.once("connect", resolve));
        const contexts = {
          "fs callback": run => fs.readFile("sub/inner.txt", run),
          "promise reaction": run => fsp.readFile("sub/inner.txt").then(run),
          "timer": run => setTimeout(run, 1),
          "immediate": run => setImmediate(run),
          "socket": run => { socket.once("data", run); socket.write("x"); },
        };
        const results = {};
        for (const [name, enter] of Object.entries(contexts)) {
          for (let round = 0; round < 20 && (${canAnswer} ? results[name]?.hits !== 2 : round < 1); round++) {
            await asking();
            results[name] = await new Promise(resolve => enter(() => order().then(resolve)));
          }
        }
        socket.destroy();
        server.close();
        console.log(JSON.stringify(results));
      })();
      `,
    );
    for (const context of contexts) {
      const { log, hits } = result[context];
      // A promise reaction is a microtask itself: the microtask queue empties before the nextTick queue.
      const start = context === "promise reaction" ? ["sync", "microtask", "nextTick"] : ["sync", "nextTick", "microtask"];
      // Never before the caller is done, whoever answers.
      expect({ context, start: log.slice(0, 3) }).toEqual({ context, start });
      if (canAnswer) {
        // Answered on the JS thread, it still comes from the loop, where the pool's answer
        // came from in nearly every run: behind the immediate, in the order asked.
        expect({ context, hits, log }).toEqual({ context, hits: 2, log: [...start, "immediate", "stat", "access"] });
      }
    }
  });

  test.concurrent("at the top level, comes before the first immediate", async () => {
    // What fs.test.ts pins for the pool ("keeps a non-throwing callback in the same place in the
    // event loop"), for an answer from the cache. The first script of a process cannot get one,
    // no mount is classified yet: the first script of a worker can.
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const canAnswer = answersFromCache(cwd);
    const result = await run(
      cwd,
      `
      const { Worker } = require("node:worker_threads");
      const topLevel = \`
        const fs = require("node:fs");
        const { getCounters } = require("bun:internal-for-testing");
        const log = [];
        const before = getCounters().fs_cached_hit;
        fs.stat("file.txt", (err, stats) => {
          log.push("fs-cb:" + (err === null) + ":" + stats.isFile());
          process.nextTick(() => log.push("tick-from-fs-cb"));
        });
        const hits = getCounters().fs_cached_hit - before;
        setImmediate(() => {
          log.push("setImmediate");
          require("node:worker_threads").parentPort.postMessage({ log, hits });
        });
      \`;
      (async () => {
        await warm();
        let result;
        for (let attempt = 0; attempt < 20 && (${canAnswer} ? result?.hits !== 1 : attempt < 1); attempt++) {
          const worker = new Worker(topLevel, { eval: true });
          result = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
          await worker.terminate();
        }
        console.log(JSON.stringify(result));
      })();
      `,
    );
    expect(result).toEqual({
      log: ["fs-cb:true:true", "tick-from-fs-cb", "setImmediate"],
      hits: canAnswer ? 1 : 0,
    });
  });

  test.concurrent("a chain of awaited calls lets timers, immediates and I/O run", async () => {
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const result = await run(
      cwd,
      `
      (async () => {
        await warm();
        await asking();
        let timerFired = false, immediates = 0, calls = 0;
        setTimeout(() => { timerFired = true; }, 1);
        const again = () => { immediates++; if (!timerFired) setImmediate(again); };
        setImmediate(again);
        const { hits } = await counted(async () => {
          while (!timerFired) { await fsp.stat("file.txt"); calls++; }
        });
        console.log(JSON.stringify({ timerFired, immediatesRan: immediates >= calls, answered: hits > 0, calls: calls > 0 }));
      })();
      `,
    );
    expect(result).toEqual({
      timerFired: true,
      immediatesRan: true,
      answered: answersFromCache(cwd),
      calls: true,
    });
  });

  test.concurrent("stops asking when a turn needs the pool anyway", async () => {
    using dir = tempDir("fs-cached", files);
    const cwd = String(dir);
    const result = await run(
      cwd,
      `
      (async () => {
        await warm();
        const stats = n => Promise.all(Array.from({ length: n }, () => fsp.stat("file.txt").then(s => s.size)));
        // More calls in one turn than it answers: the rest are the pool's.
        const wide = await countedUntil(round => round.hits === 16, () => stats(100));
        // Names that the kernel has never been asked for: the first ends the asking for the turn.
        await asking();
        const unknown = await counted(() => Promise.all(Array.from({ length: 20 }, (_, i) => fsp.exists("never-seen-" + i))));
        const mixed = await countedUntil(
          round => round.hits === 1 && round.misses === 1,
          round => Promise.all([fsp.exists("file.txt"), fsp.exists("never-seen-again-" + round), fsp.exists("file.txt")]),
        );
        // Turn after turn of them: it asks less and less often.
        await asking();
        const persistent = await counted(async () => {
          for (let i = 0; i < 200; i++) await fsp.exists("never-seen-in-turn-" + i);
        });
        // And it asks again once the kernel answers.
        const after = await countedUntil(round => round.hits === 3, () => stats(3));
        console.log(JSON.stringify({ wide, unknown, mixed, persistent, after }));
      })();
      `,
    );
    expect(result.wide.result).toEqual(Array(100).fill(5));
    expect(result.unknown.result).toEqual(Array(20).fill(false));
    expect(result.mixed.result).toEqual([true, false, true]);
    expect(result.after.result).toEqual([5, 5, 5]);
    if (answersFromCache(cwd)) {
      expect({
        wide: { hits: result.wide.hits, misses: result.wide.misses },
        unknown: { hits: result.unknown.hits, misses: result.unknown.misses },
        mixed: { hits: result.mixed.hits, misses: result.mixed.misses },
        persistent: {
          hits: result.persistent.hits,
          askedAgain: result.persistent.misses >= 2,
          askedRarely: result.persistent.misses <= 24,
        },
        after: { hits: result.after.hits, misses: result.after.misses },
      }).toEqual({
        wide: { hits: 16, misses: 0 },
        unknown: { hits: 0, misses: 1 },
        mixed: { hits: 1, misses: 1 },
        persistent: { hits: 0, askedAgain: true, askedRarely: true },
        after: { hits: 3, misses: 0 },
      });
    }
  });

  test.concurrent("BUN_FEATURE_FLAG_DISABLE_ASYNC_FS_FAST_PATH leaves every call to the pool", async () => {
    using dir = tempDir("fs-cached", files);
    const result = await run(
      String(dir),
      `
      (async () => {
        await warm();
        console.log(JSON.stringify(await counted(async () => [(await fsp.stat("file.txt")).size, await fsp.exists("file.txt"), await fsp.exists("missing.txt")])));
      })();
      `,
      { BUN_FEATURE_FLAG_DISABLE_ASYNC_FS_FAST_PATH: "1" },
    );
    expect(result).toEqual({ result: [5, true, false], hits: 0, misses: 0 });
  });

  test.concurrent("a worker that stops with answers still queued", async () => {
    using dir = tempDir("fs-cached", files);
    const result = await run(
      String(dir),
      `
      const { Worker } = require("node:worker_threads");
      (async () => {
        await warm();
        const exits = [];
        for (let i = 0; i < 8; i++) {
          const worker = new Worker(
            'const fsp = require("node:fs/promises"); const { parentPort } = require("node:worker_threads");' +
              'fsp.stat("file.txt").then(() => { for (let i = 0; i < 8; i++) fsp.stat("file.txt"); parentPort.postMessage("queued"); });',
            { eval: true },
          );
          await new Promise(resolve => worker.once("message", resolve));
          exits.push(await worker.terminate());
        }
        console.log(JSON.stringify(exits.length));
      })();
      `,
    );
    expect(result).toBe(8);
  });

  test.concurrent.skipIf(!isLinux || process.getuid?.() !== 0)(
    "access and exists ask the pool when the effective user is not the real one",
    async () => {
      using dir = tempDir("fs-cached", files);
      const cwd = String(dir);
      const canAnswer = answersFromCache(cwd);
      const result = await run(
        cwd,
        `
        (async () => {
          await warm();
          const calls = async () => [(await fsp.stat("file.txt")).size, await fsp.exists("file.txt"), await settle(() => fsp.access("file.txt"))];
          const same = await countedUntil(round => !${canAnswer} || round.hits === 3, calls);
          // access(2) decides for the real user (root), a lookup for the effective one.
          fs.chmodSync(".", 0o755);
          process.seteuid(65534);
          const other = await countedUntil(round => !${canAnswer} || (round.hits === 1 && round.misses >= 1), calls);
          process.seteuid(0);
          console.log(JSON.stringify({ same, other }));
        })();
        `,
      );
      expect(result.same.result).toEqual([5, true, { value: null }]);
      expect(result.other.result).toEqual([5, true, { value: null }]);
      if (canAnswer) {
        expect({ hits: result.same.hits, misses: result.same.misses }).toEqual({ hits: 3, misses: 0 });
        // stat decides for the effective user, as the lookup does: it is still answered.
        expect({ hits: result.other.hits, asked: result.other.misses >= 1 }).toEqual({ hits: 1, asked: true });
      }
    },
  );
});
