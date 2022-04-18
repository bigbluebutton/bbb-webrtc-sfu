/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const Logger = require('../common/logger.js');
const config = require('config');
const MODULES = config.get('modules');
const ProcessWrapper = require('./process-wrapper.js');
const { PrometheusAgent, SFUM_NAMES } = require('./metrics/main-metrics.js');

const UNEXPECTED_TERMINATION_SIGNALS = ['SIGABRT', 'SIGBUS', 'SIGSEGV', 'SIGILL'];

class SFUModuleManager {
  constructor() {
    this.modules = {};
    this.runningState = "RUNNING";
  }

  start () {
    // Start the rest of the preconfigured SFU modules
    for (let i = 0; i < MODULES.length; i++) {
      let { name, path, routingAliases, ipc } = MODULES[i];
      let proc = new ProcessWrapper(name, path, ipc.mode, {
        ipcOptions: ipc.options,
        routingAliases,
      });
      proc.start();
      this.trackModuleShutdown(proc);
      this.modules[proc.name] = proc;
    }

    process.on('SIGTERM', async () => {
      await this.stopModules();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await this.stopModules();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      if (error.code === 'EADDRINUSE') {
        Logger.info("There's probably another master SFU instance running, keep this one as a replica");
        return;
      }
      Logger.error("CRITICAL: uncaught exception, shutdown", { error: error.stack });
      await this.stopModules();
      process.exit('1');
    });

    // Added this listener to identify unhandled promises, but we should start making
    // sense of those as we find them
    process.on('unhandledRejection', (reason) => {
      Logger.error("CRITICAL: Unhandled promise rejection", { reason: reason.toString() });
    });
  }

  trackModuleShutdown (proc) {
    // Tries to restart process on unsucessful exit
    proc.process.on('exit', (code, signal) => {
      const shouldRestart = this.runningState === 'RUNNING'
        && (code === 1 || UNEXPECTED_TERMINATION_SIGNALS.includes(signal));
      if (shouldRestart) {
        Logger.error("Received exit event from child process, restarting it",
          { code, signal, pid: proc.process.pid, process: proc.path });
        PrometheusAgent.increment(SFUM_NAMES.MODULE_CRASHES, {
          module: proc.name,
          signal,
        });
        proc.restart();
      } else {
        Logger.warn("Received final exit event from child process, process shutdown",
          { code, signal, pid: proc.process.pid, process: proc.path });
        proc.stop();
      }
    });
  }

  async stopModules () {
    this.runningState = "STOPPING";

    for (var proc in this.modules) {
      if (Object.prototype.hasOwnProperty.call(this.modules, proc)) {
        let procObj = this.modules[proc];
        if (typeof procObj.stop === 'function') procObj.stop()
      }
    }

    this.runningState = "STOPPED";
  }
}

const SMM = new SFUModuleManager();
module.exports = SMM;
