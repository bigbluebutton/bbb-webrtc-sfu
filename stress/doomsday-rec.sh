#!/bin/bash

DIMES="$(dirname "$(dirname "$(readlink -fm "$0")")")"
 
while true; do
  echo "doom's"
  NODE_CONFIG_DIR=${DIMES}/config/ INSTANCES=50 LIFESPAN=1000000 node record-video-kms.js 77777 & pid=$!
  sleep 15
  kill $pid
  killall -9 ffmpeg
  echo "day"
  sleep 3
done

