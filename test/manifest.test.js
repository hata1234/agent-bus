import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "..", "openclaw.plugin.json"), "utf8"));

test("task route config remains explicit and default-off in plugin manifest", () => {
  const properties = manifest.configSchema.properties;

  assert.equal(properties.taskRoutesEnabled.type, "boolean");
  assert.equal(properties.taskRoutesEnabled.default, false);

  assert.equal(properties.specialistTaskWritesEnabled.type, "boolean");
  assert.equal(properties.specialistTaskWritesEnabled.default, false);

  assert.equal(properties.ownerTaskRouteKey.type, "string");
  assert.equal(properties.ownerTaskRouteKey.default, "");
});
