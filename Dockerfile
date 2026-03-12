FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# ts-node and typescript are devDependencies — omit --production so they are installed
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
