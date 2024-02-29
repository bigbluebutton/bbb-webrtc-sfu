'use strict';

const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const {
  WORKER_SETTINGS, WORKER_PRIORITIES,
} = require('./configs.js');
const { setProcessPriority } = require('./utils.js');

const SHARED_POOL_ID = 'shared';

// WORKER_STORAGE: each key has a val in the form of [<worker>].
const WORKER_STORAGE = {
  [SHARED_POOL_ID]: [],
}

const _replaceWorker = (worker, replacementReason) => {
  const workerSettings = worker.appData.workerSettings;
  const workerUID = worker.appData.workerUID;
  const mediaType = worker.appData.mediaType || SHARED_POOL_ID;
  const oldWorkerId = worker.appData.internalAdapterId;

  stopWorker(worker);
  deleteWorker(worker);

  createWorker({
    workerSettings,
    mediaType,
    workerUID,
  }).then(newWorker => {
    Logger.info('mediasoup: replacement worker up', {
      mediaType,
      replacementReason,
      oldWorkerId,
      oldWorkerPID: worker.pid,
      newWorkerId: newWorker.appData.internalAdapterId,
      newWorkerPID: newWorker.pid,
      workerUID,
    });

    storeWorker(newWorker);
  }).catch(error => {
    Logger.error('mediasoup: worker replacement failed', {
      mediaType,
      replacementReason,
      oldWorkerId,
      oldWorkerPID: worker.pid,
      workerUID,
      errorMessage: error.message,
    });
  });
}

const _trackWorkerDeathEvent = (worker) => {
  worker.once('died', (error) => {
    const mediaType = worker.appData.mediaType || SHARED_POOL_ID;
    Logger.error('mediasoup: worker died', {
      errorMessage: error.message, workerId: worker.appData.internalAdapterId,
      workerPID: worker.pid, mediaType,
    });
    _replaceWorker(worker, 'died');
  });
};

const storeWorker = (worker) => {
  if (worker == null) return false;
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  if (typeof storage !== 'object') return false;

  if (hasWorker(storage, worker.appData.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  storage.push(worker);
  return true;
}

const _fetchWorkerStorage = (mediaType) => {
  if (mediaType && mediaType !== C.MEDIA_PROFILE.ALL) {
    const tentativeStorage = WORKER_STORAGE[mediaType];
    if (tentativeStorage) return tentativeStorage;
  }

  return WORKER_STORAGE[SHARED_POOL_ID];
}

const getWorker = (workerId, mediaType) => {
  const storage = _fetchWorkerStorage(mediaType);
  return storage.find(worker => worker.appData.internalAdapterId === workerId);
}

const hasWorker = (storage, workerId) => {
  return storage.some(worker => worker.appData.internalAdapterId === workerId);
}

// Round-robin
const getWorkerRR = (mediaType) => {
  const storage = _fetchWorkerStorage(mediaType);
  const worker = storage.shift();

  if (worker) {
    storage.push(worker);
  }

  return worker;
}

const deleteWorker = (worker) => {
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  let deleted = false;
  let i = 0;

  while (i < storage.length || !deleted) {
    if (storage[i].appData.internalAdapterId === worker.appData.internalAdapterId) {
      storage.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  return deleted;
}

const createWorker = async ({
  workerSettings = WORKER_SETTINGS,
  mediaType = SHARED_POOL_ID,
  workerUID,
}) => {
  if (workerUID == null) throw new Error('mediasoup: workerUID is required');

  const worker = await mediasoup.createWorker(workerSettings)

  worker.appData.internalAdapterId = uuidv4();
  worker.appData.workerSettings = workerSettings;
  worker.appData.mediaType = mediaType;
  worker.appData.workerUID = workerUID;
  _trackWorkerDeathEvent(worker);
  Logger.info('mediasoup: worker created', {
    workerId: worker.appData.internalAdapterId,
    workerPID: worker.pid,
    workerUID,
    type: mediaType || SHARED_POOL_ID,
  });

  return worker;
}

const createSharedPoolWorkers = (
  sharedWorkers,
  workerSettings,
) => {
  Logger.info(`mediasoup: spawning shared pool workers (${sharedWorkers})`);

  for (let i = 0; i < sharedWorkers ; i++) {
    const workerUID = `${SHARED_POOL_ID}-${i}`;
    createWorker({
      workerSettings,
      mediaType: SHARED_POOL_ID,
      workerUID,
    }).then(worker => {
      storeWorker(worker);
    }).catch(error => {
      Logger.error('mediasoup: worker creation failed - shared pool',
        { errorMessage: error.message, errorCode: error.code });
    });
  }
}

const createDedicatedMediaTypeWorkers = (
  dedicatedMediaTypeWorkers,
  workerSettings,
) => {
  for (const [mediaType, numberOfWorkers] of Object.entries(dedicatedMediaTypeWorkers)) {
    if (numberOfWorkers == '0') return;
    if (WORKER_STORAGE[mediaType] == null) WORKER_STORAGE[mediaType] = [];

    Logger.info(`mediasoup: spawning ${mediaType} workers (${numberOfWorkers})`);

    for (let i = 0; i < numberOfWorkers; i++) {
      const workerUID = `${mediaType}-${i}`;
      createWorker({
        workerSettings,
        mediaType,
        workerUID,
      }).then(worker => {
        storeWorker(worker);

        if (WORKER_PRIORITIES[mediaType] != null) {
          setProcessPriority(worker.pid, WORKER_PRIORITIES[mediaType]);
        }
      }).catch(error => {
        Logger.error(`mediasoup: worker creation failed - ${mediaType}`,
          { mediaType, errorMessage: error.message, errorCode: error.code });
      });
    }
  }
}

const stopWorker = (worker) => {
  worker.close();
}

module.exports = {
  WORKER_STORAGE,
  createSharedPoolWorkers,
  createDedicatedMediaTypeWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
