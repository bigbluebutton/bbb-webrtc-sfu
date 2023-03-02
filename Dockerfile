FROM node:18-bullseye-slim

RUN apt-get update && apt-get -y install \
  git \
  make \
  python3-pip \
  g++ \
  ffmpeg

ADD . app

WORKDIR app

ENV NODE_ENV production
ENV NODE_CONFIG_DIR /etc/bigbluebutton/bbb-webrtc-sfu/:/app/config/

RUN cp config/default.example.yml config/default.yml \
 && npm install --unsafe-perm \
 && npm cache clear --force

EXPOSE 3008

CMD [ "npm", "start" ]
