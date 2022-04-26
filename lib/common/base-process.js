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
        Logger.info("Graceful process shutdown: code 0");
        process.exit();
      });
    }
    catch (error) {
      Logger.warn("Ungraceful process shutdown: code 1", {
        errorMessage: error.message,
      });
      process.exit(1);
    }
  }

  _failOver () {
    return new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });
  }

  handleException (error) {
    Logger.error("Uncaught exception", error);
    if (this.runningState === "STOPPING") {
      Logger.warn("Ungraceful process shutdown: code 1", {
        errorMessage: error.message,
      });
      process.exit(1);
    }
  }

  handleRejection (reason) {
    Logger.error("Unhandled rejection", reason);
    if (this.runningState === "STOPPING") {
      Logger.warn("Ungraceful process shutdown: code 1", {
        errorMessage: reason,
      });
      process.exit(1);
    }
  }
}
