// Pino seems to have some issues with ESM imports

import type { Logger, LoggerOptions } from 'pino';
import pino from 'pino';

let logger: Logger;
const nodeEnv = process.env.NODE_ENV ?? 'development';
const logLevel = process.env.LOG_LEVEL ?? 'info';

const loggerOptions: LoggerOptions = {
  // This is 'global' log level, the minimum level of logs that will be emitted.
  // The transport must be AT OR BELOW this level.
  //
  // For example, if this is set to 'info', then the transport can't be set to
  // 'debug' because those logs are never emitted to begin with.
  level: logLevel,

  // Service identity on every line, named per OTel resource semantic
  // conventions so records map onto collectors and App Insights without a
  // rename step. Replaces pino's default pid/hostname base, which container
  // platforms stamp on their own.
  base: {
    'service.name': process.env.SERVICE_NAME ?? 'gateway-api',
    ...(process.env.SERVICE_VERSION && {
      'service.version': process.env.SERVICE_VERSION,
    }),
    'deployment.environment': nodeEnv,
  },

  // Standard error serialization under the 'err' key: message, stack, and
  // the nested cause chain, all kept inside one single-line record.
  serializers: {
    err: pino.stdSerializers.errWithCause,
  },

  timestamp: pino.stdTimeFunctions.isoTime,
};

if (nodeEnv === 'production') {
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
            // The service identity is noise on every dev line.
            ignore: 'service.name,service.version,deployment.environment',
          },

          // For now, just use the same log level
          level: logLevel,
        },
        //{
        //  target: 'pino/file',
        //  options: { destination: './logs.json' },
        //  level: 'info'
        //}
      ],
    }),
  );
}

export type { Logger };
export { logger };
export default logger;
