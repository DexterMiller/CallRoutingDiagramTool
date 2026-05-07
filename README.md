# CallRoutingDiagramTool

A browser-based 3CX call routing diagram tool for Cloudflare Workers Static Assets.

Users upload a 3CX backup zip, and the app parses the backup locally in the browser to build top-down call flow diagrams for:

- Inbound call flow
- After-hours and holiday routing
- Extension forwarding profiles

The uploaded backup is not sent to a server by this static app.

## Build

```bash
npm run build
```

The build copies the static app from `src/` into `dist/`.

## Deploy

```bash
npm run deploy
```

Cloudflare can also run `npx wrangler deploy` directly. The `wrangler.toml` file runs the build first, then uploads `dist/` as the static assets directory.
