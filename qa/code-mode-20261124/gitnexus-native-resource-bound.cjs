// Analysis tooling only: bound native query concurrency through LadybugDB's
// supported Connection constructor. Preserve the original instance/prototype.
// No graph, parser, impact, or security logic changes.
const { createRequire } = require("node:module");
const requireFromRunner = createRequire(process.env.IAO_GITNEXUS_PACKAGE_JSON);
const lbug = requireFromRunner("@ladybugdb/core");
lbug.Connection = new Proxy(lbug.Connection, {
  construct(OriginalConnection, [database]) {
    return new OriginalConnection(database, 1);
  },
});

// Optional diagnostics, without altering query arguments/results.
if (process.env.IAO_GITNEXUS_DIAGNOSTIC === "1") {
  const originalQuery = lbug.Connection.prototype.query;
  lbug.Connection.prototype.query = async function (...args) {
    const label = String(args[0]).slice(0, 90).replace(/\s+/g, " ");
    process.stderr.write(JSON.stringify({ nativeQuery: "start", label, rss: process.memoryUsage().rss }) + "\n");
    const result = await Reflect.apply(originalQuery, this, args);
    process.stderr.write(JSON.stringify({ nativeQuery: "end", label, rss: process.memoryUsage().rss }) + "\n");
    return result;
  };
}
