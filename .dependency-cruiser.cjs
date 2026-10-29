/** Architecture fitness rules — see scripts/quality/arch.mjs. */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment:
        "Circular imports make module load order fragile. Baseline 109 (barrel index files); ratchet to error once the barrels are split.",
      from: {},
      to: { circular: true },
    },
    {
      name: "services-no-routes",
      severity: "error",
      comment: "Services must not import the Express route layer (tests excepted).",
      from: { path: "^src/services", pathNot: "__tests__" },
      to: { path: "^src/routes" },
    },
    {
      name: "utils-no-routes",
      severity: "error",
      comment: "src/utils is a leaf library; importing the route layer inverts the dependency direction.",
      from: { path: "^src/utils", pathNot: "__tests__" },
      to: { path: "^src/routes" },
    },
    {
      name: "utils-no-services",
      severity: "warn",
      comment: "src/utils is a leaf library; importing services from it inverts the dependency direction.",
      from: { path: "^src/utils" },
      to: { path: "^src/services" },
    },
    {
      name: "providers-no-services",
      severity: "warn",
      comment: "Provider adapters should depend on utils/config, not on services.",
      from: { path: "^src/providers" },
      to: { path: "^src/services" },
    },
    {
      name: "routes-no-routes",
      severity: "warn",
      comment: "Route modules should share helpers via src/routes/utils or src/utils, not import each other.",
      from: { path: "^src/routes/([^/]+)/" },
      to: { path: "^src/routes/([^/]+)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)node_modules/|\\.worktrees/|/dist/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
