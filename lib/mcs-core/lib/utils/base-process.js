'use strict'

const Logger = require('./logger');
const C = require('../constants/constants.js');
const config = require('config');

module.exports = class BaseProcess {
  constructor(controller, logPrefix = '[mcs-core-base-process]') {
    this.runningState = "RUNNING";
    this.controller = controller;
    this.logPrefix = logPrefix;
  }

  start () {
    this.controller.start();

    if (config.has('acceptSelfSignedCertificate') && config.get('acceptSelfSignedCertificate')) {
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
      Promise.race([this.controller.stop(), this._failOver()]).then(() => {
        Logger.info(this.logPrefix, "Exiting process with code 0");
        process.exit();
      });
    }
    catch (err) {
      Logger.error(this.logPrefix, "Error on exit. Exiting process with code 1", err);
      process.exit(1);
    }
  }

  _failOver () {
    return new Promise((resolve, reject) => {
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
