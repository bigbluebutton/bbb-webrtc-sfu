'use strict';

const StreamManager= require('./StreamManager');
const BaseProcess = require('../base/BaseProcess');
const C = require('../bbb/messages/Constants');

const manager = new StreamManager(C.TO_STREAM, [C.FROM_BBB_MEETING_CHAN], C.STREAM_MANAGER_PREFIX);
const newProcess = new BaseProcess(manager, C.STREAM_PROCESS_PREFIX);

newProcess.start();
