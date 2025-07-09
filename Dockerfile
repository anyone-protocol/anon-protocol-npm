FROM node:23-alpine3.20 AS build
WORKDIR /usr/src/app
COPY --chown=node:node . .
RUN npm ci

CMD [ "npx", "anyone-client" ]
