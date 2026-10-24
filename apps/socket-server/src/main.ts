import { readConfig } from './config.ts';
import { createSocketServer } from './server.ts';

const config = readConfig();
const server = createSocketServer(config);
server.httpServer.on('error', (error) => {
  console.error('Socket server failed:', error.message);
  process.exitCode = 1;
});
server.httpServer.listen(config.port, config.host, () => {
  console.log(
    `Socket server listening on http://${config.host}:${config.port}`,
  );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
  } catch (error) {
    console.error('Socket server shutdown failed:', error);
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
