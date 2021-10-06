FROM node:14-bullseye-slim

RUN apt-get update && apt-get -y install \
  git \
  make \
  python \
  g++ \
  ffmpeg

ADD . app

WORKDIR app

ENV NODE_ENV production

RUN cp config/default.example.yml config/production.yml \
 && npm install --unsafe-perm \
 && npm cache clear --force

EXPOSE 3008

CMD [ "npm", "start" ]
