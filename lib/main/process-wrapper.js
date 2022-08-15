'use strict';

const cp = require('child_process');
const Logger = require('../common/logger.js');
const { setProcessPriority } = require('../common/utils.js');

const PROCESS_RESPAWN_DELAY = 3000;
const { PrometheusAgent, SFUM_NAMES } = require('./metrics/main-metrics.js');

module.exports = class ProcessWrapper {
  static parseIPCOpts (opts) {
    if (opts == null) return;
    let sanOpts = {};

    if (opts.inboundChannel && typeof opts.inboundChannel === 'string') {
      sanOpts.inboundChannel = opts.inboundChannel;
    }
    if (opts.outboundChannel && typeof opts.outboundChannel === 'string') {
      sanOpts.outboundChannel = opts.outboundChannel;
    }

    return sanOpts;
  }

  constructor (name, path, ipcMode, {
    ipcOptions = {},
    routingAliases = [],
    priority,
  }) {
    this.process;
    this.name = name;
    this.path = path;
    this.ipcMode = ipcMode;
    this.ipcOptions = ProcessWrapper.parseIPCOpts(ipcOptions);
    this.routingAliases = routingAliases;
    this.priority = priority;
    this.runningState = "RUNNING";
  }

  set onmessage (callback) {
    this.process.removeListener('message', this._onMessage);
    this._onMessage = callback;
    this.process.on('message', this._onMessage);
  }

  get onmessage () {
    return this._onMessage;
  }

  matchesRoute (route) {
    return route === this.name
      || this.routingAliases.some(targetRoute => targetRoute === route);
  }

  _onMessage (message) {
    Logger.info("Received message from forked process",
      { pid: this.process.pid, message });
  }

  onError (error) {
    Logger.error("Forked process error event",
      { pid: this.process.pid, errorMessage: error.message, errorName: error.name, errorCode: error.code });
  }

  start () {
    const childEnv = {
      ...process.env,
      SFU_MODULE_NAME: this.name,
      SFU_IPC_MODE: this.ipcMode,
      SFU_IPC_OPTS: this.options,
      SFU_MODULE_PATH: this.path,
    }

    this.process = cp.fork(this.path, {
      // Pass over all of the environment.
      env: childEnv,
      // Share stdout/stderr, so we can hear the inevitable errors.
      silent: false
    });

    this.process.on('message', this._onMessage);
    this.process.on('error', this.onError.bind(this));

    if (this.priority) setProcessPriority(this.process.pid, this.priority);

    PrometheusAgent.set(SFUM_NAMES.MODULE_STATUS, 1, {
      module: this.name,
    });

    Logger.info("New module process forked", {
      name: this.name,
      ipc: this.ipcMode,
      path: this.path,
      pid: this.process.pid,
    });
  }

  restart () {
    this.stop();

    setTimeout(() => {
      this.start();
    }, PROCESS_RESPAWN_DELAY);
  }

  send (data) {
    // Serialization must be done beforehand, not my job.
    this.process.send(data);
  }

  stop () {
    this.runningState = "STOPPING";

    if (typeof this.process.stop === 'function' && !this.process.killed) {
      this.process.exit();
    }

    PrometheusAgent.set(SFUM_NAMES.MODULE_STATUS, 0, {
      module: this.name,
    });

    this.runningState = "STOPPED";
  }
}
