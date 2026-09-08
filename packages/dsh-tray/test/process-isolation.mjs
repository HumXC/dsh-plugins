import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
export const openerCalls = [];

const openModuleId = require.resolve("open");
require.cache[openModuleId] = {
    id: openModuleId,
    filename: openModuleId,
    loaded: true,
    exports: {
        default: async url => {
            openerCalls.push({ url });
        },
    },
};

const guardedForbidden = name => () => {
    throw new Error(`[dsh-tray test isolation] unexpected child_process.${name} invocation`);
};

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[name] = guardedForbidden(name);
}
syncBuiltinESMExports();

export const resetOpenerCalls = () => {
    openerCalls.length = 0;
};
