'use strict';

const Winston = require('winston');
const Logger = new Winston.Logger();
const config = require('config');

const LOG_CONFIG = config.get('log') || {};
const { level, filename, stdout = true } = LOG_CONFIG;
const COLORIZE = process.env.NODE_ENV !== 'production';

Logger.configure({
  levels: { error: 0, warn: 1, info: 2, verbose: 3, debug: 4, trace: 5 },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    verbose: 'cyan',
    debug: 'magenta',
    trace: 'gray'
  },
});

if (stdout) {
  Logger.add(Winston.transports.Console, {
    timestamp: true,
    prettyPrint: false,
    humanReadableUnhandledException: true,
    colorize: COLORIZE,
    handleExceptions: false,
    silent: false,
    level,
  });
}


if (filename) {
  Logger.add(Winston.transports.File, {
    timestamp: true,
    filename,
    prettyPrint: false,
    level,
  });
}

module.exports = Logger;
