FROM node:12

ADD . app

WORKDIR app

ENV NODE_ENV production

RUN cp config/default.example.yml config/production.yml \
 && npm install --unsafe-perm \
 && npm cache clear --force

EXPOSE 3008

ENTRYPOINT [ "./docker-entrypoint.sh" ]
CMD [ "npm", "start" ]
