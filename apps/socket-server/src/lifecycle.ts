import type { AppLogger } from './logger.ts';
export function installFatalLogging(logger: AppLogger) {
  const fatal = (err: Error, origin: string) => {
    logger.fatal(
      { event: 'process.fatal', err, origin },
      'Socket server terminating',
    );
    logger.flush();
  };
  const warning = (err: Error) =>
    logger.warn({ event: 'process.warning', err }, 'Node runtime warning');
  process.on('uncaughtExceptionMonitor', fatal);
  process.on('warning', warning);
  return () => {
    process.off('uncaughtExceptionMonitor', fatal);
    process.off('warning', warning);
  };
}
export function installShutdown(
  logger: AppLogger,
  close: () => Promise<void>,
  timeoutMs = 15_000,
) {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const started = Date.now();
    logger.info(
      { event: 'process.shutdown', signal },
      'Socket server stopping',
    );
    const timer = setTimeout(() => {
      logger.fatal(
        { event: 'process.shutdown_timeout', timeoutMs },
        'Shutdown deadline exceeded; call finalization may be incomplete',
      );
      logger.flush();
      process.exit(1);
    }, timeoutMs);
    try {
      await close();
      logger.info(
        { event: 'process.stopped', durationMs: Date.now() - started },
        'Socket server stopped',
      );
    } catch (err) {
      logger.error(
        { event: 'process.shutdown_failed', err },
        'Socket server shutdown failed',
      );
      logger.flush();
      process.exit(1);
    } finally {
      clearTimeout(timer);
      logger.flush();
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
