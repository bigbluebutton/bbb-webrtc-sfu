/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const { Logger } = require('./utils/Logger.js');
const config = require('config');
const MODULES = config.get('modules');
const ProcessWrapper = require('./process-wrapper.js');
const UNEXPECTED_TERMINATION_SIGNALS = ['SIGABRT', 'SIGBUS', 'SIGSEGV', 'SIGILL'];
const LOG_PREFIX = '[SFUModuleManager]';
const PROCESS_RESPAWN_DELAY = 3000;
class SFUModuleManager {
    constructor() {
        this.modules = {};
        this.runningState = "RUNNING";
    }
    start() {
        // Start the rest of the preconfigured SFU modules
        for (let i = 0; i < MODULES.length; i++) {
            let { name, path, ipc } = MODULES[i];
            let proc = new ProcessWrapper(name, path, ipc.mode, ipc.options);
            proc.start();
            this.trackModuleShutdown(proc);
            this.modules[proc.name] = proc;
        }
        process.on('SIGTERM', () => __awaiter(this, void 0, void 0, function* () {
            yield this.stopModules();
            process.exit(0);
        }));
        process.on('SIGINT', () => __awaiter(this, void 0, void 0, function* () {
            yield this.stopModules();
            process.exit(0);
        }));
        process.on('uncaughtException', (error) => __awaiter(this, void 0, void 0, function* () {
            if (error.code === 'EADDRINUSE') {
                Logger.info(LOG_PREFIX, "There's probably another master SFU instance running, keep this one as slave");
                return;
            }
            Logger.error(LOG_PREFIX, "CRITICAL: uncaught exception, shutdown", { error: error.stack });
            yield this.stopModules();
            process.exit('1');
        }));
        // Added this listener to identify unhandled promises, but we should start making
        // sense of those as we find them
        process.on('unhandledRejection', (reason, p) => {
            Logger.error(LOG_PREFIX, "CRITICAL: Unhandled promise rejection", { reason: reason.toString() });
        });
    }
    trackModuleShutdown(proc) {
        // Tries to restart process on unsucessful exit
        proc.process.on('exit', (code, signal) => {
            const shouldRestart = this.runningState === 'RUNNING'
                && (code === 1 || UNEXPECTED_TERMINATION_SIGNALS.includes(signal));
            if (shouldRestart) {
                Logger.error(LOG_PREFIX, "Received exit event from child process, restarting it", { code, signal, pid: proc.process.pid, process: proc.path });
                proc.restart();
            }
            else {
                Logger.warn(LOG_PREFIX, "Received final exit event from child process, process shutdown", { code, signal, pid: proc.process.pid, process: proc.path });
            }
        });
    }
    stopModules() {
        return __awaiter(this, void 0, void 0, function* () {
            this.runningState = "STOPPING";
            for (var proc in this.modules) {
                if (this.modules.hasOwnProperty(proc)) {
                    let procObj = this.modules[proc];
                    if (typeof procObj.stop === 'function')
                        procObj.stop();
                }
            }
            this.runningState = "STOPPED";
        });
    }
}
const SMM = new SFUModuleManager();
module.exports = SMM;
