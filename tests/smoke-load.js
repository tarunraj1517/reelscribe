// Smoke test: loads server.js with every third-party module replaced by a stub, to catch
// load-time errors (typos, use-before-define, bad requires) without needing MongoDB or npm install.
// Run:  node tests/smoke-load.js
const Module = require("module");
process.env.SESSION_SECRET = "x"; process.env.MONGO_URI = "mongodb://stub";

function stub(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_, p) {
      if (p === "then") return undefined;                       // never look like a thenable
      if (p === "connect") return () => Promise.resolve();      // mongoose.connect(...).then(...)
      if (p === Symbol.toPrimitive) return () => "stub";
      if (p === "length") return 0;
      if (p === "name") return name;
      if (p === "prototype") return {};
      return stub(`${name}.${String(p)}`);
    },
    apply: () => stub(`${name}()`),
    construct: () => stub(`new ${name}`),
  });
}
const cache = new Map();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const builtin = Module.builtinModules.includes(request.replace(/^node:/, ""));
  if (builtin || request.startsWith(".") || request.startsWith("/")) return origLoad.call(this, request, parent, isMain);
  if (!cache.has(request)) cache.set(request, stub(request));
  return cache.get(request);
};
const realListen = null;
require("../server.js");
console.log("✅ server.js loaded with all feature modules registered (no load-time errors)");
setTimeout(() => process.exit(0), 200);
