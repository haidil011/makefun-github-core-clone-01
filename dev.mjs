// Local development server: createApp() on PORT (default 8123), bound to 127.0.0.1.
import { createApp } from './src/app.mjs';

const port = Number.parseInt(process.env.PORT ?? '8123', 10) || 8123;
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] listening on http://127.0.0.1:${port}\n`);
});
