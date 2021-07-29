import { LoggerBuilder } from 'bbb-sfu-baseplate';
import config from 'config';

const LOG_CONFIG: {
  level: string;
  filename?: string | false;
  stdout?: boolean;
} = config.get('log');

const { level, filename = false, stdout = true } = LOG_CONFIG;

const Logger =  LoggerBuilder({
  maxLevel: level,
  file: filename,
  stdout,
  colorize: process.env.NODE_ENV !== 'production'
});

export {
  Logger
}
