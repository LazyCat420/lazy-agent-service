# vendor/

Local copies of third-party packages that would otherwise be fetched from a
GitHub tarball at build time. We vendor them because a private/renamed repo or a
force-pushed/deleted commit makes `codeload.github.com` return 404, and
`pnpm install --frozen-lockfile` (used in the Docker build) then fails the whole
deploy. A committed tarball never 404s.

## `@rodrigo-barraza/utilities-library`

Rod's library. Consumed via `file:vendor/rodrigo-barraza-utilities-library-<ver>.tgz`
in `package.json`. This is a **built** artifact (its `dist/` is already compiled),
so nothing here is edited — see the "never edit Rod's code" rule.

### Refreshing to a newer version

When you need a newer commit of Rod's library:

```bash
# 1. Temporarily point package.json back at the GitHub tarball for the commit
#    you want, then install so it lands in node_modules:
pnpm install --no-frozen-lockfile

# 2. Repack the freshly-installed copy into this folder:
npm pack ./node_modules/@rodrigo-barraza/utilities-library
mv rodrigo-barraza-utilities-library-*.tgz vendor/

# 3. Point package.json at the new vendored file and delete the old .tgz:
#    "@rodrigo-barraza/utilities-library": "file:vendor/rodrigo-barraza-utilities-library-<newver>.tgz"

# 4. Regenerate the lockfile and verify a clean build:
pnpm install --lockfile-only
docker build -t lazy-tool-service:vendor-check .
```

The tarball MUST be committed to git — it is what the Docker build copies in
before `pnpm install`.
