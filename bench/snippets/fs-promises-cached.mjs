// Async node:fs calls whose answer the kernel already holds in memory, one at a time and in
// batches, beside their sync twins.
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, group, run } from "../runner.mjs";

const dir = mkdtempSync(join(tmpdir(), "fs-promises-cached-"));
const file = join(dir, "file.txt");
const link = join(dir, "link");
const missing = join(dir, "missing.txt");
writeFileSync(file, "hello");
symlinkSync(file, link);
// The first lookup of each name puts it into the kernel's cache.
statSync(file);
existsSync(missing);

const exists = path =>
  access(path).then(
    () => true,
    () => false,
  );

group("one call", () => {
  bench("statSync(file)", () => statSync(file));
  bench("await stat(file)", () => stat(file));
  bench("await lstat(symlink)", () => lstat(link));
  bench("await access(file)", () => access(file));
  bench("await stat(missing)", () => stat(missing).catch(() => {}));
  bench("await access(missing)", () => exists(missing));
});

for (const width of [4, 16, 64, 1024]) {
  const paths = Array.from({ length: width }, () => file);
  group(`${width} calls at once`, () => {
    bench(`Promise.all(${width} x stat(file))`, () => Promise.all(paths.map(path => stat(path))));
    bench(`Promise.all(${width} x access(missing))`, () => Promise.all(paths.map(() => exists(missing))));
  });
}

await run();
rmSync(dir, { recursive: true, force: true });
