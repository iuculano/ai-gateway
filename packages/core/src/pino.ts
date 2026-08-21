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

// 'test' takes the plain logger for the same reason production does, but for a
// different problem: pino.transport() spawns a worker thread through
// thread-stream, and when the process ends that worker's exit surfaces as an
// unhandled 'error' event. Bun's test runner counts that as a failure AND tears
// the run down where it stands, so any test file that had not registered yet
// dies with "Cannot call describe() after the test run has completed" - four
// files across the workspace never ran at all.
//
// Nobody reads pretty-printed output from a test run, so there is nothing to
// lose by writing plain JSON there.
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
            // The service identity is noise on every dev line.
            //
            // The dots are escaped because pino-pretty reads an unescaped dot
            // as a path separator: 'service.name' means "the `name` field
            // inside `service`", which is not what these flat, dotted keys are.
            // Unescaped, this option silently matched nothing and every dev
            // line carried all three fields anyway.
            ignore: 'service\\.name,service\\.version,deployment\\.environment',
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
