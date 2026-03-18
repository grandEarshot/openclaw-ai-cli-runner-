import test from "node:test";
import assert from "node:assert/strict";
import register from "../src/index.ts";

test("plugin registers four optional tools", () => {
  const registrations: Array<{ name: string; optional: boolean | undefined }> = [];
  const commands: string[] = [];

  register({
    registerTool(tool, options) {
      registrations.push({ name: tool.name, optional: options?.optional });
    },
    registerCommand(command) {
      commands.push(command.name);
    },
  });

  assert.deepEqual(
    registrations.map((entry) => entry.name).sort(),
    [
      "execute_ai_cli_cancel",
      "execute_ai_cli_result",
      "execute_ai_cli_status",
      "execute_ai_cli_submit",
    ],
  );
  assert.equal(registrations.every((entry) => entry.optional === true), true);
  assert.deepEqual(commands, ["cc"]);
});
