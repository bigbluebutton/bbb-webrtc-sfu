"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const bbb_sfu_baseplate_1 = require("bbb-sfu-baseplate");
const config_1 = __importDefault(require("config"));
const LOG_CONFIG = config_1.default.get('log');
const { level, filename = false, stdout = true } = LOG_CONFIG;
const Logger = bbb_sfu_baseplate_1.LoggerBuilder({
    maxLevel: level,
    file: filename,
    stdout,
    colorize: process.env.NODE_ENV !== 'production'
});
exports.Logger = Logger;
