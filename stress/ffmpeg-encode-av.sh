#!/bin/bash

AV_FILE=$1
VIDEO_RTP_PORT=$2
VIDEO_RTCP_PORT=$3
AUDIO_RTP_PORT=$4
AUDIO_RTCP_PORT=$5

ffmpeg -re \
  -v info \
  -stream_loop -1 \
  -i ${AV_FILE} \
  -c:a libopus -vn -ab 30k -ac 2 -ar 48000 \
  -f rtp -ssrc 87654321 -cname ff@mpeg rtp://127.0.0.1:${AUDIO_RTP_PORT}?rtcpport=${AUDIO_RTCP_PORT} \
  -pix_fmt yuv420p -an -c:v libvpx -b:v 100k -deadline realtime -cpu-used 1 -threads 1 \
  -f rtp -ssrc 12345678 -cname ff@mpeg rtp://127.0.0.1:${VIDEO_RTP_PORT}?pkt_size=1200?rtcpport=${VIDEO_RTCP_PORT}
