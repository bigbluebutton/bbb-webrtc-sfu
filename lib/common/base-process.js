'use strict'

const Logger = require('./logger.js');
const config = require('config');
const BASE_PROCESS_PREFIX = '[base-process]';

module.exports = class BaseProcess {
  constructor(app, logPrefix = BASE_PROCESS_PREFIX) {
    this.runningState = "RUNNING";
    this.app = app;
    this.logPrefix = logPrefix;
  }

  start () {
    this.app.start();

    if (config.get('acceptSelfSignedCertificate')) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED=0;
    }

    process.on('disconnect', this.stop.bind(this));
    process.on('SIGTERM', this.stop.bind(this));
    process.on('SIGINT', this.stop.bind(this));
    process.on('uncaughtException', this.handleException.bind(this));
    process.on('unhandledRejection', this.handleRejection.bind(this));
  }

  async stop () {
    try {
      this.runningState = "STOPPING";
      Promise.race([this.app.stop(), this._failOver()]).then(() => {
        Logger.info(this.logPrefix, "Exiting process with code 0");
        process.exit();
      });
    }
    catch (err) {
      Logger.error(this.logPrefix, err);
      Logger.info(this.logPrefix, "Exiting process with code 1");
      process.exit(1);
    }
  }

  _failOver () {
    return new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });
  }

  handleException (error) {
    Logger.error(this.logPrefix, 'TODO => Uncaught exception', error.stack);
    if (this.runningState === "STOPPING") {
      Logger.warn(this.logPrefix, "Exiting process with code 1");
      process.exit(1);
    }
  }

  handleRejection (reason, promise) {
    Logger.error(this.logPrefix, 'TODO => Unhandled Rejection at: Promise', promise, 'reason:', reason);
    if (this.runningState === "STOPPING") {
      Logger.warn(this.logPrefix, "Exiting process with code 1");
      process.exit(1);
    }
  }
}
