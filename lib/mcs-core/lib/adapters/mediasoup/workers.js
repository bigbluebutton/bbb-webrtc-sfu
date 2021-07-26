'use strict';

const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const { WORKER_SETTINGS, LOG_PREFIX } = require('./configs.js');

// WORKER_STORAGE: [<worker>]. Registers mediasoup workers, raw form
const WORKER_STORAGE = [];

const storeWorker = (worker) => {
  if (!worker) return false;

  if (hasWorker(worker.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  WORKER_STORAGE.push(worker);

  return true;
}

const getWorker = (id) => {
  return WORKER_STORAGE.find(worker => worker.internalAdapterId === id);
}

const hasWorker = (id) => {
  return WORKER_STORAGE.some(worker => worker.internalAdapterId === id);
}

// Round-robin
const getWorkerRR = () => {
  const worker = WORKER_STORAGE.shift();
  if (worker) {
    WORKER_STORAGE.push(worker);
  }
  return worker;
}

const deleteWorker = (id) => {
  let deleted = false;
  let i = 0;

  while (i < WORKER_STORAGE.length || !deleted) {
    if (WORKER_STORAGE[i].id === id) {
      WORKER_STORAGE.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  return deleted;
}

const setupWorkerCrashHandler = (worker) => {
  const onMediaServerOffline = (error) => {
    Logger.error(LOG_PREFIX, 'CRITICAL: Worker crashed',
      { errorMessage: error.Message, errorCode: error.code });
    //this._destroyElementsFromWorker(worker);
  };

  worker.on('died', onMediaServerOffline);
  // TODO fire offline event upstream
};

const createWorkers = (nofWorkers, workerSettings = WORKER_SETTINGS) => {
  for (let i = 0; i < nofWorkers; i++) {
    createWorker(workerSettings).then((worker) => {
      storeWorker(worker);
    }).catch(error => {
      Logger.error(LOG_PREFIX, 'Worker creation failed',
        { errorMessage: error.Message, errorCode: error.code });
    });
  }
}

const createWorker = async (workerSettings = WORKER_SETTINGS) => {
  try {
    const worker = await mediasoup.createWorker(workerSettings)
    worker.internalAdapterId = uuidv4();
    //setupWorkerCrashHandler(this._worker);
    Logger.info(LOG_PREFIX, 'New worker created');
    return worker;
  } catch (error) {
    Logger.error(LOG_PREFIX, 'Worker creation failed',
      { errorMessage: error.Message, errorCode: error.code });
    throw error;
  }
}

const stopWorker = (worker) => {
  worker.close();
}

module.exports = {
  createWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
