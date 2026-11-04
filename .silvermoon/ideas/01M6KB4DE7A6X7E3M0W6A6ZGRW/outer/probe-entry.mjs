import app from "../../../../apps/worker/src/index.js";

function measuredBindings(env, counts) {
  const statements = new WeakMap();
  const wrapStatement = (statement) => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values) => wrapStatement(target.bind(...values));
        if (["first", "all", "run", "raw"].includes(property))
          return (...values) => {
            counts.d1Calls++;
            counts.sqlStatements++;
            return target[property](...values);
          };
        return Reflect.get(target, property, target);
      },
    });
    statements.set(wrapped, statement);
    return wrapped;
  };
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql) => wrapStatement(target.prepare(sql));
        if (property === "batch")
          return (batch) => {
            counts.d1Calls++;
            counts.sqlStatements += batch.length;
            return target.batch(
              batch.map((statement) => statements.get(statement) ?? statement),
            );
          };
        return Reflect.get(target, property, target);
      },
    }),
    BLOCKS: new Proxy(env.BLOCKS, {
      get(target, property) {
        if (["get", "head", "put", "delete", "list"].includes(property))
          return (...values) => {
            counts.r2Calls++;
            counts.r2Operations[property]++;
            return target[property](...values);
          };
        return Reflect.get(target, property, target);
      },
    }),
  };
}

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const counts = {
      d1Calls: 0,
      sqlStatements: 0,
      r2Calls: 0,
      r2Operations: { get: 0, head: 0, put: 0, delete: 0, list: 0 },
    };
    const started = Date.now();
    let ok = false;
    try {
      await app.scheduled(controller, measuredBindings(env, counts), ctx);
      ok = true;
    } finally {
      console.log(
        JSON.stringify({
          event: "retention_runtime_budget",
          ...counts,
          bindingCalls: counts.d1Calls + counts.r2Calls,
          wallMs: Date.now() - started,
          ok,
        }),
      );
    }
  },
};
