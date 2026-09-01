import type { Logger, LoggerOptions } from 'pino';
import pino from 'pino';

let logger: Logger;
const nodeEnv = process.env.NODE_ENV ?? 'development';
const logLevel = process.env.LOG_LEVEL ?? 'info';

const loggerOptions: LoggerOptions = {
  level: logLevel,

  // Use OTel semantic keys so collectors can consume service metadata directly.
  base: {
    'service.name': process.env.SERVICE_NAME ?? 'gateway-api',
    ...(process.env.SERVICE_VERSION && {
      'service.version': process.env.SERVICE_VERSION,
    }),
    'deployment.environment': nodeEnv,
  },

  // Preserve nested causes in structured errors.
  serializers: {
    err: pino.stdSerializers.errWithCause,
  },

  timestamp: pino.stdTimeFunctions.isoTime,
};

// Avoid transport worker-thread errors during Bun test teardown.
if (nodeEnv === 'production' || nodeEnv === 'test') {
  logger = pino(loggerOptions);
} else {
  logger = pino(
    loggerOptions,
    pino.transport({
      targets: [
        {
          target: 'pino-pretty', // Pretty logs to console
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            // pino-pretty treats unescaped dots as nested paths.
            ignore: 'service\\.name,service\\.version,deployment\\.environment',
          },

          level: logLevel,
        },
      ],
    }),
  );
}

export type { Logger };
export { logger };
export default logger;
