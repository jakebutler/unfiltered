# Corvo Clinic interface

Static React application for the shared same-origin clinic API. Start the API on `127.0.0.1:8787`, then run from the repository root:

```sh
npx vite --config apps/clinic/vite.config.ts
npx tsc -p apps/clinic/tsconfig.json
npx vite build --config apps/clinic/vite.config.ts
```

Patient demo: `http://127.0.0.1:5173/`. Staff workspace: `http://127.0.0.1:5173/staff`.

The dev proxy preserves the browser Origin. The deployment must serve `/api` on the same origin, send all frontend routes to `index.html`, and configure server-side allowed origins. Session and staff credentials stay in HttpOnly cookies. This UI does not supply a backend, staff account, fabricated delivery receipt, or voice integration.

Fonts are self-hosted variable Inter and Space Grotesk from the Google Fonts source repository, under the accompanying SIL Open Font Licenses. Source URLs:

- https://github.com/google/fonts/tree/main/ofl/inter
- https://github.com/google/fonts/tree/main/ofl/spacegrotesk

Desktop and mobile rendered verification and API end-to-end workflow validation must run against the actual clinic service before the application is considered complete.
