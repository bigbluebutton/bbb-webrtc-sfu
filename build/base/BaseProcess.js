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
const { Logger } = require('../utils/Logger');
const config = require('config');
const C = require('../bbb/messages/Constants');
module.exports = class BaseProcess {
    constructor(manager, logPrefix = C.BASE_PROCESS_PREFIX) {
        this.runningState = "RUNNING";
        this.manager = manager;
        this.logPrefix = logPrefix;
    }
    start() {
        this.manager.start();
        if (config.get('acceptSelfSignedCertificate')) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
        }
        process.on('disconnect', this.stop.bind(this));
        process.on('SIGTERM', this.stop.bind(this));
        process.on('SIGINT', this.stop.bind(this));
        process.on('uncaughtException', this.handleException.bind(this));
        process.on('unhandledRejection', this.handleRejection.bind(this));
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                this.runningState = "STOPPING";
                Promise.race([this.manager.stopAll(), this._failOver()]).then(() => {
                    Logger.info(this.logPrefix, "Exiting process with code 0");
                    process.exit();
                });
            }
            catch (err) {
                Logger.error(this.logPrefix, err);
                Logger.info(this.logPrefix, "Exiting process with code 1");
                process.exit(1);
            }
        });
    }
    _failOver() {
        return new Promise((resolve, reject) => {
            setTimeout(resolve, 5000);
        });
    }
    handleException(error) {
        Logger.error(this.logPrefix, 'TODO => Uncaught exception', error.stack);
        if (this.runningState === "STOPPING") {
            Logger.warn(this.logPrefix, "Exiting process with code 1");
            process.exit(1);
        }
    }
    handleRejection(reason, promise) {
        Logger.error(this.logPrefix, 'TODO => Unhandled Rejection at: Promise', promise, 'reason:', reason);
        if (this.runningState === "STOPPING") {
            Logger.warn(this.logPrefix, "Exiting process with code 1");
            process.exit(1);
        }
    }
};
