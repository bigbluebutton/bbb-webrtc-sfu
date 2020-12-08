/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const cp = require('child_process');
const Logger = require('./utils/Logger.js');
const config = require('config');
const PROCESSES = config.get('processes');

const UNEXPECTED_TERMINATION_SIGNALS = ['SIGABRT', 'SIGBUS', 'SIGSEGV', 'SIGILL'];
const LOG_PREFIX = '[ProcessManager]';
const PROCESS_RESPAWN_DELAY = 3000;

module.exports = class ProcessManager {
  constructor() {
    this.processes = {};
    this.runningState = "RUNNING";
  }

  async start () {
    // Start the rest of the preconfigured SFU modules
    for (let i = 0; i < PROCESSES.length; i++) {
      let { path } = PROCESSES[i];
      let proc = this.startProcess(path);;
      this.processes[proc.pid] = proc;
    }

    process.on('SIGTERM', async () => {
      await this.finishChildProcesses();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await this.finishChildProcesses();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      if (error.code === 'EADDRINUSE') {
        Logger.info(LOG_PREFIX, "There's probably another master SFU instance running, keep this one as slave");
        return;
      }
      Logger.error(LOG_PREFIX, "CRITICAL: uncaught exception, shutdown", { error: error.stack });
      await this.finishChildProcesses();
      process.exit('1');
    });

    // Added this listener to identify unhandled promises, but we should start making
    // sense of those as we find them
    process.on('unhandledRejection', (reason, p) => {
      Logger.error(LOG_PREFIX, "CRITICAL: Unhandled promise rejection", { reason: reason.toString() });
    });
  }

  startProcess (processPath) {
    Logger.info(LOG_PREFIX, "Forking process", processPath);
    let proc = cp.fork(processPath, {
      // Pass over all of the environment.
      env: process.ENV,
      // Share stdout/stderr, so we can hear the inevitable errors.
      silent: false
    });

    proc.path = processPath;

    proc.on('message', this.onMessage);
    proc.on('error', this.onError);

    // Tries to restart process on unsucessful exit
    proc.on('exit', (code, signal) => {
      let processId = proc.pid;
      const shouldRestart = this.runningState === 'RUNNING'
        && (code === 1 || UNEXPECTED_TERMINATION_SIGNALS.includes(signal));

      if (shouldRestart) {
        Logger.error(LOG_PREFIX, "Received exit event from child process, restarting it",
          { code, signal, pid: proc.pid, process: processPath });
        this.restartProcess(processId);
      } else {
        Logger.warn(LOG_PREFIX, "Received final exit event from child process, process shutdown",
          { code, signal, pid: proc.pid, process: processPath });
      }
    });

    return proc;
  }

  restartProcess (pid) {
    let proc = this.processes[pid];
    if (proc) {
      setTimeout(() => {
        let newProcess = this.startProcess(proc.path);
        this.processes[newProcess.pid] = newProcess;
        delete this.processes[pid];
      }, PROCESS_RESPAWN_DELAY);
    }
  }

  onMessage (message) {
    Logger.info(LOG_PREFIX, "Received message from forked process",
      { pid: this.pid, message });
  }

  onError (error) {
    Logger.error(LOG_PREFIX, "Forked process error event",
      { pid: this.pid, errorMessage: error.message, errorName: error.name, errorCode: error.code });
  }

  async finishChildProcesses () {
    this.runningState = "STOPPING";

    for (var proc in this.processes) {
      if (this.processes.hasOwnProperty(proc)) {
        let procObj = this.processes[proc];
        if (typeof procObj.exit === 'function' && !procObj.killed) {
          await procObj.exit()
        }
      }
    }

    this.runningState = "STOPPED";
  }
}
